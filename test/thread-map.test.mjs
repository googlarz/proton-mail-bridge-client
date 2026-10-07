import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalIndexService } from "../dist/services/local-index-service.js";

// get_threads with a filter used to read and group the whole index whenever a matching message belongs to a
// reference chain. It now takes the thread of every message from a map kept until the index changes. The
// threads it returns must be the ones a full read gives, and the map must follow every write.

function config(dataDir) {
  return {
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "x" },
    dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false,
      autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 100, idleWatchEnabled: false, idleMaxSeconds: 30 },
  };
}

const folders = ["INBOX", "Archive"].map((path) => ({ path, name: path, delimiter: "/", specialUse: path === "INBOX" ? "\\Inbox" : "\\Archive", listed: true, subscribed: true, flags: [], messages: 9, unseen: 0 }));
let seq = 0;
function mail(folder, uid, subject, messageId, inReplyTo, from = "ann@example.com") {
  seq += 1;
  const date = `2026-03-${String(10 + seq).padStart(2, "0")}T09:00:00.000Z`;
  return { id: `${folder}::${uid}`, folder, uid, seq: uid, messageId: `<${messageId}@example.com>`, ...(inReplyTo ? { inReplyTo: `<${inReplyTo}@example.com>`, references: [`<${inReplyTo}@example.com>`] } : {}),
    subject, from: [{ name: from, address: from }], to: [{ address: "owner@example.com" }], cc: [], bcc: [], replyTo: [],
    date, internalDate: date, isRead: false, isStarred: false, flags: [], preview: "", hasAttachments: false, attachments: [], labels: [] };
}
const snapshot = (emails) => ({ syncedAt: "2026-03-25T10:00:00.000Z", folders, folderStats: [{ folder: "INBOX", fetched: emails.length, total: emails.length, strategy: "recent" }], emails });

async function withIndex(emails, fn) {
  const dir = await mkdtemp(join(tmpdir(), "thread-map-"));
  const service = new LocalIndexService(config(dir));
  try {
    await service.recordSnapshot(snapshot(emails));
    await fn(service);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

const base = () => [
  mail("INBOX", 1, "Plan for May", "a1"),
  mail("INBOX", 2, "Re: Plan for May", "a2", "a1", "bob@example.com"),
  mail("INBOX", 3, "Lunch", "c1", undefined, "carl@example.com"),
  mail("Archive", 1, "Budget", "d1", undefined, "dora@example.com"),
  mail("Archive", 2, "Re: Budget", "d2", "d1", "eve@example.com"),
];

test("a reply that matches the query brings in its whole thread", async () => {
  await withIndex(base(), async (service) => {
    const result = await service.getThreads({ query: "plan" });
    assert.equal(result.total, 1);
    assert.equal(result.threads[0].messageCount, 2);
    assert.deepEqual(result.threads[0].messageIds.sort(), ["INBOX::1", "INBOX::2"]);
  });
});

test("a folder filter returns only the threads that have a message in that folder", async () => {
  await withIndex(base(), async (service) => {
    const archive = await service.getThreads({ folder: "Archive" });
    assert.equal(archive.total, 1);
    assert.deepEqual(archive.threads[0].messageIds.sort(), ["Archive::1", "Archive::2"]);
    const inbox = await service.getThreads({ folder: "INBOX" });
    assert.equal(inbox.total, 2);
  });
});

test("every thread a filtered call returns can be opened by its id with the same messages", async () => {
  await withIndex(base(), async (service) => {
    for (const filter of [{ query: "plan" }, { query: "budget" }, { folder: "Archive" }, { folder: "INBOX" }]) {
      const { threads } = await service.getThreads(filter);
      assert.ok(threads.length > 0);
      for (const thread of threads) {
        const detail = await service.getThreadById(thread.id);
        assert.equal(detail.messageCount, thread.messageCount, JSON.stringify(filter));
      }
    }
  });
});

test("the thread map follows writes: a new reply is in the thread on the next call", async () => {
  await withIndex(base(), async (service) => {
    assert.equal((await service.getThreads({ query: "lunch" })).threads[0].messageCount, 1);
    await service.recordSnapshot(snapshot([mail("INBOX", 4, "Re: Lunch", "c2", "c1", "dan@example.com")]));
    const after = await service.getThreads({ query: "lunch" });
    assert.equal(after.total, 1);
    assert.equal(after.threads[0].messageCount, 2);
  });
});

test("a message that arrives before its parent joins the parent's thread once the parent arrives", async () => {
  await withIndex([mail("INBOX", 1, "Re: Later", "x2", "x1", "bob@example.com")], async (service) => {
    assert.equal((await service.getThreads({ query: "later" })).threads[0].messageCount, 1);
    await service.recordSnapshot(snapshot([mail("INBOX", 2, "Later", "x1", undefined, "ann@example.com")]));
    const after = await service.getThreads({ query: "later" });
    assert.equal(after.total, 1);
    assert.equal(after.threads[0].messageCount, 2);
  });
});

test("a write made through another connection to the same index (another process) is seen too", async () => {
  const dir = await mkdtemp(join(tmpdir(), "thread-map-two-"));
  const first = new LocalIndexService(config(dir));
  const second = new LocalIndexService(config(dir));
  try {
    await first.recordSnapshot(snapshot([mail("INBOX", 1, "Re: Shared", "s2", "s1", "bob@example.com")]));
    assert.equal((await first.getThreads({ query: "shared" })).threads[0].messageCount, 1);
    await second.recordSnapshot(snapshot([mail("INBOX", 2, "Shared", "s1", undefined, "ann@example.com")]));
    const after = await first.getThreads({ query: "shared" });
    assert.equal(after.total, 1);
    assert.equal(after.threads[0].messageCount, 2);
  } finally {
    await first.close();
    await second.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
