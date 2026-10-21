import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SimpleIMAPService, isLikelyAuthenticationError } from "../dist/services/simple-imap-service.js";
import { LocalIndexService } from "../dist/services/local-index-service.js";
import { createMessage, makeCertificate, startFakeBridge } from "./helpers/fake-bridge.mjs";

const certificate = makeCertificate();
const needsOpenssl = certificate ? {} : { skip: "openssl is not available to make a test certificate" };

const runtime = { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX,Sent", autoSyncFull: false, autoSyncLimitPerFolder: 50, idleWatchEnabled: false, idleMaxSeconds: 30, maxInlineBytes: 40960, opDelayMs: 0 };

function mailbox() {
  return {
    INBOX: { uidValidity: 7, messages: [createMessage(1), createMessage(2, { flags: ["\\Seen"] }), createMessage(3)] },
    Sent: { uidValidity: 8, specialUse: "\\Sent", messages: [createMessage(1, { from: "owner@example.com", to: "alice@example.com", flags: ["\\Seen"] })] },
    "Folders/Geek": { uidValidity: 9, messages: [createMessage(1), createMessage(2)] },
  };
}

function connect(bridge, { secure = false, user = "owner@example.com", password = "secret", dataDir = "/tmp/fake-bridge-svc" } = {}) {
  const imap = { host: "127.0.0.1", port: bridge.port, secure, username: user, password };
  const smtp = { host: "127.0.0.1", port: 9, secure: false, username: user, password };
  return new SimpleIMAPService({ imap, smtp, dataDir, debug: false, runtime });
}

async function withBridge(options, fn) {
  const bridge = await startFakeBridge({ folders: mailbox(), mode: "starttls", certificate, ...options });
  const service = connect(bridge, { secure: options.mode === "implicit", ...(options.client ?? {}) });
  try {
    await fn({ bridge, service });
  } finally {
    await service.disconnect().catch(() => {});
    await bridge.close();
  }
}

for (const [name, mode, extra] of [
  ["implicit TLS", "implicit", needsOpenssl],
  ["STARTTLS", "starttls", needsOpenssl],
]) {
  test(`the client logs in and lists folders against Bridge in ${name} mode`, extra, async () => {
    await withBridge({ mode }, async ({ service, bridge }) => {
      await service.ping();
      const folders = await service.getFolders(true);
      assert.deepEqual(folders.map((f) => f.path).sort(), ["Folders/Geek", "INBOX", "Sent"]);
      assert.equal(bridge.state.logins, 1);
    });
  });
}

test("a wrong Bridge password is recognised as an authentication failure", needsOpenssl, async () => {
  await withBridge({ client: { password: "wrong" } }, async ({ service }) => {
    await assert.rejects(service.ping(), (error) => isLikelyAuthenticationError(error));
  });
});

test("an explicit folder list skips a folder this account lacks and indexes the rest", needsOpenssl, async () => {
  await withBridge({}, async ({ service }) => {
    const snapshot = await service.collectEmailsForIndex({ folder: "INBOX,Folders/Gone,Sent", limitPerFolder: 50 });
    assert.deepEqual(snapshot.skippedFolders, ["Folders/Gone"]);
    assert.deepEqual(snapshot.folderStats.map((s) => s.folder).sort(), ["INBOX", "Sent"]);
    assert.equal(snapshot.emails.length, 4);
    assert.equal(snapshot.emails.find((e) => e.folder === "INBOX" && e.uid === 2).isRead, true);
  });
});

test("flags changed and mail removed on the server reach the index through the flag sweep", needsOpenssl, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "fake-bridge-index-"));
  const bridge = await startFakeBridge({ mode: "starttls", certificate, folders: mailbox() });
  const imap = { host: "127.0.0.1", port: bridge.port, secure: false, username: "owner@example.com", password: "secret" };
  const smtp = { ...imap, port: 9 };
  const config = { imap, smtp, dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5, runtime };
  const index = new LocalIndexService(config);
  const sync = async () => {
    const service = new SimpleIMAPService(config); // a new instance: the sweep is throttled per instance
    try {
      const snapshot = await service.collectEmailsForIndex({ folder: "INBOX", limitPerFolder: 50, checkpoints: await index.getSyncCheckpointMap() });
      await index.recordSnapshot({ folders: snapshot.folders, emails: snapshot.emails, syncedAt: snapshot.syncedAt, folderStats: snapshot.folderStats });
    } finally {
      await service.disconnect().catch(() => {});
    }
  };
  try {
    await sync();
    assert.equal((await index.search({ folder: "INBOX", isRead: false, limit: 10 })).emails.length, 2);
    // Elsewhere: uid 1 is read, uid 3 deleted.
    const inbox = bridge.folders.INBOX.messages;
    inbox.find((m) => m.uid === 1).flags.add("\\Seen");
    bridge.folders.INBOX.messages = inbox.filter((m) => m.uid !== 3);
    await sync();
    const all = (await index.search({ folder: "INBOX", limit: 10 })).emails;
    assert.deepEqual(all.map((m) => m.uid).sort(), [1, 2]);
    assert.ok(all.every((m) => m.isRead), "the unread count follows the server");
  } finally {
    await index.close();
    await bridge.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("two accounts on two Bridge logins stay apart", needsOpenssl, async () => {
  const bridge = await startFakeBridge({ mode: "starttls", certificate, accounts: { "a@example.com": "pa", "b@example.com": "pb" }, folders: mailbox() });
  const a = connect(bridge, { user: "a@example.com", password: "pa" });
  const b = connect(bridge, { user: "b@example.com", password: "wrong" });
  try {
    await a.ping();
    await assert.rejects(b.ping(), (error) => isLikelyAuthenticationError(error));
  } finally {
    await a.disconnect().catch(() => {});
    await b.disconnect().catch(() => {});
    await bridge.close();
  }
});

test("PROTONMAIL_SHORTEN_LINKS shortens long tracking links in a message read from a server, HTML-only or plain text", needsOpenssl, async () => {
  const tracking = `https://click.example.com/f/a/${"x".repeat(200)}`;
  const unsubscribe = `https://click.example.com/unsubscribe/${"y".repeat(200)}`;
  const folders = {
    INBOX: {
      uidValidity: 1,
      messages: [
        createMessage(1, { html: `<p>Hello <a href="${tracking}">Read more</a> or <a href="${unsubscribe}">unsubscribe</a></p>` }),
        createMessage(2, { body: `Plain text mail with ${tracking} and leave ${unsubscribe}\r\n` }),
      ],
    },
  };
  for (const shortenLinks of [false, true]) {
    const bridge = await startFakeBridge({ mode: "starttls", certificate, folders });
    const imap = { host: "127.0.0.1", port: bridge.port, secure: false, username: "owner@example.com", password: "secret" };
    const service = new SimpleIMAPService({ imap, smtp: { ...imap, port: 9 }, dataDir: "/tmp/fake-bridge-shorten", debug: false, runtime: { ...runtime, shortenLinks } });
    try {
      const snapshot = await service.collectEmailsForIndex({ folder: "INBOX", limitPerFolder: 10 });
      for (const email of snapshot.emails) {
        const detail = await service.getEmailById(email.id);
        const body = detail.body ?? detail.text ?? "";
        if (shortenLinks) {
          assert.ok(!body.includes(tracking), `uid ${email.uid}: the tracking link must be shortened`);
          assert.match(body, /https:\/\/click\.example\.com\/…/);
          assert.ok(body.includes(unsubscribe), `uid ${email.uid}: the unsubscribe link must stay whole`);
        } else {
          assert.ok(body.includes(tracking), `uid ${email.uid}: off by default, nothing changes`);
        }
      }
    } finally {
      await service.disconnect().catch(() => {});
      await bridge.close();
    }
  }
});
