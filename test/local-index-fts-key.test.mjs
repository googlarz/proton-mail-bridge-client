import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { LocalIndexService } from "../dist/services/local-index-service.js";

// The full-text index stored text as-is, so a query without the diacritic never found a word with
// letters SQLite does not fold (ł, ß, ø...), and nothing found the Mueller/Müller spelling pair.
// It now stores each column's searchKey and the query is expanded into the same forms.

function createConfig(dataDir) {
  return {
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "x" },
    dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false,
      autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 100, idleWatchEnabled: false, idleMaxSeconds: 30 },
  };
}

function mail(uid, { subject, preview }) {
  const date = `2026-03-${String(10 + uid).padStart(2, "0")}T09:00:00.000Z`;
  return {
    id: `INBOX::${uid}`, folder: "INBOX", uid, seq: uid, messageId: `<m${uid}@example.com>`, subject,
    from: [{ name: "Sender", address: "s@example.com" }], to: [{ address: "owner@example.com" }], cc: [], bcc: [], replyTo: [],
    date, internalDate: date, isRead: false, isStarred: false, flags: [], preview, hasAttachments: false, attachments: [], labels: [],
  };
}

const EMAILS = [
  mail(1, { subject: "Wycieczka", preview: "Jedziemy do Łodzi w piątek" }),
  mail(2, { subject: "Rechnung", preview: "Die Straße ist gesperrt, Größe 42" }),
  mail(3, { subject: "Angebot", preview: "Herr Müller schickt die Rücksendung" }),
  mail(4, { subject: "Offer", preview: "Mr Mueller will call, regards Dueck" }),
  mail(5, { subject: "Hej", preview: "Søren och Åsa kommer imorgon" }),
];

const snapshot = {
  syncedAt: "2026-03-25T10:00:00.000Z",
  folders: [{ path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "\\Inbox", listed: true, subscribed: true, flags: [], messages: 5, unseen: 5 }],
  folderStats: [{ folder: "INBOX", fetched: 5, total: 5, strategy: "recent" }],
  emails: EMAILS,
};

async function withDataDir(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-fts-key-"));
  try {
    await fn(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

const found = async (service, query) => (await service.search({ query, limit: 10 })).emails.map((e) => e.id).sort();

test("free text finds ł, ß and the spelling pair, with or without the special letters", async () => {
  await withDataDir(async (dataDir) => {
    const service = new LocalIndexService(createConfig(dataDir));
    try {
      await service.recordSnapshot(snapshot);
      assert.deepEqual(await found(service, "lodzi"), ["INBOX::1"]);
      assert.deepEqual(await found(service, "Łodzi"), ["INBOX::1"]);
      assert.deepEqual(await found(service, "strasse"), ["INBOX::2"]);
      assert.deepEqual(await found(service, "Straße"), ["INBOX::2"]);
      assert.deepEqual(await found(service, "grosse"), ["INBOX::2"]);
      assert.deepEqual(await found(service, "rucksendung"), ["INBOX::3"]);
      assert.deepEqual(await found(service, "ruecksendung"), ["INBOX::3"]);
      assert.deepEqual(await found(service, "soeren"), ["INBOX::5"]);
      assert.deepEqual(await found(service, "aasa"), ["INBOX::5"]);
    } finally {
      await service.close();
    }
  });
});

test("Müller and Mueller find each other in either direction; plain spelling is not widened", async () => {
  await withDataDir(async (dataDir) => {
    const service = new LocalIndexService(createConfig(dataDir));
    try {
      await service.recordSnapshot(snapshot);
      assert.deepEqual(await found(service, "mueller"), ["INBOX::3", "INBOX::4"]);
      assert.deepEqual(await found(service, "Müller"), ["INBOX::3", "INBOX::4"]);
      assert.deepEqual(await found(service, "muller"), ["INBOX::3"]);
      assert.deepEqual(await found(service, "dueck"), ["INBOX::4"]);
      assert.deepEqual(await found(service, "duck"), []);
    } finally {
      await service.close();
    }
  });
});

test("a multi-word query still needs every word", async () => {
  await withDataDir(async (dataDir) => {
    const service = new LocalIndexService(createConfig(dataDir));
    try {
      await service.recordSnapshot(snapshot);
      assert.deepEqual(await found(service, "herr mueller"), ["INBOX::3"]);
      assert.deepEqual(await found(service, "herr dueck"), []);
    } finally {
      await service.close();
    }
  });
});

// Simulates a database written by an older version: the full-text rows hold the text as-is and the
// version marker is missing.
function downgradeToLegacyFts(dataDir) {
  const db = new Database(join(dataDir, "mail-index.sqlite"));
  try {
    db.exec(`DELETE FROM metadata WHERE key = 'ftsKeyVersion'; DELETE FROM messages_fts;`);
    const insert = db.prepare(`INSERT INTO messages_fts (email_id, subject, preview, folder, labels, participants, attachment_names) VALUES (?, ?, ?, ?, '', '', '')`);
    for (const e of EMAILS) insert.run(e.id, e.subject, e.preview, e.folder);
  } finally {
    db.close();
  }
}

test("an index written by an older version is rebuilt once on open", async () => {
  await withDataDir(async (dataDir) => {
    let service = new LocalIndexService(createConfig(dataDir));
    await service.recordSnapshot(snapshot);
    await service.close();
    downgradeToLegacyFts(dataDir);

    service = new LocalIndexService(createConfig(dataDir));
    try {
      assert.deepEqual(await found(service, "lodzi"), ["INBOX::1"]);
      assert.deepEqual(await found(service, "mueller"), ["INBOX::3", "INBOX::4"]);
      const status = await service.getStatus();
      assert.equal(status.storedMessageCount, 5);
    } finally {
      await service.close();
    }

    const raw = new Database(join(dataDir, "mail-index.sqlite"));
    try {
      assert.equal(raw.prepare(`SELECT value FROM metadata WHERE key = 'ftsKeyVersion'`).get().value, "2");
      assert.equal(raw.prepare(`SELECT COUNT(*) c FROM messages_fts`).get().c, 5);
    } finally {
      raw.close();
    }
  });
});

test("an up-to-date index is not rebuilt again on the next open", async () => {
  await withDataDir(async (dataDir) => {
    let service = new LocalIndexService(createConfig(dataDir));
    await service.recordSnapshot(snapshot);
    await service.close();

    // Remove one row behind the service's back: a rebuild would bring it back.
    const raw = new Database(join(dataDir, "mail-index.sqlite"));
    raw.prepare(`DELETE FROM messages_fts WHERE email_id = 'INBOX::1'`).run();
    raw.close();

    service = new LocalIndexService(createConfig(dataDir));
    try {
      assert.deepEqual(await found(service, "lodzi"), []);
      assert.deepEqual(await found(service, "mueller"), ["INBOX::3", "INBOX::4"]);
    } finally {
      await service.close();
    }
  });
});

test("an empty new index just records the version", async () => {
  await withDataDir(async (dataDir) => {
    const service = new LocalIndexService(createConfig(dataDir));
    try {
      await service.getStatus();
    } finally {
      await service.close();
    }
    const raw = new Database(join(dataDir, "mail-index.sqlite"));
    try {
      assert.equal(raw.prepare(`SELECT value FROM metadata WHERE key = 'ftsKeyVersion'`).get().value, "2");
    } finally {
      raw.close();
    }
  });
});
