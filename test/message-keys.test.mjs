import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { LocalIndexService } from "../dist/services/local-index-service.js";

// Filters read precomputed search keys from message_keys instead of calling a JavaScript function per row.
// The keys must follow the messages: written on insert and update, removed with the row, rebuilt for an
// index created before the table existed.

function config(dataDir) {
  return {
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "x" },
    dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false,
      autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 100, idleWatchEnabled: false, idleMaxSeconds: 30 },
  };
}

const folder = { path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "\\Inbox", listed: true, subscribed: true, flags: [], messages: 2, unseen: 2 };
function mail(uid, subject, name = "Ann", labels = []) {
  const date = `2026-03-${String(10 + uid).padStart(2, "0")}T09:00:00.000Z`;
  return { id: `INBOX::${uid}`, folder: "INBOX", uid, seq: uid, messageId: `<m${uid}@example.com>`, subject,
    from: [{ name, address: `a${uid}@example.com` }], to: [{ address: "owner@example.com" }], cc: [], bcc: [], replyTo: [],
    date, internalDate: date, isRead: false, isStarred: false, flags: [], preview: "", hasAttachments: false, attachments: [], labels };
}
const snapshot = (emails, extra = {}) => ({ syncedAt: "2026-03-25T10:00:00.000Z", folders: [folder],
  folderStats: [{ folder: "INBOX", fetched: emails.length, total: emails.length, strategy: "recent", ...extra }], emails });

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "message-keys-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}
const keyCount = (dir) => { const db = new Database(join(dir, "mail-index.sqlite"), { readonly: true }); try { return db.prepare("SELECT COUNT(*) c FROM message_keys").get().c; } finally { db.close(); } };

test("a changed subject is searchable under its new text only", async () => {
  await withDir(async (dir) => {
    const service = new LocalIndexService(config(dir));
    await service.recordSnapshot(snapshot([mail(1, "Faktura Łódź")]));
    assert.equal((await service.search({ subject: "lodz" })).emails.length, 1);
    await service.recordSnapshot(snapshot([mail(1, "Umowa")]));
    assert.equal((await service.search({ subject: "lodz" })).emails.length, 0);
    assert.equal((await service.search({ subject: "umowa" })).emails.length, 1);
    await service.close();
  });
});

test("an index created before message_keys existed is rebuilt on open and searches the same", async () => {
  await withDir(async (dir) => {
    let service = new LocalIndexService(config(dir));
    await service.recordSnapshot(snapshot([mail(1, "Grüße", "Herr Müller"), mail(2, "Hello")]));
    await service.close();
    const raw = new Database(join(dir, "mail-index.sqlite"));
    raw.exec("DROP TABLE message_keys; DELETE FROM metadata WHERE key = 'messageKeyVersion'");
    raw.close();
    service = new LocalIndexService(config(dir));
    assert.deepEqual((await service.search({ from: "mueller" })).emails.map((e) => e.id), ["INBOX::1"]);
    assert.equal((await service.search({ subject: "grusse" })).emails.length, 1);
    await service.close();
    assert.equal(keyCount(dir), 2);
  });
});

test("a message removed from the index loses its key", async () => {
  await withDir(async (dir) => {
    const service = new LocalIndexService(config(dir));
    await service.recordSnapshot(snapshot([mail(1, "one"), mail(2, "two")]));
    await service.close();
    assert.equal(keyCount(dir), 2);
    const raw = new Database(join(dir, "mail-index.sqlite"));
    raw.pragma("foreign_keys = ON");
    raw.exec("DELETE FROM messages WHERE uid = 1");
    raw.close();
    assert.equal(keyCount(dir), 1);
  });
});
