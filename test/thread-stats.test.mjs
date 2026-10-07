import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalIndexService } from "../dist/services/local-index-service.js";

// Follow-ups, the digest's stale section, thread lookups, meeting prep and document search take the thread of
// every message from the whole index (kept until the index changes) and rank threads from compact per-thread
// stats, building only the page that is returned. A thread whose root is old but which has a recent reply is
// not stale, and every write must show up on the next call.

function config(dataDir) {
  return {
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "x" },
    dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false,
      autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 100, idleWatchEnabled: false, idleMaxSeconds: 30 },
  };
}

const DAY = 24 * 60 * 60 * 1000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const folders = [{ path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "\\Inbox", listed: true, subscribed: true, flags: [], messages: 9, unseen: 0 }];
let uid = 0;
function mail(subject, messageId, inReplyTo, from, when, extra = {}) {
  uid += 1;
  return { id: `INBOX::${uid}`, folder: "INBOX", uid, seq: uid, messageId: `<${messageId}@example.com>`,
    ...(inReplyTo ? { inReplyTo: `<${inReplyTo}@example.com>`, references: [`<${inReplyTo}@example.com>`] } : {}),
    subject, from: [{ name: from, address: from }], to: [{ address: from === "owner@example.com" ? "ann@example.com" : "owner@example.com" }],
    cc: [], bcc: [], replyTo: [], date: when, internalDate: when, isRead: true, isStarred: false, flags: [], preview: "",
    hasAttachments: false, attachments: [], labels: [], ...extra };
}
const snapshot = (emails) => ({ syncedAt: new Date().toISOString(), folders, folderStats: [{ folder: "INBOX", fetched: emails.length, total: emails.length, strategy: "recent" }], emails });

const dataset = () => [
  // A: old root, recent reply from someone else: the thread is not stale.
  mail("Contract", "a1", undefined, "ann@example.com", ago(10 * DAY)),
  mail("Re: Contract", "a2", "a1", "bob@example.com", ago(2 * 60 * 60 * 1000)),
  // B: old root, nobody answered: waiting on the owner.
  mail("Invoice question", "b1", undefined, "ann@example.com", ago(9 * DAY)),
  // C: the owner answered long ago: waiting on them.
  mail("Offer", "c1", undefined, "ann@example.com", ago(12 * DAY)),
  mail("Re: Offer", "c2", "c1", "owner@example.com", ago(11 * DAY)),
];

async function withIndex(emails, fn) {
  const dir = await mkdtemp(join(tmpdir(), "thread-stats-"));
  const service = new LocalIndexService(config(dir));
  try {
    await service.recordSnapshot(snapshot(emails));
    await fn(service);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
const subjects = (result) => result.threads.map((t) => t.subject).sort();

test("follow-ups: a thread with a recent reply is not stale, an unanswered old one is", async () => {
  uid = 0;
  await withIndex(dataset(), async (service) => {
    const you = await service.getFollowUpCandidates({ pendingOn: "you", minAgeHours: 24 });
    assert.deepEqual(subjects(you), ["Invoice question"]);
    assert.equal(you.total, 1);
    const them = await service.getFollowUpCandidates({ pendingOn: "them", minAgeHours: 24 });
    assert.deepEqual(subjects(them), ["Offer"]);
    assert.equal(them.threads[0].suggestedAction, "follow_up");
    assert.equal(you.threads[0].suggestedAction, "reply");
  });
});

test("follow-ups: paging walks the ranked list and a new reply removes a thread on the next call", async () => {
  uid = 0;
  await withIndex(dataset(), async (service) => {
    const any = await service.getFollowUpCandidates({ pendingOn: "any", minAgeHours: 24, limit: 1 });
    assert.equal(any.total, 2);
    assert.equal(any.hasMore, true);
    const second = await service.getFollowUpCandidates({ pendingOn: "any", minAgeHours: 24, limit: 1, offset: 1 });
    assert.notEqual(second.threads[0].id, any.threads[0].id);
    await service.recordSnapshot(snapshot([mail("Re: Invoice question", "b2", "b1", "owner@example.com", ago(60 * 1000))]));
    const after = await service.getFollowUpCandidates({ pendingOn: "any", minAgeHours: 24 });
    assert.deepEqual(subjects(after), ["Offer"]);
  });
});

test("digest: the stale section counts and lists only threads waiting on the owner", async () => {
  uid = 0;
  await withIndex(dataset(), async (service) => {
    const digest = await service.getInboxDigest({ limit: 10, minAgeHours: 24 });
    assert.equal(digest.counts.staleAwaitingYou, 1);
    assert.deepEqual(digest.staleAwaitingYou.map((t) => t.subject), ["Invoice question"]);
  });
});

test("get_thread_by_id and a thread search by id agree with the thread list", async () => {
  uid = 0;
  await withIndex(dataset(), async (service) => {
    const { threads } = await service.getThreads({ limit: 50 });
    for (const thread of threads) {
      const detail = await service.getThreadById(thread.id);
      assert.equal(detail.messageCount, thread.messageCount);
      const found = await service.search({ threadId: thread.id, limit: 50 });
      assert.equal(found.total, thread.messageCount);
    }
    await assert.rejects(() => service.getThreadById("ref:<nope@example.com>"), /Thread not found/);
  });
});

test("meeting prep and document search see whole threads", async () => {
  uid = 0;
  const emails = dataset();
  emails[1] = { ...emails[1], hasAttachments: true, attachments: [{ id: "1", filename: "contract.pdf", contentType: "application/pdf", size: 10, kind: "document" }] };
  await withIndex(emails, async (service) => {
    const prep = await service.getMeetingPrep({ person: "ann@example.com", limit: 10 });
    assert.ok(prep.threads.some((t) => t.subject === "Contract" && t.messageCount === 2));
    const docs = await service.findDocumentThreads({ query: "contract", limit: 10 });
    assert.ok(docs.threads.some((t) => t.messageCount === 2));
  });
});
