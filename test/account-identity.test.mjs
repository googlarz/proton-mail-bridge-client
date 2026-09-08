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
import { AuditService } from "../dist/services/audit-service.js";
import { DraftStoreService } from "../dist/services/draft-store-service.js";
import { access, constants as fsConstants } from "node:fs/promises";

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

test("AuditService refuses to read a dataDir belonging to a different account and never returns its audit entries", async () => {
  await withTempDir(async (dataDir) => {
    const auditA = new AuditService(createConfig(dataDir, "accountA@example.com"));
    await auditA.record({
      timestamp: "2026-03-24T12:00:00.000Z",
      tool: "send_email",
      status: "success",
      input: { subject: "a very private phrase only account A should ever see" },
      result: { subject: "a very private phrase only account A should ever see" },
    });

    const auditB = new AuditService(createConfig(dataDir, "accountB@example.com"));
    await assert.rejects(
      () => auditB.list(),
      (error) => {
        assert.match(error.message, /accounta@example\.com/);
        assert.match(error.message, /accountb@example\.com/);
        return true;
      },
    );

    // Sanity check: the data really is there under account A, so the
    // rejection above is an actual refusal, not just an empty result.
    const entriesFromA = await auditA.list();
    assert.equal(entriesFromA.length, 1);
    assert.match(JSON.stringify(entriesFromA), /a very private phrase only account A should ever see/);
  });
});

test("AuditService.record also refuses a mismatched account (not just list)", async () => {
  await withTempDir(async (dataDir) => {
    const auditA = new AuditService(createConfig(dataDir, "accountA@example.com"));
    await auditA.record({ timestamp: "2026-03-24T12:00:00.000Z", tool: "send_email", status: "success" });

    const auditB = new AuditService(createConfig(dataDir, "accountB@example.com"));
    await assert.rejects(() =>
      auditB.record({ timestamp: "2026-03-24T12:00:01.000Z", tool: "send_email", status: "success" }),
    );
  });
});

test("ensureAccountIdentityMatches: N concurrent first-time calls for the same account all succeed and leave one consistent marker", async () => {
  await withTempDir(async (dataDir) => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => ensureAccountIdentityMatches(dataDir, "accountA@example.com")),
    );

    for (const result of results) {
      assert.equal(result.status, "fulfilled", result.reason?.message);
    }

    const marker = JSON.parse(await readFile(join(dataDir, "account.json"), "utf8"));
    assert.equal(marker.accountEmail, "accounta@example.com");
  });
});

test("ensureAccountIdentityMatches: concurrent first-time calls for DIFFERENT accounts leave exactly one winner and clean mismatch errors for the rest", async () => {
  await withTempDir(async (dataDir) => {
    const calls = [
      ...Array.from({ length: 5 }, () => ensureAccountIdentityMatches(dataDir, "accountA@example.com")),
      ...Array.from({ length: 5 }, () => ensureAccountIdentityMatches(dataDir, "accountB@example.com")),
    ];
    const results = await Promise.allSettled(calls);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly one account "wins" the race and every call for that account
    // succeeds (5 calls); every call for the other account must get a clear
    // mismatch error, never a silent wrong-success.
    assert.equal(fulfilled.length, 5, "exactly the winning account's 5 calls should succeed");
    assert.equal(rejected.length, 5, "the losing account's 5 calls must all be refused, not silently succeed");
    for (const r of rejected) {
      assert.ok(r.reason instanceof AccountIdentityMismatchError, r.reason?.message);
    }

    // The marker on disk must be valid, parseable JSON naming exactly one
    // account — not corrupted or interleaved by the concurrent writers.
    const marker = JSON.parse(await readFile(join(dataDir, "account.json"), "utf8"));
    assert.ok(["accounta@example.com", "accountb@example.com"].includes(marker.accountEmail));

    // The winning account is whichever one succeeded — confirm consistency
    // between the marker on disk and which calls were fulfilled.
    const winner = marker.accountEmail;
    for (const r of rejected) {
      const other = winner === "accounta@example.com" ? "accountb@example.com" : "accounta@example.com";
      assert.equal(r.reason.current, other);
      assert.equal(r.reason.onDisk, winner);
    }
  });
});

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

