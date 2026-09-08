import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureAccountIdentityMatches,
  AccountIdentityMismatchError,
} from "../dist/utils/account-identity.js";
import { LocalIndexService } from "../dist/services/local-index-service.js";
import { DeliveryQueueService } from "../dist/services/delivery-queue-service.js";

function createConfig(dataDir, username) {
  return {
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username, password: "secret" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username, password: "secret" },
    dataDir,
    debug: false,
    cacheEnabled: true,
    analyticsEnabled: true,
    autoSync: false,
    syncInterval: 5,
    runtime: {
      readOnly: false,
      allowSend: true,
      allowRemoteDraftSync: true,
      allowedActions: [],
      startupSync: false,
      autoSyncFolder: "INBOX",
      autoSyncFull: false,
      autoSyncLimitPerFolder: 25,
      idleWatchEnabled: false,
      idleMaxSeconds: 30,
      confirmDestructive: false,
      allowEmptyFolder: false,
      restrictOutboundToSelf: false,
      allowFileDownloadDir: undefined,
      maxInlineBytes: 40960,
      opDelayMs: 0,
    },
  };
}

function fakeSmtp() {
  return {
    sent: [],
    async sendEmail(payload) {
      this.sent.push(payload);
      return { messageId: "<sent@example.com>", accepted: payload.to, rejected: [] };
    },
  };
}

async function withTempDir(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-account-identity-test-"));
  try {
    await fn(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("ensureAccountIdentityMatches writes a marker on first use of a fresh dataDir", async () => {
  await withTempDir(async (dataDir) => {
    await ensureAccountIdentityMatches(dataDir, "accountA@example.com");
    const marker = JSON.parse(await readFile(join(dataDir, "account.json"), "utf8"));
    assert.equal(marker.accountEmail, "accounta@example.com");
  });
});

test("ensureAccountIdentityMatches succeeds when reopened with the same account", async () => {
  await withTempDir(async (dataDir) => {
    await ensureAccountIdentityMatches(dataDir, "accountA@example.com");
    // Reopen with the same account (different casing, since the marker
    // normalizes to lowercase) — must not throw.
    await assert.doesNotReject(() => ensureAccountIdentityMatches(dataDir, "AccountA@Example.com"));
  });
});

test("ensureAccountIdentityMatches throws a clear error naming both accounts on mismatch", async () => {
  await withTempDir(async (dataDir) => {
    await ensureAccountIdentityMatches(dataDir, "accountA@example.com");
    await assert.rejects(
      () => ensureAccountIdentityMatches(dataDir, "accountB@example.com"),
      (error) => {
        assert.ok(error instanceof AccountIdentityMismatchError);
        assert.match(error.message, /accounta@example\.com/);
        assert.match(error.message, /accountb@example\.com/);
        return true;
      },
    );
  });
});

test("an existing dataDir with no marker (pre-fix upgrade) succeeds and writes a marker for the current account", async () => {
  await withTempDir(async (dataDir) => {
    // Simulate a pre-fix dataDir: data present, but no account.json.
    await writeFile(join(dataDir, "delivery-queue.json"), JSON.stringify({ version: 1, items: {} }));

    await assert.doesNotReject(() => ensureAccountIdentityMatches(dataDir, "upgradedAccount@example.com"));
    const marker = JSON.parse(await readFile(join(dataDir, "account.json"), "utf8"));
    assert.equal(marker.accountEmail, "upgradedaccount@example.com");
  });
});

test("LocalIndexService refuses to open a dataDir belonging to a different account and never leaks its data", async () => {
  await withTempDir(async (dataDir) => {
    const serviceA = new LocalIndexService(createConfig(dataDir, "accountA@example.com"));
    await serviceA.recordSnapshot({
      syncedAt: "2026-03-24T12:00:00.000Z",
      folders: [
        {
          path: "INBOX",
          name: "INBOX",
          delimiter: "/",
          specialUse: "\\Inbox",
          listed: true,
          subscribed: true,
          flags: [],
          messages: 1,
          unseen: 1,
        },
      ],
      emails: [
        {
          id: "INBOX::1",
          uid: 1,
          seq: 1,
          folder: "INBOX",
          messageId: "<m1@example.com>",
          subject: "a very private phrase only account A should ever see",
          from: [{ address: "someone@example.com" }],
          to: [{ address: "accountA@example.com" }],
          cc: [],
          bcc: [],
          replyTo: [],
          date: "2026-03-24T12:00:00.000Z",
          internalDate: "2026-03-24T12:00:00.000Z",
          isRead: false,
          isStarred: false,
          flags: [],
          preview: "a very private phrase only account A should ever see",
          hasAttachments: false,
          attachments: [],
          labels: [],
        },
      ],
      folderStats: [{ folder: "INBOX", fetched: 1, total: 1 }],
    });

    const serviceB = new LocalIndexService(createConfig(dataDir, "accountB@example.com"));
    await assert.rejects(
      () => serviceB.search({ query: "private phrase" }),
      (error) => {
        assert.match(error.message, /accounta@example\.com/);
        assert.match(error.message, /accountb@example\.com/);
        return true;
      },
    );

    // The mismatch must not have silently proceeded: account B's search
    // never got the chance to return account A's data.
    const resultsFromA = await serviceA.search({ query: "private phrase" });
    assert.equal(resultsFromA.emails.length, 1, "sanity check: the data really is there under account A");
  });
});

test("DeliveryQueueService refuses to open a dataDir belonging to a different account and never sends its pending items", async () => {
  await withTempDir(async (dataDir) => {
    const smtpA = fakeSmtp();
    const queueA = new DeliveryQueueService(createConfig(dataDir, "accountA@example.com"), smtpA);
    const record = await queueA.enqueue(
      { to: ["victim@example.com"], subject: "Hello", body: "test body" },
      new Date(Date.now() - 1_000).toISOString(),
      "undo_send",
    );
    assert.equal(record.status, "pending");

    const smtpB = fakeSmtp();
    const queueB = new DeliveryQueueService(createConfig(dataDir, "accountB@example.com"), smtpB);
    await assert.rejects(
      () => queueB.list(),
      (error) => {
        assert.match(error.message, /accounta@example\.com/);
        assert.match(error.message, /accountb@example\.com/);
        return true;
      },
    );

    // Confirm account B's SMTP transport never handled account A's queued item.
    assert.equal(smtpB.sent.length, 0);
  });
});
