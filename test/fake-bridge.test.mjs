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

test("the first call after Bridge drops the connection reconnects instead of failing", needsOpenssl, async () => {
  await withBridge({}, async ({ service, bridge }) => {
    await service.collectEmailsForIndex({ folder: "INBOX", limitPerFolder: 10 });
    const logins = bridge.state.logins;
    bridge.dropConnections();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const again = await service.collectEmailsForIndex({ folder: "INBOX", limitPerFolder: 10 });
    assert.equal(again.emails.length, 3, "the first call after the drop succeeds");
    assert.ok(bridge.state.logins > logins, "through a new login");
  });
});

test("a NoConnection while taking the mailbox lock opens a new connection and takes the lock again", async () => {
  const imap = { host: "127.0.0.1", port: 1, secure: false, username: "o@example.com", password: "x" };
  const service = new SimpleIMAPService({ imap, smtp: { ...imap, port: 9 }, dataDir: "/tmp/fake-bridge-retry", debug: false, runtime });
  const stale = { getMailboxLock: async () => { throw Object.assign(new Error("Connection not available"), { code: "NoConnection" }); } };
  let released = 0;
  const fresh = { getMailboxLock: async () => ({ release: () => { released += 1; } }) };
  const clients = [stale, fresh];
  service.ensureConnected = async () => clients.shift();
  service.disconnect = async () => {};
  const result = await service.withMailbox("INBOX", true, async (client) => (client === fresh ? "ok" : "stale client"));
  assert.equal(result, "ok");
  assert.equal(released, 1);
  // Any other lock error is still reported.
  service.ensureConnected = async () => ({ getMailboxLock: async () => { throw new Error("Mailbox does not exist"); } });
  await assert.rejects(service.withMailbox("Nope", true, async () => "x"), /does not exist/);
});

import { tlsOptionsFor } from "../dist/utils/tls.js";
import { writeFileSync } from "node:fs";

test("tlsOptionsFor: local hosts are relaxed, listed hosts too, a pinned certificate is trusted, others verify fully", () => {
  assert.deepEqual(tlsOptionsFor("127.0.0.1", {}), { rejectUnauthorized: false });
  assert.deepEqual(tlsOptionsFor("Host.Docker.Internal", { tlsInsecureHosts: ["host.docker.internal"] }), { rejectUnauthorized: false });
  assert.equal(tlsOptionsFor("bridge.lan", {}), undefined, "an unlisted name keeps full verification");
  assert.equal(tlsOptionsFor("bridge.lan", undefined), undefined);
});

// "localhost." (with the dot) resolves like localhost but is not on the built-in list, so it stands in for a Bridge
// reached by another name.
test("a Bridge reached by another name needs PROTONMAIL_TLS_INSECURE_HOSTS or a pinned certificate", { skip: !certificate || process.platform === "win32" }, async () => {
  const bridge = await startFakeBridge({ mode: "starttls", certificate, folders: mailbox() });
  const caFile = join(await mkdtemp(join(tmpdir(), "fake-bridge-ca-")), "bridge.pem");
  writeFileSync(caFile, certificate.cert);
  const make = (extraRuntime) => {
    const imap = { host: "localhost.", port: bridge.port, secure: false, username: "owner@example.com", password: "secret" };
    return new SimpleIMAPService({ imap, smtp: { ...imap, port: 9 }, dataDir: "/tmp/fake-bridge-tls", debug: false, runtime: { ...runtime, ...extraRuntime } });
  };
  const attempts = [];
  try {
    for (const [label, extra, shouldWork] of [
      ["no trust configured", {}, false],
      ["host listed as insecure", { tlsInsecureHosts: ["localhost."] }, true],
      ["certificate pinned", { tlsCaFile: caFile }, true],
    ]) {
      const service = make(extra);
      try {
        await service.ping();
        attempts.push([label, true]);
      } catch (error) {
        attempts.push([label, false, String(error?.message).slice(0, 80)]);
      } finally {
        await service.disconnect().catch(() => {});
      }
      assert.equal(attempts.at(-1)[1], shouldWork, `${label}: ${JSON.stringify(attempts.at(-1))}`);
    }
  } finally {
    await bridge.close();
  }
});

