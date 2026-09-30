import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalIndexService, shapeThreadForList, THREAD_MAX_MESSAGE_IDS, THREAD_MAX_PARTICIPANTS, THREAD_PREVIEW_MAX_CHARS } from "../dist/services/local-index-service.js";
import { SimpleIMAPService } from "../dist/services/simple-imap-service.js";
import { mailboxChangedSinceCheckpoint, trimThreadsToBudget } from "../dist/index.js";

function createConfig(dataDir) {
  return {
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "secret" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "secret" },
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
      autoSyncLimitPerFolder: 100,
      idleWatchEnabled: false,
      idleMaxSeconds: 30,
    },
  };
}

const folder = (path, extra = {}) => ({ path, name: path, delimiter: "/", listed: true, subscribed: true, flags: [], ...extra });

function makeEmail(i, extra = {}) {
  const when = new Date(Date.now() - i * 3600e3).toISOString();
  return {
    id: `INBOX::${i}`,
    folder: "INBOX",
    uid: i,
    seq: i,
    messageId: `<m${i}@x>`,
    inReplyTo: i % 8 ? `<m${i - 1}@x>` : undefined,
    subject: `Thread ${Math.floor(i / 8)}`,
    from: [{ name: `Sender ${i % 40}`, address: `s${i % 40}@example.com` }],
    to: [{ address: "owner@example.com" }],
    cc: Array.from({ length: 6 }, (_, k) => ({ address: `cc${k}-${i % 9}@example.com` })),
    bcc: [],
    replyTo: [],
    date: when,
    internalDate: when,
    isRead: false,
    isStarred: false,
    flags: [],
    preview: "Lorem ipsum ".repeat(60),
    hasAttachments: true,
    attachments: [{ id: "a", filename: "f.pdf", contentType: "application/pdf", size: 10 }],
    labels: ["Foo"],
    ...extra,
  };
}

