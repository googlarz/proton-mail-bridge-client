import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalIndexService } from "../dist/services/local-index-service.js";

// SQLite's LOWER() only folds ASCII and LIKE ignores nothing else, so the local index could not
// find "Pelcová" with "pelcova", and "łódź" did not even find "Łódź" (LOWER leaves Ł alone).
// Checked against a real index: the filters below returned 0 rows before the fold.

function createConfig(dataDir) {
  return {
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "x" },
    dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false,
      autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 100, idleWatchEnabled: false, idleMaxSeconds: 30 },
  };
}

function mail(uid, { subject, from, to = "owner@example.com", toName, preview = "", labels = [], attachments = [] }) {
  const date = `2026-03-${String(10 + uid).padStart(2, "0")}T09:00:00.000Z`;
  return {
    id: `INBOX::${uid}`, folder: "INBOX", uid, seq: uid, messageId: `<m${uid}@example.com>`, subject,
    from: [from], to: [{ name: toName, address: to }], cc: [], bcc: [], replyTo: [],
    date, internalDate: date, isRead: false, isStarred: false, flags: [], preview,
    hasAttachments: attachments.length > 0, attachments, labels,
  };
}

async function withIndex(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-accent-index-"));
  const service = new LocalIndexService(createConfig(dataDir));
  try {
    await service.recordSnapshot({
      syncedAt: "2026-03-25T10:00:00.000Z",
      folders: [{ path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "\\Inbox", listed: true, subscribed: true, flags: [], messages: 5, unseen: 5 }],
      folderStats: [{ folder: "INBOX", fetched: 5, total: 5, strategy: "recent" }],
      emails: [
        mail(1, { subject: "Faktura", from: { name: "Jana Pelcová", address: "j@firma.cz" } }),
        mail(2, { subject: "Spotkanie w ŁÓDŹ", from: { name: "Ann", address: "ann@example.com" } }),
        mail(3, { subject: "Zaproszenie", from: { name: "Bob", address: "bob@example.com" }, to: "zk@example.com", toName: "Zażółć Gęślą" }),
        mail(4, { subject: "Rozliczenie", from: { name: "Eve", address: "eve@example.com" }, labels: ["Labels/Księgowość"], attachments: [{ filename: "Umowa-Łódź.pdf", contentType: "application/pdf", kind: "document" }] }),
        mail(5, { subject: "Hello", from: { name: "Carl", address: "carl@example.com" }, preview: "Nowe książki w ofercie" }),
      ],
    });
    await fn(service);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

const ids = (result) => result.emails.map((e) => e.id).sort();

test("from matches ignoring accents and case, in both directions", async () => {
  await withIndex(async (service) => {
    assert.deepEqual(ids(await service.search({ from: "pelcova", limit: 10 })), ["INBOX::1"]);
    assert.deepEqual(ids(await service.search({ from: "PELCOVÁ", limit: 10 })), ["INBOX::1"]);
    assert.deepEqual(ids(await service.search({ from: "kowalski", limit: 10 })), []);
  });
});

test("subject matches Polish capitals and letters that do not decompose (Ł, ó, ź)", async () => {
  await withIndex(async (service) => {
    assert.deepEqual(ids(await service.search({ subject: "łódź", limit: 10 })), ["INBOX::2"]);
    assert.deepEqual(ids(await service.search({ subject: "lodz", limit: 10 })), ["INBOX::2"]);
  });
});

test("to, label and attachment name are folded too", async () => {
  await withIndex(async (service) => {
    assert.deepEqual(ids(await service.search({ to: "zazolc", limit: 10 })), ["INBOX::3"]);
    assert.deepEqual(ids(await service.search({ label: "ksiegowosc", limit: 10 })), ["INBOX::4"]);
    assert.deepEqual(ids(await service.search({ attachmentName: "lodz", limit: 10 })), ["INBOX::4"]);
  });
});

test("free-text query still matches accented words, in the same form or without accents", async () => {
  await withIndex(async (service) => {
    assert.deepEqual(ids(await service.search({ query: "książki", limit: 10 })), ["INBOX::5"]);
    assert.deepEqual(ids(await service.search({ query: "ksiazki", limit: 10 })), ["INBOX::5"]);
  });
});

test("the fold also applies to the inline from:/subject: shortcuts in a query", async () => {
  await withIndex(async (service) => {
    assert.deepEqual(ids(await service.search({ query: "from:pelcova", limit: 10 })), ["INBOX::1"]);
    assert.deepEqual(ids(await service.search({ query: "subject:łódź", limit: 10 })), ["INBOX::2"]);
  });
});

test("get_threads finds a thread by an accent-less query and label", async () => {
  await withIndex(async (service) => {
    const byQuery = await service.getThreads({ query: "lodz", limit: 10 });
    assert.equal(byQuery.threads.length, 1);
    assert.match(byQuery.threads[0].subject, /ŁÓDŹ/);
    const byLabel = await service.getThreads({ label: "ksiegowosc", limit: 10 });
    assert.equal(byLabel.threads.length, 1);
  });
});

test("plain ASCII searches behave as before (case-insensitive substring)", async () => {
  await withIndex(async (service) => {
    assert.deepEqual(ids(await service.search({ subject: "FAKTURA", limit: 10 })), ["INBOX::1"]);
    assert.deepEqual(ids(await service.search({ from: "ANN@EXAMPLE", limit: 10 })), ["INBOX::2"]);
  });
});
