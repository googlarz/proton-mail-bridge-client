import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalIndexService } from "../dist/services/local-index-service.js";
import { SimpleIMAPService } from "../dist/services/simple-imap-service.js";

const smtp = { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "x" };
const imap = { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "x" };
const runtime = { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 100, idleWatchEnabled: false, idleMaxSeconds: 30, maxInlineBytes: 40960, opDelayMs: 0 };

const mail = (uid, flags = []) => ({
  id: `INBOX::${uid}`, folder: "INBOX", uid, seq: uid, messageId: `<${uid}@x>`, subject: `Mail ${uid}`,
  from: [{ address: "a@example.com" }], to: [{ address: "owner@example.com" }], cc: [], bcc: [], replyTo: [],
  date: "2026-03-24T11:00:00.000Z", internalDate: "2026-03-24T11:00:00.000Z",
  isRead: flags.includes("\\Seen"), isStarred: flags.includes("\\Flagged"), flags, preview: "p", hasAttachments: false, attachments: [], labels: [],
});

const sweepStat = (sweep) => {
  const stat = { folder: "INBOX", fetched: 0, total: 3 };
  Object.defineProperty(stat, "flagSweep", { value: sweep, enumerable: false });
  return stat;
};

test("a flag sweep fixes read state of old mail and drops mail the server no longer has", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "flag-sweep-"));
  const index = new LocalIndexService({ smtp, imap, dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5, runtime });
  try {
    await index.recordSnapshot({
      syncedAt: "2026-03-24T12:00:00.000Z", folders: [],
      folderStats: [{ folder: "INBOX", fetched: 3, total: 3 }],
      emails: [mail(1), mail(2), mail(3, ["\\Seen"])],
    });
    assert.equal((await index.search({ isRead: false, limit: 10 })).emails.length, 2);
    // On the server: 1 was read meanwhile, 2 was deleted, 3 is now starred and unread.
    await index.recordSnapshot({
      syncedAt: "2026-03-24T12:10:00.000Z", folders: [], emails: [],
      folderStats: [sweepStat({ present: [1, 3], unseen: [3], flagged: [3] })],
    });
    const all = (await index.search({ limit: 10 })).emails.sort((a, b) => a.uid - b.uid);
    assert.deepEqual(all.map((m) => [m.uid, m.isRead, m.isStarred]), [[1, true, false], [3, false, true]]);
    assert.deepEqual(all[1].flags, ["\\Flagged"]);
  } finally {
    await index.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("the IMAP sweep collects present, unseen and flagged UIDs, at most every few minutes", async () => {
  const svc = new SimpleIMAPService({ smtp, imap, dataDir: "/tmp/flag-sweep-imap", debug: false, runtime });
  let fetches = 0;
  const client = {
    async *fetch() {
      fetches += 1;
      yield { uid: 1, flags: new Set(["\\Seen"]) };
      yield { uid: 2, flags: new Set(["\\Flagged"]) };
    },
  };
  const first = await svc.maybeSweepFlags(client, "INBOX", 2);
  assert.deepEqual(first, { present: [1, 2], unseen: [2], flagged: [2] });
  assert.equal(await svc.maybeSweepFlags(client, "INBOX", 2), undefined, "throttled");
  assert.equal(fetches, 1);
  assert.equal(await svc.maybeSweepFlags(client, "Other", 0), undefined, "an empty folder is not swept");
  assert.equal(await svc.maybeSweepFlags(client, "Huge", 1_000_000), undefined, "a very large folder is left to full syncs");
});

test("index status shows how much of each synced folder is indexed", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "history-progress-"));
  const index = new LocalIndexService({ smtp, imap, dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5, runtime });
  try {
    await index.recordSnapshot({
      syncedAt: "2026-03-24T12:00:00.000Z", folders: [],
      folderStats: [{ folder: "INBOX", fetched: 2, total: 8, backfilledToUid: 5 }],
      emails: [mail(7), mail(8)],
    });
    const status = await index.getStatus();
    assert.deepEqual(status.history, [{ folder: "INBOX", indexedMessages: 2, serverMessages: 8, percent: 25, historyComplete: false }]);
    await index.recordSnapshot({ syncedAt: "2026-03-24T12:05:00.000Z", folders: [], emails: [], folderStats: [{ folder: "Empty", strategy: "empty", fetched: 0, total: 0, folderObservedEmpty: true }] });
    const empty = (await index.getStatus()).history.find((entry) => entry.folder === "Empty");
    assert.equal(empty.historyComplete, true, "a folder with no messages is complete");
  } finally {
    await index.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