test("LocalIndexService.clear() refuses a mismatched account and does NOT delete another account's index (P1)", async () => {
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
          subject: "account A's only copy of this data",
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
          preview: "account A's only copy of this data",
          hasAttachments: false,
          attachments: [],
          labels: [],
        },
      ],
      folderStats: [{ folder: "INBOX", fetched: 1, total: 1 }],
    });

    const dbPath = join(dataDir, "mail-index.sqlite");
    assert.ok(await pathExists(dbPath), "sanity check: account A's index file exists on disk");

    // A fresh instance for account B, with clear() as the VERY FIRST call —
    // no prior getStatus()/search()/recordSnapshot() on this instance, so
    // this reproduces the bug exactly: clear() must still refuse, not
    // silently delete because "nothing else ran the identity check yet".
    const serviceB = new LocalIndexService(createConfig(dataDir, "accountB@example.com"));
    await assert.rejects(
      () => serviceB.clear(),
      (error) => {
        assert.match(error.message, /accounta@example\.com/);
        assert.match(error.message, /accountb@example\.com/);
        return true;
      },
    );

    // The whole point: account A's index must still be there.
    assert.ok(await pathExists(dbPath), "account A's index must NOT have been deleted");
    const resultsFromA = await serviceA.search({ query: "only copy" });
    assert.equal(resultsFromA.emails.length, 1, "account A's data must still be readable and intact");
  });
});

test("LocalIndexService.clear() still succeeds for the matching account", async () => {
  await withTempDir(async (dataDir) => {
    const serviceA = new LocalIndexService(createConfig(dataDir, "accountA@example.com"));
    await serviceA.recordSnapshot({
      syncedAt: "2026-03-24T12:00:00.000Z",
      folders: [],
      emails: [],
      folderStats: [],
    });

    const dbPath = join(dataDir, "mail-index.sqlite");
    assert.ok(await pathExists(dbPath), "sanity check: index file exists before clear");

    const result = await serviceA.clear();
    assert.equal(result.removed, true);
    assert.equal(await pathExists(dbPath), false, "index file should be gone after a same-account clear()");
  });
});

test("DraftStoreService.clear() refuses a mismatched account and does NOT delete another account's drafts (P1)", async () => {
  await withTempDir(async (dataDir) => {
    const draftsA = new DraftStoreService(createConfig(dataDir, "accountA@example.com"));
    await draftsA.createDraft({ subject: "account A's private draft", body: "test body" });

    const draftPath = join(dataDir, "drafts.json");
    assert.ok(await pathExists(draftPath), "sanity check: account A's draft store exists on disk");

    // Fresh instance for account B, with clear() as the very first call —
    // no prior listDrafts()/createDraft() on this instance.
    const draftsB = new DraftStoreService(createConfig(dataDir, "accountB@example.com"));
    await assert.rejects(
      () => draftsB.clear(),
      (error) => {
        assert.match(error.message, /accounta@example\.com/);
        assert.match(error.message, /accountb@example\.com/);
        return true;
      },
    );

    assert.ok(await pathExists(draftPath), "account A's draft store must NOT have been deleted");
    const draftsFromA = await draftsA.listDrafts();
    assert.equal(draftsFromA.length, 1, "account A's draft must still be intact");
    assert.equal(draftsFromA[0].subject, "account A's private draft");
  });
});

test("DraftStoreService.clear() still succeeds for the matching account", async () => {
  await withTempDir(async (dataDir) => {
    const draftsA = new DraftStoreService(createConfig(dataDir, "accountA@example.com"));
    await draftsA.createDraft({ subject: "will be cleared", body: "test body" });

    const draftPath = join(dataDir, "drafts.json");
    assert.ok(await pathExists(draftPath), "sanity check: draft store exists before clear");

    const result = await draftsA.clear();
    assert.equal(result.removed, true);
    assert.equal(await pathExists(draftPath), false, "draft store file should be gone after a same-account clear()");
  });
});