async function withIndex(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), "freshness-test-"));
  const service = new LocalIndexService(createConfig(dataDir));
  try {
    await fn(service);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

// ---------- Defect A: freshness ----------

test("search reports stale + warning when the index has not synced recently, and not when fresh", async () => {
  await withIndex(async (service) => {
    const old = new Date(Date.now() - 3 * 3600e3).toISOString();
    await service.recordSnapshot({ syncedAt: old, folders: [folder("INBOX")], folderStats: [{ folder: "INBOX", fetched: 1, total: 1 }], emails: [makeEmail(1)] });
    const stale = await service.search({ query: "Thread" });
    assert.equal(stale.stale, true);
    assert.ok(stale.indexFreshnessMinutes >= 179);
    assert.match(stale.staleWarning, /last synced \d+ minutes ago/);

    await service.recordSnapshot({ syncedAt: new Date().toISOString(), folders: [folder("INBOX")], folderStats: [{ folder: "INBOX", fetched: 1, total: 1 }], emails: [makeEmail(1)] });
    const fresh = await service.search({ query: "Thread" });
    assert.equal(fresh.stale, undefined);
    assert.equal(fresh.staleWarning, undefined);
  });
});

test("get_index_status data lists selectable folders that were never synced", async () => {
  await withIndex(async (service) => {
    await service.recordSnapshot({
      syncedAt: new Date().toISOString(),
      folders: [folder("INBOX"), folder("Archive"), folder("Labels/x", { flags: ["\\Noselect"], noselect: true })],
      folderStats: [{ folder: "INBOX", fetched: 1, total: 1 }],
      emails: [makeEmail(1)],
    });
    const status = await service.getStatus();
    assert.deepEqual(status.unsyncedFolders, ["Archive"]);
    assert.equal(status.lastSyncAt, status.updatedAt);
  });
});

test("mailboxChangedSinceCheckpoint detects new mail in a not-yet-stale index and tolerates probe failure", async () => {
  const checkpoint = { folder: "INBOX", uidNext: 11, total: 10, highestUid: 10 };
  const index = { getSyncCheckpointMap: async () => ({ INBOX: checkpoint }) };
  const imap = (uidNext, total) => ({ getFolderStats: async () => ({ folder: "INBOX", uidNext, total, unseen: 0 }) });
  assert.equal(await mailboxChangedSinceCheckpoint(imap(11, 10), index, "INBOX"), false, "unchanged mailbox needs no refresh");
  assert.equal(await mailboxChangedSinceCheckpoint(imap(12, 11), index, "INBOX"), true, "new UID must trigger a refresh");
  assert.equal(await mailboxChangedSinceCheckpoint(imap(11, 9), index, "INBOX"), true, "expunge/count change must trigger a refresh");
  assert.equal(await mailboxChangedSinceCheckpoint(imap(11, 10), { getSyncCheckpointMap: async () => ({}) }, "INBOX"), true, "never-synced folder must refresh");
  assert.equal(
    await mailboxChangedSinceCheckpoint({ getFolderStats: async () => { throw new Error("bridge down"); } }, index, "INBOX"),
    false,
    "a failed probe must not block serving the index",
  );
});

// ---------- Defect B: sync_emails progress ----------

function stubbedImap(folders, perFolderMs = 0) {
  const service = new SimpleIMAPService(createConfig("/tmp/unused"));
  const visited = [];
  service.resolveFolders = async () => folders;
  service.getFolders = async () => folders.map((path) => folder(path));
  service.collectFolderForIndex = async (path, input) => {
    visited.push(path);
    if (perFolderMs) await new Promise((resolve) => setTimeout(resolve, perFolderMs));
    const uid = folders.indexOf(path) + 1;
    return {
      checkpoint: { folder: path, uidNext: 2, highestUid: 1, lastSyncAt: input.syncedAt, strategy: "recent", changed: true, fetched: 1, total: 1 },
      emails: [makeEmail(uid, { id: `${path}::${uid}`, folder: path, uid })],
    };
  };
  return { service, visited };
}

test("collectEmailsForIndex stops starting folders at the deadline, reports remaining, and commits per folder", async () => {
  await withIndex(async (index) => {
    const { service, visited } = stubbedImap(["A", "B", "C", "D"], 30);
    const committed = [];
    const result = await service.collectEmailsForIndex({
      full: true,
      checkpoints: {},
      deadlineAt: Date.now() + 45, // room for ~1-2 folders at 30ms each
      onFolderCollected: async (batch) => {
        committed.push(batch.folder);
        await index.recordSnapshot({ folders: [], emails: batch.emails, syncedAt: batch.checkpoint.lastSyncAt, folderStats: [batch.checkpoint] });
      },
    });
    assert.equal(result.complete, false);
    assert.ok(result.remainingFolders.length >= 1);
    assert.deepEqual([...visited, ...result.remainingFolders], ["A", "B", "C", "D"]);
    assert.deepEqual(committed, visited, "every fetched folder was committed before the call returned");
    assert.equal(result.emails.length, 0, "emails go to the callback, not the return value");
    // Progress is durable: the index already holds the committed folders' mail and checkpoints.
    const status = await index.getStatus();
    assert.equal(status.storedMessageCount, committed.length);
    assert.deepEqual(status.syncCheckpoints.map((c) => c.folder).sort(), [...committed].sort());
  });
});

test("collectEmailsForIndex always makes progress on at least one folder even with an expired deadline", async () => {
  const { service, visited } = stubbedImap(["A", "B"]);
  const result = await service.collectEmailsForIndex({ deadlineAt: Date.now() - 1000, checkpoints: {} });
  assert.deepEqual(visited, ["A"]);
  assert.deepEqual(result.remainingFolders, ["B"]);
  assert.equal(result.complete, false);
});

test("a follow-up all-folders sync visits least-recently-synced folders first (continues, does not restart)", async () => {
  const { service, visited } = stubbedImap(["A", "B", "C"]);
  const checkpoints = { A: { folder: "A", lastSyncAt: "2026-01-02T00:00:00.000Z" } };
  const result = await service.collectEmailsForIndex({ checkpoints });
  assert.deepEqual(visited, ["B", "C", "A"]);
  assert.equal(result.complete, true);
  assert.deepEqual(result.remainingFolders, []);
});

test("without a deadline collectEmailsForIndex is unchanged: returns all emails and complete:true", async () => {
  const { service } = stubbedImap(["A", "B"]);
  const result = await service.collectEmailsForIndex({ folder: "A,B" });
  assert.equal(result.emails.length, 2);
  assert.equal(result.complete, true);
});

// ---------- Defect C: response size ----------

async function seedLargeIndex(service, count = 2000) {
  const emails = Array.from({ length: count }, (_, k) => makeEmail(k + 1));
  await service.recordSnapshot({
    syncedAt: new Date().toISOString(),
    folders: [folder("INBOX", { specialUse: "\\Inbox", messages: count, unseen: count })],
    folderStats: [{ folder: "INBOX", fetched: count, total: count }],
    emails,
  });
}

test("thread list tools bound per-thread payload on a 2000-message index", async () => {
  await withIndex(async (service) => {
    await seedLargeIndex(service);
    const actionable = await service.getActionableThreads({ limit: 50 });
    const digest = await service.getInboxDigest({});
    const followUps = await service.getFollowUpCandidates({ limit: 25, pendingOn: "any" });
    const threads = await service.getThreads({ limit: 100 });

    // Before shaping these were 879K / 350K / 429K / 232K characters for this index.
    assert.ok(JSON.stringify(actionable).length < 75_000, `actionable ${JSON.stringify(actionable).length}`);
    assert.ok(JSON.stringify(digest).length < 40_000, `digest ${JSON.stringify(digest).length}`);
    assert.ok(JSON.stringify(followUps).length < 50_000, `followUps ${JSON.stringify(followUps).length}`);
    assert.ok(JSON.stringify(threads).length < 90_000, `threads ${JSON.stringify(threads).length}`);

    for (const thread of [...actionable.threads, ...digest.topThreads, ...followUps.threads, ...threads.threads]) {
      assert.equal(thread.messages, undefined, "full per-message payload must not be embedded in list rows");
      assert.ok(thread.participants.length <= THREAD_MAX_PARTICIPANTS);
      assert.ok(thread.messageIds.length <= THREAD_MAX_MESSAGE_IDS);
      if (thread.latestPreview) assert.ok(thread.latestPreview.length <= THREAD_PREVIEW_MAX_CHARS + 1);
      assert.equal(typeof thread.messageCount, "number");
      assert.ok(JSON.stringify(thread).length < 2500, "a single thread row stays small");
    }
    assert.ok(actionable.threads.length > 0);
    assert.equal(actionable.threads[0].id !== undefined && "latestEmailId" in actionable.threads[0], true, "field names stay stable");
  });
});

test("getActionableThreads/getThreads/getFollowUpCandidates paginate with offset/nextOffset without overlap", async () => {
  await withIndex(async (service) => {
    await seedLargeIndex(service, 400);
    const first = await service.getActionableThreads({ limit: 10 });
    assert.equal(first.hasMore, true);
    assert.equal(first.offset, 0);
    assert.equal(first.nextOffset, 10);
    const second = await service.getActionableThreads({ limit: 10, offset: first.nextOffset });
    assert.equal(second.offset, 10);
    const firstIds = new Set(first.threads.map((t) => t.id));
    assert.ok(second.threads.length > 0 && second.threads.every((t) => !firstIds.has(t.id)));

    const tp = await service.getThreads({ limit: 5 });
    const tp2 = await service.getThreads({ limit: 5, offset: tp.nextOffset });
    assert.ok(tp2.threads.every((t) => !tp.threads.some((x) => x.id === t.id)));

    const f1 = await service.getFollowUpCandidates({ limit: 5, pendingOn: "any" });
    const f2 = await service.getFollowUpCandidates({ limit: 5, pendingOn: "any", offset: f1.nextOffset });
    assert.ok(f2.threads.every((t) => !f1.threads.some((x) => x.id === t.id)));
  });
});

test("trimThreadsToBudget keeps at least one row and drops the tail beyond the budget", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ i, pad: "x".repeat(1000) }));
  const { threads, trimmed } = trimThreadsToBudget(rows, 3500);
  assert.equal(threads.length, 3);
  assert.equal(trimmed, 7);
  assert.equal(trimThreadsToBudget(rows, 1).threads.length, 1);
});

test("shapeThreadForList truncates oversize fields and flags them", () => {
  const shaped = shapeThreadForList({
    id: "t",
    messages: [{}],
    participants: Array.from({ length: 50 }, (_, i) => ({ address: `p${i}@x` })),
    messageIds: Array.from({ length: 50 }, (_, i) => `m${i}`),
    normalizedLabels: [],
    latestPreview: "y".repeat(1000),
  });
  assert.equal(shaped.messages, undefined);
  assert.equal(shaped.participants.length, THREAD_MAX_PARTICIPANTS);
  assert.equal(shaped.participantsTruncated, true);
  assert.equal(shaped.messageIds.length, THREAD_MAX_MESSAGE_IDS);
  assert.equal(shaped.messageIds.at(-1), "m49", "newest ids are kept");
  assert.equal(shaped.messageIdsTruncated, true);
});