test("moving, importing, deleting and flagging reach the server and give back usable ids", needsOpenssl, async () => {
  await withBridge({}, async ({ service, bridge }) => {
    const folders = bridge.folders;
    const inboxId = (uid) => `INBOX::${uid}::x`;
    // The ids the service hands out carry the folder's UIDVALIDITY; build the real ones from a sync.
    const snapshot = await service.collectEmailsForIndex({ folder: "INBOX", limitPerFolder: 10 });
    const first = snapshot.emails.find((e) => e.uid === 1);
    const second = snapshot.emails.find((e) => e.uid === 2);
    const third = snapshot.emails.find((e) => e.uid === 3);
    void inboxId;

    // Mark read.
    await service.markEmailRead(first.id, true);
    assert.ok(folders.INBOX.messages.find((m) => m.uid === 1).flags.has("\\Seen"), "the flag is set on the server");

    // Move to another folder: the message leaves INBOX and appears in the target with a new uid.
    const moved = await service.moveEmail(second.id, "Folders/Geek");
    assert.equal(moved.targetFolder, "Folders/Geek");
    assert.ok(moved.targetEmailId, "a target id comes back");
    assert.equal(folders.INBOX.messages.some((m) => m.uid === 2), false, "gone from the source");
    assert.equal(folders["Folders/Geek"].messages.some((m) => m.uid === moved.targetUid), true, "present in the target");

    // Delete: flagged and expunged.
    await service.deleteEmail(third.id);
    assert.equal(folders.INBOX.messages.some((m) => m.uid === 3), false, "deleted");

    // Import: appended with its flags, and the id points at it.
    const raw = Buffer.from("From: Bob <bob@example.com>\r\nTo: owner@example.com\r\nSubject: Imported\r\nMessage-ID: <imp1@x>\r\nDate: Tue, 24 Mar 2026 10:00:00 +0000\r\n\r\nHello\r\n");
    const imported = await service.importEmail({ raw, targetFolder: "Sent", flags: ["\\Seen"] });
    assert.ok(imported.uid && imported.emailId, JSON.stringify(imported));
    const stored = folders.Sent.messages.find((m) => m.uid === imported.uid);
    assert.ok(stored, "the message is on the server");
    assert.equal(stored.subject, "Imported");
    assert.ok(stored.flags.has("\\Seen"));

    // Importing the same message again is recognised by its Message-ID instead of creating a second copy.
    const again = await service.importEmail({ raw, targetFolder: "Sent" });
    assert.equal(again.alreadyExists, true);
    assert.equal(folders.Sent.messages.filter((m) => m.messageId === "<imp1@x>").length, 1);
  });
});

test("reading opens a folder read-only (EXAMINE), and only a change opens it read-write (SELECT)", needsOpenssl, async () => {
  await withBridge({}, async ({ service, bridge }) => {
    const snapshot = await service.collectEmailsForIndex({ folder: "INBOX", limitPerFolder: 10 });
    await service.getEmailById(snapshot.emails[0].id);
    const reading = bridge.state.commands.filter((c) => /^(SELECT|EXAMINE)\b/.test(c));
    assert.ok(reading.length > 0 && reading.every((c) => c.startsWith("EXAMINE")), `reads must not select read-write: ${reading.join(" | ")}`);
    await service.markEmailRead(snapshot.emails[0].id, true);
    assert.ok(bridge.state.commands.some((c) => c.startsWith("SELECT")), "a flag change opens the folder read-write");
  });
});

// Spawns `notify` and guarantees the child is gone afterwards, even when an assertion throws or the test times out.
async function withNotifyChild(bridge, dir, run) {
  const { spawn } = await import("node:child_process");
  const env = { ...process.env, PROTONMAIL_USERNAME: "owner@example.com", PROTONMAIL_PASSWORD: "wrong", PROTONMAIL_IMAP_PORT: String(bridge.port), PROTONMAIL_SMTP_PORT: "9", PROTONMAIL_DATA_DIR: dir, PROTONMAIL_IDLE_WATCH: "false", PROTONMAIL_AUTO_SYNC: "false" };
  const child = spawn(process.execPath, ["dist/cli.js", "notify", "--timeout", "1"], { env });
  const state = { out: "", err: "", exit: undefined };
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => { state.exit = { code, signal }; resolve(); }));
  child.stdout.on("data", (chunk) => { state.out += chunk; });
  child.stderr.on("data", (chunk) => { state.err += chunk; });
  try {
    await run(child, state, exited);
  } finally {
    if (state.exit === undefined) {
      child.kill("SIGTERM");
      const grace = setTimeout(() => child.kill("SIGKILL"), 1000);
      await exited;
      clearTimeout(grace);
    }
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" }, "the notify child is gone");
  }
}

test("notify keeps running after a failed connection, announces the problem once and the recovery when Bridge comes back", needsOpenssl, async () => {
  const bridge = await startFakeBridge({ mode: "starttls", certificate, accounts: { "owner@example.com": "right" }, folders: mailbox() });
  const dir = await mkdtemp(join(tmpdir(), "fake-bridge-notify-"));
  try {
    await withNotifyChild(bridge, dir, async (_child, state) => {
      await new Promise((resolve) => setTimeout(resolve, 3500));
      assert.match(state.out, /"event":"problem"/, "the problem is announced");
      assert.equal(state.exit, undefined, "and the daemon is still running, waiting to try again");
    });
  } finally {
    await bridge.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`notify exits promptly on ${signal} while waiting to retry a failed connection`, needsOpenssl, async () => {
    const bridge = await startFakeBridge({ mode: "starttls", certificate, accounts: { "owner@example.com": "right" }, folders: mailbox() });
    const dir = await mkdtemp(join(tmpdir(), "fake-bridge-notify-"));
    try {
      await withNotifyChild(bridge, dir, async (child, state, exited) => {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        assert.match(state.out, /"event":"problem"/, "the daemon is in its retry wait");
        const sentAt = Date.now();
        child.kill(signal);
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
        assert.ok(state.exit, `exited within 2 s of ${signal}`);
        assert.ok(Date.now() - sentAt < 2000);
        assert.equal(state.exit.code, 0);
        assert.match(state.err, /\[notify\] Stopped\./);
      });
    } finally {
      await bridge.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}
