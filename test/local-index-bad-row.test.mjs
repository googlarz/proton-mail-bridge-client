import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { LocalIndexService } from "../dist/services/local-index-service.js";

// A row whose JSON column holds valid JSON of the wrong shape (null, {}, a number) used to throw
// while the full-text index was being rebuilt. The version marker was never written, so every later
// open repeated the rebuild and failed again: one bad row made the whole index unusable.

function createConfig(dataDir) {
  return {
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "x" },
    dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false,
      autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 100, idleWatchEnabled: false, idleMaxSeconds: 30 },
  };
}

const mail = (uid) => ({
  id: `INBOX::${uid}`, folder: "INBOX", uid, seq: uid, messageId: `<m${uid}@example.com>`, subject: `Subject ${uid}`,
  from: [{ address: "a@example.com" }], to: [{ address: "owner@example.com" }], cc: [], bcc: [], replyTo: [],
  date: "2026-03-25T09:00:00.000Z", internalDate: "2026-03-25T09:00:00.000Z", isRead: false, isStarred: false,
  flags: [], preview: "hello", hasAttachments: false, attachments: [], labels: [],
});

async function withBrokenIndex(breakRows, fn) {
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-bad-row-"));
  try {
    let service = new LocalIndexService(createConfig(dataDir));
    await service.recordSnapshot({
      syncedAt: new Date().toISOString(),
      folders: [{ path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "\\Inbox", listed: true, subscribed: true, flags: [], messages: 3, unseen: 3 }],
      folderStats: [{ folder: "INBOX", fetched: 3, total: 3, strategy: "recent" }],
      emails: [mail(1), mail(2), mail(3)],
    });
    await service.close();
    const raw = new Database(join(dataDir, "mail-index.sqlite"));
    raw.exec(`DELETE FROM metadata WHERE key = 'ftsKeyVersion'`);
    breakRows(raw);
    raw.close();
    service = new LocalIndexService(createConfig(dataDir));
    try {
      await fn(service, dataDir);
    } finally {
      await service.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("JSON columns of the wrong shape do not stop the index from opening", async () => {
  await withBrokenIndex((raw) => {
    raw.exec(`UPDATE messages SET from_json = 'null', labels_json = '{}', attachments_json = '7' WHERE uid = 3`);
  }, async (service, dataDir) => {
    const result = await service.search({ subject: "Subject 1", limit: 10 });
    assert.deepEqual(result.emails.map((e) => e.id), ["INBOX::1"]);
    const broken = await service.search({ subject: "Subject 3", limit: 10 });
    assert.equal(broken.emails.length, 1, "the damaged message is still listed");
    assert.deepEqual(broken.emails[0].from, []);
    const raw = new Database(join(dataDir, "mail-index.sqlite"));
    try {
      assert.equal(raw.prepare(`SELECT value FROM metadata WHERE key = 'ftsKeyVersion'`).get().value, "2");
      assert.equal(raw.prepare(`SELECT COUNT(*) c FROM messages_fts`).get().c, 3);
    } finally {
      raw.close();
    }
  });
});

test("one row that cannot be converted is skipped instead of aborting the whole rebuild", async () => {
  const original = LocalIndexService.prototype.rowToEmailSummary;
  try {
    await withBrokenIndex(() => {
      // Only from here on, i.e. during the rebuild, one row cannot be read.
      LocalIndexService.prototype.rowToEmailSummary = function (row) {
        if (row.uid === 2) throw new Error("cannot convert this row");
        return original.call(this, row);
      };
    }, async (service, dataDir) => {
      const found = await service.search({ subject: "Subject 1", limit: 10 });
      assert.deepEqual(found.emails.map((e) => e.id), ["INBOX::1"]);
      const raw = new Database(join(dataDir, "mail-index.sqlite"));
      try {
        assert.equal(raw.prepare(`SELECT value FROM metadata WHERE key = 'ftsKeyVersion'`).get().value, "2");
        // The rows that could be converted are indexed; the skipped one just has no full-text entry.
        assert.equal(raw.prepare(`SELECT COUNT(*) c FROM messages_fts`).get().c, 2);
      } finally {
        raw.close();
      }
    });
  } finally {
    LocalIndexService.prototype.rowToEmailSummary = original;
  }
});
