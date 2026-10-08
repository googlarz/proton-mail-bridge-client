import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalIndexService } from "../dist/services/local-index-service.js";
import { isOutgoingMessage } from "../dist/utils/helpers.js";

// "Pending on you" was decided by comparing the sender with the account's login address exactly. A reply sent from
// owner+work@... or from an alias (alias@pm.me) was not recognised as the owner's, so threads the owner had already
// answered were listed as waiting for the owner.

test("a message is outgoing when it is from the owner, in any capitalisation or with a +tag", () => {
  const owner = "owner@example.com";
  for (const address of ["owner@example.com", "Owner@Example.com", "owner+work@example.com"]) {
    assert.equal(isOutgoingMessage({ from: [{ address }], folder: "INBOX" }, owner), true, address);
  }
  assert.equal(isOutgoingMessage({ from: [{ address: "someone@example.com" }], folder: "INBOX" }, owner), false);
  assert.equal(isOutgoingMessage({ from: [{ address: "owner@example.org" }], folder: "INBOX" }, owner), false);
});

test("a message in the Sent folder is outgoing whatever address it was sent from (aliases)", () => {
  assert.equal(isOutgoingMessage({ from: [{ address: "alias@pm.me" }], folder: "Sent" }, "owner@example.com"), true);
  assert.equal(isOutgoingMessage({ from: [{ address: "alias@pm.me" }], folder: "INBOX" }, "owner@example.com"), false);
});

function createConfig(dataDir) {
  return {
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "x" },
    dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false,
      autoSyncLimitPerFolder: 100, idleWatchEnabled: false, idleMaxSeconds: 30 },
  };
}

const mail = (uid, folder, from, subject, date, inReplyTo) => ({
  id: `${folder}::${uid}`, folder, uid, seq: uid, messageId: `<m${uid}@x.example>`, ...(inReplyTo ? { inReplyTo } : {}), subject,
  from: [{ address: from }], to: [{ address: "owner@example.com" }], cc: [], bcc: [], replyTo: [],
  date, internalDate: date, isRead: true, isStarred: false, flags: [], preview: "p", hasAttachments: false, attachments: [], labels: [],
});

test("threads the owner already answered are pending on them, however the reply was sent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "protonmail-outgoing-"));
  const service = new LocalIndexService(createConfig(dir));
  try {
    const cases = [["owner@example.com", "direct"], ["Owner@Example.com", "capitals"], ["owner+work@example.com", "plus tag"], ["alias@pm.me", "alias"]];
    const emails = cases.flatMap(([address, label], index) => {
      const base = index * 2;
      return [
        mail(base + 1, "INBOX", "them@other.example", `Thread ${label}`, `2026-03-0${index + 1}T09:00:00.000Z`),
        mail(base + 2, "Sent", address, `Re: Thread ${label}`, `2026-03-0${index + 1}T10:00:00.000Z`, `<m${base + 1}@x.example>`),
      ];
    });
    await service.recordSnapshot({
      syncedAt: "2026-03-10T10:00:00.000Z",
      folders: [
        { path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "\\Inbox", listed: true, subscribed: true, flags: [], messages: 4, unseen: 0 },
        { path: "Sent", name: "Sent", delimiter: "/", specialUse: "\\Sent", listed: true, subscribed: true, flags: [], messages: 4, unseen: 0 },
      ],
      folderStats: [{ folder: "INBOX", fetched: 4, total: 4, strategy: "recent" }, { folder: "Sent", fetched: 4, total: 4, strategy: "recent" }],
      emails,
    });
    const result = await service.getActionableThreads({ limit: 20, unreadOnly: false, pendingOn: "any" });
    const threads = result.threads ?? [];
    assert.equal(threads.length, 4, JSON.stringify(threads.map((t) => t.subject)));
    for (const thread of threads) assert.equal(thread.pendingOn, "them", `${thread.subject} was answered by the owner`);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
