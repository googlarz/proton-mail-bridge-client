import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { LocalIndexService } from "../dist/services/local-index-service.js";
import { createEmailId } from "../dist/utils/helpers.js";

function createConfig(dataDir) {
  return {
    smtp: {
      host: "127.0.0.1",
      port: 1025,
      secure: false,
      username: "owner@example.com",
      password: "secret",
    },
    imap: {
      host: "127.0.0.1",
      port: 1143,
      secure: false,
      username: "owner@example.com",
      password: "secret",
    },
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
      allowedActions: ["mark_read", "mark_unread", "star", "unstar", "archive", "trash", "restore"],
      startupSync: false,
      autoSyncFolder: "INBOX",
      autoSyncFull: false,
      autoSyncLimitPerFolder: 100,
      idleWatchEnabled: true,
      idleMaxSeconds: 30,
    },
  };
}

test("local index groups replies by In-Reply-To even when subject changes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-index-test-"));
  const service = new LocalIndexService(createConfig(dataDir));

  try {
    await service.recordSnapshot({
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
          messages: 2,
          unseen: 1,
        },
      ],
      folderStats: [{ folder: "INBOX", fetched: 2, total: 2 }],
      emails: [
        {
          id: "INBOX::1",
          folder: "INBOX",
          uid: 1,
          seq: 1,
          messageId: "<root@example.com>",
          subject: "Quarterly update",
          from: [{ address: "alice@example.com" }],
          to: [{ address: "owner@example.com" }],
          cc: [],
          bcc: [],
          replyTo: [],
          date: "2026-03-24T11:00:00.000Z",
          internalDate: "2026-03-24T11:00:00.000Z",
          isRead: false,
          isStarred: false,
          flags: [],
          preview: "Initial note",
          hasAttachments: false,
          attachments: [],
          labels: [],
        },
        {
          id: "INBOX::2",
          folder: "INBOX",
          uid: 2,
          seq: 2,
          messageId: "<reply@example.com>",
          inReplyTo: "<root@example.com>",
          subject: "Thanks",
          from: [{ address: "owner@example.com" }],
          to: [{ address: "alice@example.com" }],
          cc: [],
          bcc: [],
          replyTo: [],
          date: "2026-03-24T11:05:00.000Z",
          internalDate: "2026-03-24T11:05:00.000Z",
          isRead: true,
          isStarred: false,
          flags: ["\\Seen"],
          preview: "Thanks for the update",
          hasAttachments: false,
          attachments: [],
          labels: [],
        },
      ],
    });

    const threads = await service.getThreads({ limit: 10 });
    assert.equal(threads.total, 1);
    assert.equal(threads.threads[0].messageCount, 2);

    const detail = await service.getThreadById(threads.threads[0].id);
    assert.deepEqual(
      detail.messages.map((message) => message.primaryEmailId),
      ["INBOX::1", "INBOX::2"],
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("local index groups siblings by References when the parent message is missing", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-thread-ref-test-"));
  const service = new LocalIndexService(createConfig(dataDir));

  try {
    await service.recordSnapshot({
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
          messages: 2,
          unseen: 2,
        },
      ],
      folderStats: [{ folder: "INBOX", fetched: 2, total: 2, strategy: "recent" }],
      emails: [
        {
          id: "INBOX::10",
          folder: "INBOX",
          uid: 10,
          seq: 10,
          messageId: "<child-a@example.com>",
          inReplyTo: "<missing-root@example.com>",
          references: ["<missing-root@example.com>"],
          subject: "Re: Project status",
          from: [{ address: "alice@example.com" }],
          to: [{ address: "owner@example.com" }],
          cc: [],
          bcc: [],
          replyTo: [],
          date: "2026-03-24T11:00:00.000Z",
          internalDate: "2026-03-24T11:00:00.000Z",
          isRead: false,
          isStarred: false,
          flags: [],
          preview: "First reply",
          hasAttachments: false,
          attachments: [],
          labels: [],
        },
        {
          id: "INBOX::11",
          folder: "INBOX",
          uid: 11,
          seq: 11,
          messageId: "<child-b@example.com>",
          inReplyTo: "<missing-root@example.com>",
          references: ["<missing-root@example.com>"],
          subject: "Re: Project status",
          from: [{ address: "bob@example.com" }],
          to: [{ address: "owner@example.com" }],
          cc: [],
          bcc: [],
          replyTo: [],
          date: "2026-03-24T11:05:00.000Z",
          internalDate: "2026-03-24T11:05:00.000Z",
          isRead: false,
          isStarred: false,
          flags: [],
          preview: "Second reply",
          hasAttachments: false,
          attachments: [],
          labels: [],
        },
      ],
    });

    const threads = await service.getThreads({ limit: 10 });
    assert.equal(threads.total, 1);
    assert.equal(threads.threads[0].messageCount, 2);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("local index imports a legacy JSON snapshot into SQLite once", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-legacy-index-test-"));
  const legacyPath = join(dataDir, "mail-index.json");
  await writeFile(
    legacyPath,
    JSON.stringify({
      version: 1,
      ownerEmail: "owner@example.com",
      updatedAt: "2026-03-24T12:00:00.000Z",
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
          unseen: 0,
        },
      ],
      indexedFolders: {
        INBOX: {
          path: "INBOX",
          messages: 1,
          unseen: 0,
          specialUse: "\\Inbox",
          lastIndexedAt: "2026-03-24T12:00:00.000Z",
          lastIndexedCount: 1,
        },
      },
      messages: {
        "INBOX::1": {
          id: "INBOX::1",
          folder: "INBOX",
          uid: 1,
          seq: 1,
          messageId: "<root@example.com>",
          subject: "Imported",
          from: [{ address: "alice@example.com" }],
          to: [{ address: "owner@example.com" }],
          cc: [],
          bcc: [],
          replyTo: [],
          date: "2026-03-24T11:00:00.000Z",
          internalDate: "2026-03-24T11:00:00.000Z",
          isRead: true,
          isStarred: false,
          flags: ["\\Seen"],
          preview: "Imported preview",
          hasAttachments: false,
          attachments: [],
          labels: [],
        },
      },
    }),
    "utf8",
  );

  const service = new LocalIndexService(createConfig(dataDir));

  try {
    const status = await service.getStatus();
    assert.equal(status.storedMessageCount, 1);

    const result = await service.search({ query: "Imported", limit: 10 });
    assert.equal(result.total, 1);
    assert.equal(result.emails[0].id, "INBOX::1");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("indexed search supports domain and label normalization shortcuts", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-search-shortcut-test-"));
  const service = new LocalIndexService(createConfig(dataDir));

  try {
    await service.recordSnapshot({
      syncedAt: "2026-03-25T10:00:00.000Z",
      folders: [
        {
          path: "INBOX",
          name: "INBOX",
          delimiter: "/",
          specialUse: "\\Inbox",
          listed: true,
          subscribed: true,
          flags: [],
          messages: 2,
          unseen: 1,
        },
      ],
      folderStats: [{ folder: "INBOX", fetched: 2, total: 2, strategy: "recent" }],
      emails: [
        {
          id: "INBOX::21",
          folder: "INBOX",
          uid: 21,
          seq: 21,
          messageId: "<vendor@example.com>",
          subject: "Invoice for March",
          from: [{ address: "billing@example.com" }],
          to: [{ address: "owner@example.com" }],
          cc: [],
          bcc: [],
          replyTo: [],
          date: "2026-03-25T09:00:00.000Z",
          internalDate: "2026-03-25T09:00:00.000Z",
          isRead: false,
          isStarred: false,
          flags: [],
          preview: "Please find your invoice attached",
          hasAttachments: true,
          attachments: [{ filename: "invoice.pdf", contentType: "application/pdf", kind: "document" }],
          labels: ["Labels/Finance"],
        },
        {
          id: "INBOX::22",
          folder: "INBOX",
          uid: 22,
          seq: 22,
          messageId: "<other@another.com>",
          subject: "Status update",
          from: [{ address: "person@another.com" }],
          to: [{ address: "owner@example.com" }],
          cc: [],
          bcc: [],
          replyTo: [],
          date: "2026-03-25T08:00:00.000Z",
          internalDate: "2026-03-25T08:00:00.000Z",
          isRead: true,
          isStarred: false,
          flags: ["\\Seen"],
          preview: "Quick update",
          hasAttachments: false,
          attachments: [],
          labels: [],
        },
      ],
    });

    const result = await service.search({
      query: "domain:example.com label:Finance invoice",
      limit: 10,
    });

    assert.equal(result.total, 1);
    assert.equal(result.emails[0].id, "INBOX::21");
    assert.equal(result.warnings, undefined);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("search_indexed_emails' mailboxRole filter actually filters by folder, not silently ignored", async () => {
  // Found live: search_indexed_emails documents mailboxRole ("Normalized
  // mailbox role like Inbox, Sent, Archive, or Trash") but the filter was
  // never checked anywhere in matchesIndexedSearch — mailboxRole:"trash"
  // returned a message that was actually in Sent. The live-IMAP
  // search_emails path (matchesLocalSearchFilters) already implemented
  // this filter correctly, which is how the gap was found.
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-mailbox-role-test-"));
  const service = new LocalIndexService(createConfig(dataDir));

  try {
    await service.recordSnapshot({
      syncedAt: "2026-03-25T10:00:00.000Z",
      folders: [
        { path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "\\Inbox", listed: true, subscribed: true, flags: [], messages: 1, unseen: 0 },
        { path: "Sent", name: "Sent", delimiter: "/", specialUse: "\\Sent", listed: true, subscribed: true, flags: [], messages: 1, unseen: 0 },
      ],
      folderStats: [
        { folder: "INBOX", fetched: 1, total: 1, strategy: "recent" },
        { folder: "Sent", fetched: 1, total: 1, strategy: "recent" },
      ],
      emails: [
        {
          id: "INBOX::30", folder: "INBOX", uid: 30, seq: 30,
          messageId: "<inbound@example.com>", subject: "Inbound message",
          from: [{ address: "someone@example.com" }], to: [{ address: "owner@example.com" }],
          cc: [], bcc: [], replyTo: [],
          date: "2026-03-25T09:00:00.000Z", internalDate: "2026-03-25T09:00:00.000Z",
          isRead: false, isStarred: false, flags: [],
          preview: "Inbound", hasAttachments: false, attachments: [], labels: [],
        },
        {
          id: "Sent::31", folder: "Sent", uid: 31, seq: 31,
          messageId: "<outbound@example.com>", subject: "Outbound message",
          from: [{ address: "owner@example.com" }], to: [{ address: "someone@example.com" }],
          cc: [], bcc: [], replyTo: [],
          date: "2026-03-25T08:00:00.000Z", internalDate: "2026-03-25T08:00:00.000Z",
          isRead: true, isStarred: false, flags: ["\\Seen"],
          preview: "Outbound", hasAttachments: false, attachments: [], labels: [],
        },
      ],
    });

    const trashResult = await service.search({ mailboxRole: "trash", limit: 10 });
    assert.equal(trashResult.total, 0, "neither message is in Trash");

    const sentResult = await service.search({ mailboxRole: "sent", limit: 10 });
    assert.equal(sentResult.total, 1);
    assert.equal(sentResult.emails[0].id, "Sent::31");

    const inboxResult = await service.search({ mailboxRole: "inbox", limit: 10 });
    assert.equal(inboxResult.total, 1);
    assert.equal(inboxResult.emails[0].id, "INBOX::30");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("search_indexed_emails' from filter finds matches older than the SQL candidate window", async () => {
  // Found via code inspection, confirmed with this test: loadCandidateEmails
  // only pre-filtered the SQL scan by folder/isRead/isStarred/hasAttachment/
  // subject/senderDomain/threadId/dateFrom/dateTo — from/to/messageId were
  // accepted by the tool schema and correctly checked afterward by
  // matchesIndexedSearch, but never applied in SQL. The SQL scan takes only
  // the newest `limitHint` (500, or limit*10) rows by date before that JS
  // filter ever runs, so a from/to/messageId match older than that window
  // was silently dropped — it never made it into the candidate set to be
  // filtered in the first place. Reproduced here with 500 unrelated recent
  // messages plus one true match older than all of them.
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-candidate-window-test-"));
  const service = new LocalIndexService(createConfig(dataDir));

  try {
    const emails = [];
    for (let i = 0; i < 500; i += 1) {
      emails.push({
        id: `INBOX::${1000 + i}`, folder: "INBOX", uid: 1000 + i, seq: 1000 + i,
        messageId: `<noise-${i}@example.com>`, subject: "Noise",
        from: [{ address: "noise@example.com" }], to: [{ address: "owner@example.com" }],
        cc: [], bcc: [], replyTo: [],
        date: `2026-08-${String(2 + (i % 27)).padStart(2, "0")}T10:00:00.000Z`,
        internalDate: `2026-08-${String(2 + (i % 27)).padStart(2, "0")}T10:00:00.000Z`,
        isRead: false, isStarred: false, flags: [],
        preview: "Noise", hasAttachments: false, attachments: [], labels: [],
      });
    }
    emails.push({
      id: "INBOX::1", folder: "INBOX", uid: 1, seq: 1,
      messageId: "<real-match@example.com>", subject: "The one I'm looking for",
      from: [{ address: "target@example.com" }], to: [{ address: "owner@example.com" }],
      cc: [], bcc: [], replyTo: [],
      date: "2020-01-01T00:00:00.000Z", internalDate: "2020-01-01T00:00:00.000Z",
      isRead: false, isStarred: false, flags: [],
      preview: "Old but relevant", hasAttachments: false, attachments: [], labels: [],
    });

    await service.recordSnapshot({
      syncedAt: "2026-08-29T00:00:00.000Z",
      folders: [{ path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "\\Inbox", listed: true, subscribed: true, flags: [], messages: emails.length, unseen: 0 }],
      folderStats: [{ folder: "INBOX", fetched: emails.length, total: emails.length, strategy: "full" }],
      emails,
    });

    const byFrom = await service.search({ from: "target@example.com", limit: 10 });
    assert.equal(byFrom.total, 1, "from filter must find the match even though it's older than the 500-row candidate window");
    assert.equal(byFrom.emails[0].id, "INBOX::1");

    const byMessageId = await service.search({ messageId: "<real-match@example.com>", limit: 10 });
    assert.equal(byMessageId.total, 1);
    assert.equal(byMessageId.emails[0].id, "INBOX::1");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a windowed full sync only prunes expunged messages within its own scanned UID range", async () => {
  // Before this fix, cleanupExpunged compared a "full" sync's fetched batch
  // against every stored message in that folder, not just the UID range it
  // actually re-scanned. A full sync only ever fetches one bounded window
  // (e.g. the newest 500 of a 22,000-message folder), so every previously
  // indexed message outside that window looked "expunged" and was deleted —
  // this is what made repeated full:true backfill calls actively
  // self-destructive: each new (older) window's sync wiped out every
  // message the previous window had just added.
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-windowed-prune-test-"));
  const service = new LocalIndexService(createConfig(dataDir));

  const makeEmail = (uid) => ({
    id: `Archive::${uid}`, folder: "Archive", uid, seq: uid,
    messageId: `<msg-${uid}@example.com>`, subject: `Message ${uid}`,
    from: [{ address: "sender@example.com" }], to: [{ address: "owner@example.com" }],
    cc: [], bcc: [], replyTo: [],
    date: "2026-01-01T00:00:00.000Z", internalDate: "2026-01-01T00:00:00.000Z",
    isRead: false, isStarred: false, flags: [],
    preview: "Body", hasAttachments: false, attachments: [], labels: [],
  });

  try {
    // First full-sync window: the newest batch, UIDs 501-1000.
    await service.recordSnapshot({
      syncedAt: "2026-09-07T00:00:00.000Z",
      folders: [{ path: "Archive", name: "Archive", delimiter: "/", specialUse: "\\Archive", listed: true, subscribed: true, flags: [], messages: 1000, unseen: 0 }],
      folderStats: [{ folder: "Archive", fetched: 500, total: 1000, strategy: "full", rangeStartUid: 501, rangeEndUid: 1000 }],
      emails: Array.from({ length: 500 }, (_, i) => makeEmail(501 + i)),
    });

    let status = await service.getStatus();
    assert.equal(status.storedMessageCount, 500, "first window should have indexed 500 messages");

    // Second, older backfill window: UIDs 1-500 — must NOT delete the first
    // window's messages (501-1000), which are outside this call's range.
    await service.recordSnapshot({
      syncedAt: "2026-09-07T00:01:00.000Z",
      folders: [{ path: "Archive", name: "Archive", delimiter: "/", specialUse: "\\Archive", listed: true, subscribed: true, flags: [], messages: 1000, unseen: 0 }],
      folderStats: [{ folder: "Archive", fetched: 500, total: 1000, strategy: "full", rangeStartUid: 1, rangeEndUid: 500 }],
      emails: Array.from({ length: 500 }, (_, i) => makeEmail(1 + i)),
    });

    status = await service.getStatus();
    assert.equal(status.storedMessageCount, 1000, "backfilling an older window must not delete the previously-synced newer window");

    // A genuine expunge WITHIN a re-scanned range must still be detected:
    // re-sync the 1-500 window with uid 250 now missing from the server.
    await service.recordSnapshot({
      syncedAt: "2026-09-07T00:02:00.000Z",
      folders: [{ path: "Archive", name: "Archive", delimiter: "/", specialUse: "\\Archive", listed: true, subscribed: true, flags: [], messages: 999, unseen: 0 }],
      folderStats: [{ folder: "Archive", fetched: 499, total: 999, strategy: "full", rangeStartUid: 1, rangeEndUid: 500 }],
      emails: Array.from({ length: 500 }, (_, i) => 1 + i).filter((uid) => uid !== 250).map(makeEmail),
    });

    status = await service.getStatus();
    assert.equal(status.storedMessageCount, 999, "a message genuinely missing from a re-scanned range must still be pruned");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a folder observed genuinely empty on the server has its indexed messages purged", async () => {
  // planFolderSync returns strategy:"empty" with no UID range at all when a
  // mailbox is observed with exists === 0 — the range-scoped expunge-detection
  // in applySnapshot only ever runs against a fetched range, so it never fired
  // for "empty" and a folder emptied on the server kept its stale messages
  // forever. folderObservedEmpty is the signal that closes that gap.
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-empty-folder-purge-test-"));
  const service = new LocalIndexService(createConfig(dataDir));

  const makeEmail = (folder, uid) => ({
    id: `${folder}::${uid}`, folder, uid, seq: uid,
    messageId: `<msg-${folder}-${uid}@example.com>`, subject: `Message ${uid}`,
    from: [{ address: "sender@example.com" }], to: [{ address: "owner@example.com" }],
    cc: [], bcc: [], replyTo: [],
    date: "2026-01-01T00:00:00.000Z", internalDate: "2026-01-01T00:00:00.000Z",
    isRead: false, isStarred: false, flags: [],
    preview: "Body", hasAttachments: false, attachments: [], labels: [],
  });

  try {
    // Seed two folders with indexed messages.
    await service.recordSnapshot({
      syncedAt: "2026-09-07T00:00:00.000Z",
      folders: [
        { path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "\\Inbox", listed: true, subscribed: true, flags: [], messages: 2, unseen: 0 },
        { path: "Archive", name: "Archive", delimiter: "/", specialUse: "\\Archive", listed: true, subscribed: true, flags: [], messages: 1, unseen: 0 },
      ],
      folderStats: [
        { folder: "INBOX", fetched: 2, total: 2, strategy: "full", rangeStartUid: 1, rangeEndUid: 2 },
        { folder: "Archive", fetched: 1, total: 1, strategy: "full", rangeStartUid: 1, rangeEndUid: 1 },
      ],
      emails: [makeEmail("INBOX", 1), makeEmail("INBOX", 2), makeEmail("Archive", 1)],
    });

    let status = await service.getStatus();
    assert.equal(status.storedMessageCount, 3, "both folders should be indexed before the emptying");

    // INBOX is now observed genuinely empty on the server (exists === 0);
    // Archive is untouched by this sync.
    await service.recordSnapshot({
      syncedAt: "2026-09-07T00:01:00.000Z",
      folders: [
        { path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "\\Inbox", listed: true, subscribed: true, flags: [], messages: 0, unseen: 0 },
      ],
      folderStats: [
        { folder: "INBOX", fetched: 0, total: 0, strategy: "empty", changed: false, folderObservedEmpty: true },
      ],
      emails: [],
    });

    status = await service.getStatus();
    assert.equal(status.storedMessageCount, 1, "INBOX's stale messages must be purged, leaving only Archive's");

    const inboxSearch = await service.search({ folder: "INBOX", limit: 10 });
    assert.equal(inboxSearch.total, 0, "search must no longer return INBOX's stale messages");

    const archiveSearch = await service.search({ folder: "Archive", limit: 10 });
    assert.equal(archiveSearch.total, 1, "Archive's messages must be untouched by INBOX's emptying");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("an empty strategy without a confirmed folderObservedEmpty signal does not purge the index", async () => {
  // strategy:"empty" is also reached when highestKnownUid === 0 (uidNext
  // missing/1) without the server having actually reported exists === 0.
  // That case must NOT trigger cleanup — only a genuine, successful
  // exists === 0 observation (folderObservedEmpty: true) may wipe a folder.
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-empty-strategy-no-signal-test-"));
  const service = new LocalIndexService(createConfig(dataDir));

  const makeEmail = (uid) => ({
    id: `INBOX::${uid}`, folder: "INBOX", uid, seq: uid,
    messageId: `<msg-${uid}@example.com>`, subject: `Message ${uid}`,
    from: [{ address: "sender@example.com" }], to: [{ address: "owner@example.com" }],
    cc: [], bcc: [], replyTo: [],
    date: "2026-01-01T00:00:00.000Z", internalDate: "2026-01-01T00:00:00.000Z",
    isRead: false, isStarred: false, flags: [],
    preview: "Body", hasAttachments: false, attachments: [], labels: [],
  });

  try {
    await service.recordSnapshot({
      syncedAt: "2026-09-07T00:00:00.000Z",
      folders: [{ path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "\\Inbox", listed: true, subscribed: true, flags: [], messages: 1, unseen: 0 }],
      folderStats: [{ folder: "INBOX", fetched: 1, total: 1, strategy: "full", rangeStartUid: 1, rangeEndUid: 1 }],
      emails: [makeEmail(1)],
    });

    await service.recordSnapshot({
      syncedAt: "2026-09-07T00:01:00.000Z",
      folders: [{ path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "\\Inbox", listed: true, subscribed: true, flags: [], messages: 1, unseen: 0 }],
      folderStats: [{ folder: "INBOX", fetched: 0, total: 1, strategy: "empty", changed: false }],
      emails: [],
    });

    const status = await service.getStatus();
    assert.equal(status.storedMessageCount, 1, "without folderObservedEmpty, the previously-indexed message must survive");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("getSyncCheckpointMap returns backfilledToUid as undefined, not null, when never set", async () => {
  // SQLite returns null (not undefined) for an unset column. planFolderSync
  // distinguishes "no prior backfill" (undefined) from a real floor value —
  // and `null <= 1` is true in JS — so a raw null here made the very first
  // full sync after this column was introduced look like backfill had
  // already reached UID 1, reporting changed:false/fetched:0 instead of
  // starting the newest window. Found live immediately after deploying the
  // backfill feature itself.
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-backfill-null-test-"));
  const service = new LocalIndexService(createConfig(dataDir));

  try {
    await service.recordSnapshot({
      syncedAt: "2026-09-07T00:00:00.000Z",
      folders: [{ path: "Archive", name: "Archive", delimiter: "/", specialUse: "\\Archive", listed: true, subscribed: true, flags: [], messages: 1, unseen: 0 }],
      folderStats: [{ folder: "Archive", fetched: 1, total: 1, strategy: "full", rangeStartUid: 1, rangeEndUid: 1 }],
      emails: [{
        id: "Archive::1", folder: "Archive", uid: 1, seq: 1,
        messageId: "<msg-1@example.com>", subject: "Message 1",
        from: [{ address: "sender@example.com" }], to: [{ address: "owner@example.com" }],
        cc: [], bcc: [], replyTo: [],
        date: "2026-01-01T00:00:00.000Z", internalDate: "2026-01-01T00:00:00.000Z",
        isRead: false, isStarred: false, flags: [],
        preview: "Body", hasAttachments: false, attachments: [], labels: [],
      }],
    });

    const checkpoints = await service.getSyncCheckpointMap();
    assert.strictEqual(checkpoints.Archive.backfilledToUid, undefined, "must be undefined, not SQLite's null, or planFolderSync misreads it as backfill-complete");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("getSyncCheckpointMap returns incrementalResumeUid as undefined, not null, when never set", async () => {
  // Same NULL-vs-undefined pitfall as backfilledToUid above (see the test right
  // above this one): planFolderSync uses undefined to mean "no incremental
  // catch-up in progress" for a large-gap folder. A raw SQLite null read back
  // here must map to undefined too, or a stale/mismatched comparison downstream
  // could misinterpret it.
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-incremental-resume-null-test-"));
  const service = new LocalIndexService(createConfig(dataDir));

  try {
    await service.recordSnapshot({
      syncedAt: "2026-09-07T00:00:00.000Z",
      folders: [{ path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "\\Inbox", listed: true, subscribed: true, flags: [], messages: 1, unseen: 0 }],
      folderStats: [{ folder: "INBOX", fetched: 1, total: 1, strategy: "incremental", rangeStartUid: 1, rangeEndUid: 1, highestUid: 1 }],
      emails: [{
        id: "INBOX::1", folder: "INBOX", uid: 1, seq: 1,
        messageId: "<msg-1@example.com>", subject: "Message 1",
        from: [{ address: "sender@example.com" }], to: [{ address: "owner@example.com" }],
        cc: [], bcc: [], replyTo: [],
        date: "2026-01-01T00:00:00.000Z", internalDate: "2026-01-01T00:00:00.000Z",
        isRead: false, isStarred: false, flags: [],
        preview: "Body", hasAttachments: false, attachments: [], labels: [],
      }],
    });

    const checkpoints = await service.getSyncCheckpointMap();
    assert.strictEqual(
      checkpoints.INBOX.incrementalResumeUid,
      undefined,
      "must be undefined, not SQLite's null, or planFolderSync could misread it as a real resume cursor",
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("recordSnapshot round-trips a set incrementalResumeUid through getSyncCheckpointMap", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-incremental-resume-roundtrip-test-"));
  const service = new LocalIndexService(createConfig(dataDir));

  try {
    await service.recordSnapshot({
      syncedAt: "2026-09-07T00:00:00.000Z",
      folders: [{ path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "\\Inbox", listed: true, subscribed: true, flags: [], messages: 1, unseen: 0 }],
      folderStats: [{
        folder: "INBOX",
        fetched: 1,
        total: 1,
        strategy: "incremental",
        rangeStartUid: 976,
        rangeEndUid: 1025,
        highestUid: 1000,
        incrementalResumeUid: 1025,
      }],
      emails: [{
        id: "INBOX::1025", folder: "INBOX", uid: 1025, seq: 1,
        messageId: "<msg-1025@example.com>", subject: "Message 1025",
        from: [{ address: "sender@example.com" }], to: [{ address: "owner@example.com" }],
        cc: [], bcc: [], replyTo: [],
        date: "2026-01-01T00:00:00.000Z", internalDate: "2026-01-01T00:00:00.000Z",
        isRead: false, isStarred: false, flags: [],
        preview: "Body", hasAttachments: false, attachments: [], labels: [],
      }],
    });

    const checkpoints = await service.getSyncCheckpointMap();
    assert.strictEqual(checkpoints.INBOX.incrementalResumeUid, 1025);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("dateFrom/dateTo set to the same day includes that day's messages instead of excluding it", async () => {
  // Found live: dateTo:"2026-09-02" did `COALESCE(internal_date, date) <=
  // "2026-09-02"` — a raw string comparison against a full ISO timestamp
  // ("2026-09-02T17:14:06.000Z" <= "2026-09-02" is false, the longer
  // string sorts after the bare-date prefix), so every message on the
  // dateTo day itself was silently excluded. dateFrom:dateTo set to the
  // same real day returned zero results despite messages from that day
  // existing. Fixed by treating dateTo as an exclusive upper bound at the
  // start of the next day, matching how the live-IMAP search path
  // (buildSearchQuery's `query.before = nextDay(dateTo)`) already handles it.
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-date-boundary-test-"));
  const service = new LocalIndexService(createConfig(dataDir));

  try {
    await service.recordSnapshot({
      syncedAt: "2026-09-02T18:00:00.000Z",
      folders: [
        { path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "\\Inbox", listed: true, subscribed: true, flags: [], messages: 2, unseen: 0 },
      ],
      folderStats: [{ folder: "INBOX", fetched: 2, total: 2, strategy: "recent" }],
      emails: [
        {
          id: "INBOX::40", folder: "INBOX", uid: 40, seq: 40,
          messageId: "<today@example.com>", subject: "Today's message",
          from: [{ address: "someone@example.com" }], to: [{ address: "owner@example.com" }],
          cc: [], bcc: [], replyTo: [],
          date: "2026-09-02T17:14:06.000Z", internalDate: "2026-09-02T17:14:06.000Z",
          isRead: false, isStarred: false, flags: [],
          preview: "Today", hasAttachments: false, attachments: [], labels: [],
        },
        {
          id: "INBOX::41", folder: "INBOX", uid: 41, seq: 41,
          messageId: "<yesterday@example.com>", subject: "Yesterday's message",
          from: [{ address: "someone@example.com" }], to: [{ address: "owner@example.com" }],
          cc: [], bcc: [], replyTo: [],
          date: "2026-09-01T10:00:00.000Z", internalDate: "2026-09-01T10:00:00.000Z",
          isRead: false, isStarred: false, flags: [],
          preview: "Yesterday", hasAttachments: false, attachments: [], labels: [],
        },
      ],
    });

    const sameDayResult = await service.search({ dateFrom: "2026-09-02", dateTo: "2026-09-02", limit: 10 });
    assert.equal(sameDayResult.total, 1, "today's message must be included when dateFrom/dateTo are both today");
    assert.equal(sameDayResult.emails[0].id, "INBOX::40");

    const excludesYesterday = await service.search({ dateFrom: "2026-09-02", limit: 10 });
    assert.equal(excludesYesterday.total, 1, "yesterday's message must still be excluded by dateFrom");

    const dateToYesterdayResult = await service.search({ dateTo: "2026-09-01", limit: 10 });
    assert.equal(dateToYesterdayResult.total, 1);
    assert.equal(dateToYesterdayResult.emails[0].id, "INBOX::41", "dateTo boundary must still exclude the next day");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("recordSnapshot preserves preview/attachmentText across a flags-only re-sync of the same UID", async () => {
  // Reproduces the "cheapen the no-change sync cycle" fix: an unchanged incremental
  // window re-syncs with no message source fetched, so preview/attachmentText come
  // back unset. That must NOT wipe out the values a prior full sync already indexed
  // — IMAP content for a fixed UID is immutable, only flags change.
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-coalesce-test-"));
  const service = new LocalIndexService(createConfig(dataDir));

  const folderInfo = {
    path: "INBOX",
    name: "INBOX",
    delimiter: "/",
    specialUse: "\\Inbox",
    listed: true,
    subscribed: true,
    flags: [],
    messages: 1,
    unseen: 1,
  };
  const baseEmail = {
    id: "INBOX::40",
    folder: "INBOX",
    uid: 40,
    seq: 40,
    messageId: "<x@example.com>",
    subject: "Quarterly report",
    from: [{ address: "person@example.com" }],
    to: [{ address: "owner@example.com" }],
    cc: [],
    bcc: [],
    replyTo: [],
    date: "2026-03-25T09:00:00.000Z",
    internalDate: "2026-03-25T09:00:00.000Z",
    isRead: false,
    isStarred: false,
    flags: [],
    hasAttachments: false,
    attachments: [],
    labels: [],
  };

  try {
    // First sync: full detail fetch, preview and attachmentText populated.
    await service.recordSnapshot({
      syncedAt: "2026-03-25T10:00:00.000Z",
      folders: [folderInfo],
      folderStats: [{ folder: "INBOX", fetched: 1, total: 1, strategy: "recent" }],
      emails: [{ ...baseEmail, preview: "Attached is the quarterly report", attachmentText: "revenue figures" }],
    });

    // Second sync: an unchanged incremental_window cycle — flags-only fetch, so
    // preview/attachmentText are undefined on the incoming row (only isRead flips).
    await service.recordSnapshot({
      syncedAt: "2026-03-25T10:05:00.000Z",
      folders: [folderInfo],
      folderStats: [{ folder: "INBOX", fetched: 1, total: 1, strategy: "incremental_window" }],
      emails: [{ ...baseEmail, isRead: true, preview: undefined, attachmentText: undefined }],
    });

    const result = await service.search({ query: undefined, folder: "INBOX", limit: 10 });
    const stored = result.emails.find((email) => email.id === "INBOX::40");

    assert.ok(stored);
    assert.equal(stored.isRead, true, "flags-only sync should still update isRead");
    assert.equal(stored.preview, "Attached is the quarterly report", "preview must survive a flags-only re-sync");

    // The messages-table COALESCE preserving `preview` above is not enough on
    // its own: the FTS index is deleted and reinserted on every sync using
    // whatever the *incoming* row said, not the merged/persisted value — so
    // a full-text search for a body term can go from matching to zero
    // results even though the stored preview above proves the row is intact.
    const ftsResult = await service.search({ query: "quarterly report", folder: "INBOX", limit: 10 });
    assert.ok(
      ftsResult.emails.some((email) => email.id === "INBOX::40"),
      "full-text search must still find the message by body term after a flags-only re-sync",
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("search treats a query of only FTS5-keyword/hyphen tokens as a real (zero-match) search, not a dropped query", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-search-warning-test-"));
  const service = new LocalIndexService(createConfig(dataDir));

  try {
    await service.recordSnapshot({
      syncedAt: "2026-03-25T10:00:00.000Z",
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
          unseen: 0,
        },
      ],
      folderStats: [{ folder: "INBOX", fetched: 1, total: 1, strategy: "recent" }],
      emails: [
        {
          id: "INBOX::30",
          folder: "INBOX",
          uid: 30,
          seq: 30,
          messageId: "<a@example.com>",
          subject: "Not an update",
          from: [{ address: "person@example.com" }],
          to: [{ address: "owner@example.com" }],
          cc: [],
          bcc: [],
          replyTo: [],
          date: "2026-03-25T09:00:00.000Z",
          internalDate: "2026-03-25T09:00:00.000Z",
          isRead: false,
          isStarred: false,
          flags: [],
          preview: "Nothing relevant here",
          hasAttachments: false,
          attachments: [],
          labels: [],
        },
      ],
    });

    // Tokens that collide with FTS5 keywords (NOT/AND) or start with a leading
    // hyphen are quoted as literal search terms rather than silently dropped, so
    // this runs as a real (all-required) search for those literal words/phrase and
    // simply finds no match among the indexed messages — no warning expected.
    const result = await service.search({ query: "NOT AND -foo", limit: 10 });

    assert.equal(result.total, 0);
    assert.equal(result.warnings, undefined);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("search treats FTS5-keyword and leading-hyphen terms as literal words instead of dropping them", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-search-fts5-keyword-test-"));
  const service = new LocalIndexService(createConfig(dataDir));

  try {
    await service.recordSnapshot({
      syncedAt: "2026-03-25T10:00:00.000Z",
      folders: [
        {
          path: "INBOX",
          name: "INBOX",
          delimiter: "/",
          specialUse: "\\Inbox",
          listed: true,
          subscribed: true,
          flags: [],
          messages: 2,
          unseen: 0,
        },
      ],
      folderStats: [{ folder: "INBOX", fetched: 2, total: 2, strategy: "recent" }],
      emails: [
        {
          id: "INBOX::31",
          folder: "INBOX",
          uid: 31,
          seq: 31,
          messageId: "<b@example.com>",
          subject: "AND gate schematics",
          from: [{ address: "person@example.com" }],
          to: [{ address: "owner@example.com" }],
          cc: [],
          bcc: [],
          replyTo: [],
          date: "2026-03-25T09:00:00.000Z",
          internalDate: "2026-03-25T09:00:00.000Z",
          isRead: false,
          isStarred: false,
          flags: [],
          preview: "Diagram attached",
          hasAttachments: false,
          attachments: [],
          labels: [],
        },
        {
          id: "INBOX::32",
          folder: "INBOX",
          uid: 32,
          seq: 32,
          messageId: "<c@example.com>",
          subject: "Unrelated gate schematics",
          from: [{ address: "person@example.com" }],
          to: [{ address: "owner@example.com" }],
          cc: [],
          bcc: [],
          replyTo: [],
          date: "2026-03-25T08:00:00.000Z",
          internalDate: "2026-03-25T08:00:00.000Z",
          isRead: false,
          isStarred: false,
          flags: [],
          preview: "Nothing relevant here",
          hasAttachments: false,
          attachments: [],
          labels: [],
        },
      ],
    });

    // Before the fix, the literal token "AND" was silently dropped, so this query
    // degraded to `"gate" AND "schematics"` and matched both messages. Quoting it
    // as a literal term now correctly requires "AND" too, matching only INBOX::31.
    const result = await service.search({ query: "AND gate schematics", limit: 10 });
    assert.equal(result.total, 1);
    assert.equal(result.emails[0].id, "INBOX::31");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("document threads groups invoice and calendar-heavy messages", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-document-thread-test-"));
  const service = new LocalIndexService(createConfig(dataDir));

  try {
    await service.recordSnapshot({
      syncedAt: "2026-03-25T10:00:00.000Z",
      folders: [
        {
          path: "INBOX",
          name: "INBOX",
          delimiter: "/",
          specialUse: "\\Inbox",
          listed: true,
          subscribed: true,
          flags: [],
          messages: 2,
          unseen: 1,
        },
      ],
      folderStats: [{ folder: "INBOX", fetched: 2, total: 2, strategy: "recent" }],
      emails: [
        {
          id: "INBOX::31",
          folder: "INBOX",
          uid: 31,
          seq: 31,
          messageId: "<invoice@example.com>",
          subject: "Invoice package",
          from: [{ address: "billing@example.com" }],
          to: [{ address: "owner@example.com" }],
          cc: [],
          bcc: [],
          replyTo: [],
          date: "2026-03-25T09:00:00.000Z",
          internalDate: "2026-03-25T09:00:00.000Z",
          isRead: false,
          isStarred: false,
          flags: [],
          preview: "Invoice attached",
          hasAttachments: true,
          attachments: [{ filename: "invoice.pdf", contentType: "application/pdf", kind: "document" }],
          labels: [],
        },
        {
          id: "INBOX::32",
          folder: "INBOX",
          uid: 32,
          seq: 32,
          messageId: "<invite@example.com>",
          subject: "Board meeting invite",
          from: [{ address: "assistant@example.com" }],
          to: [{ address: "owner@example.com" }],
          cc: [],
          bcc: [],
          replyTo: [],
          date: "2026-03-25T09:30:00.000Z",
          internalDate: "2026-03-25T09:30:00.000Z",
          isRead: false,
          isStarred: false,
          flags: [],
          preview: "Calendar invite attached",
          hasAttachments: true,
          attachments: [{ filename: "invite.ics", contentType: "text/calendar", kind: "calendar", isCalendarInvite: true }],
          labels: [],
        },
      ],
    });

    const invoices = await service.findDocumentThreads({ category: "invoice", limit: 10 });
    const calendars = await service.findDocumentThreads({ category: "calendar", limit: 10 });

    assert.equal(invoices.total, 1);
    assert.equal(invoices.threads[0].documents[0].filename, "invoice.pdf");
    assert.equal(calendars.total, 1);
    assert.equal(calendars.threads[0].documents[0].filename, "invite.ics");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("meeting prep filters threads by domain and exposes latest inbound context", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-meeting-prep-test-"));
  const service = new LocalIndexService(createConfig(dataDir));

  try {
    await service.recordSnapshot({
      syncedAt: "2026-03-25T10:00:00.000Z",
      folders: [
        {
          path: "INBOX",
          name: "INBOX",
          delimiter: "/",
          specialUse: "\\Inbox",
          listed: true,
          subscribed: true,
          flags: [],
          messages: 2,
          unseen: 1,
        },
      ],
      folderStats: [{ folder: "INBOX", fetched: 2, total: 2, strategy: "recent" }],
      emails: [
        {
          id: "INBOX::41",
          folder: "INBOX",
          uid: 41,
          seq: 41,
          messageId: "<root@partner.com>",
          subject: "Partner kickoff",
          from: [{ address: "alice@partner.com" }],
          to: [{ address: "owner@example.com" }],
          cc: [],
          bcc: [],
          replyTo: [],
          date: "2026-03-25T08:00:00.000Z",
          internalDate: "2026-03-25T08:00:00.000Z",
          isRead: false,
          isStarred: false,
          flags: [],
          preview: "Can we meet tomorrow?",
          hasAttachments: false,
          attachments: [],
          labels: [],
        },
        {
          id: "INBOX::42",
          folder: "INBOX",
          uid: 42,
          seq: 42,
          messageId: "<reply@partner.com>",
          inReplyTo: "<root@partner.com>",
          references: ["<root@partner.com>"],
          subject: "Re: Partner kickoff",
          from: [{ address: "owner@example.com" }],
          to: [{ address: "alice@partner.com" }],
          cc: [],
          bcc: [],
          replyTo: [],
          date: "2026-03-25T09:00:00.000Z",
          internalDate: "2026-03-25T09:00:00.000Z",
          isRead: true,
          isStarred: false,
          flags: ["\\Seen"],
          preview: "Tomorrow works for me.",
          hasAttachments: false,
          attachments: [],
          labels: [],
        },
      ],
    });

    const prep = await service.getMeetingPrep({ domain: "partner.com", limit: 10 });

    assert.equal(prep.totalThreads, 1);
    assert.equal(prep.latestInbound[0].emailId, "INBOX::41");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("getThreads and getThreadById find a thread beyond the DEFAULT_SNAPSHOT_LIMIT-capped snapshot", async () => {
  // Regression test for the P2 finding: loadSnapshot() caps snapshot.messages at
  // 5000 (newest-first), and getThreads()/getThreadById() used to build their view
  // purely from that capped array. A folder with more than 5000 messages made both
  // silently blind to anything entirely outside the newest 5000 — search() (which
  // queries SQL directly) still found it, but getThreads() returned total:0 and a
  // threadId valid before the index grew past 5000 started throwing "Thread not
  // found" afterward, even though the thread's messages were still fully in SQLite.
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-thread-cap-test-"));
  const service = new LocalIndexService(createConfig(dataDir));

  try {
    const total = 5001;
    // uid 1 is the single oldest message (by internalDate/uid, both ascending with
    // uid) — it sorts dead last under loadSnapshot()'s `ORDER BY internal_date DESC,
    // uid DESC`, so it is always the one message excluded once there are more than
    // DEFAULT_SNAPSHOT_LIMIT (5000) rows.
    const emails = Array.from({ length: total }, (_, i) => {
      const uid = i + 1;
      const isOldest = uid === 1;
      return {
        id: `INBOX::${uid}`,
        folder: "INBOX",
        uid,
        seq: uid,
        messageId: `<msg-${uid}@example.com>`,
        threadId: isOldest ? "old-thread-1" : `thread-${uid}`,
        subject: isOldest ? "oldneedle archival report" : `Routine update ${uid}`,
        from: [{ address: "sender@example.com" }],
        to: [{ address: "owner@example.com" }],
        cc: [],
        bcc: [],
        replyTo: [],
        date: `2026-01-01T00:${String(uid % 60).padStart(2, "0")}:00.000Z`,
        internalDate: new Date(2026, 0, 1, 0, 0, uid).toISOString(),
        isRead: true,
        isStarred: false,
        flags: [],
        preview: isOldest ? "Contains oldneedle for search regression coverage" : "Body",
        hasAttachments: false,
        attachments: [],
        labels: [],
      };
    });

    await service.recordSnapshot({
      syncedAt: "2026-09-08T00:00:00.000Z",
      folders: [
        {
          path: "INBOX",
          name: "INBOX",
          delimiter: "/",
          specialUse: "\\Inbox",
          listed: true,
          subscribed: true,
          flags: [],
          messages: total,
          unseen: 0,
        },
      ],
      folderStats: [{ folder: "INBOX", fetched: total, total, strategy: "full" }],
      emails,
    });

    // Sanity: plain search() (SQL-direct) already finds the old message.
    const searchResult = await service.search({ query: "oldneedle", limit: 10 });
    assert.equal(searchResult.total, 1, "search() should find the message beyond the 5000-message cap");
    assert.equal(searchResult.emails[0].id, "INBOX::1");

    // getThreads() must now find it too, instead of returning total:0.
    const threadsResult = await service.getThreads({ query: "oldneedle", limit: 10 });
    assert.equal(threadsResult.total, 1, "getThreads() should find the thread beyond the 5000-message cap");
    assert.equal(threadsResult.threads[0].id, "imap:old-thread-1");

    // getThreadById() for that thread id must resolve without throwing, even though
    // its only message is entirely outside the newest 5000.
    const detail = await service.getThreadById("imap:old-thread-1");
    assert.equal(detail.messages.length, 1);
    assert.equal(detail.messages[0].primaryEmailId, "INBOX::1");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("getSyncCheckpointMap reads sync_state directly without touching the messages table", async () => {
  // Regression test for the Performance finding: getSyncCheckpointMap() used to call
  // loadSnapshot(), which also fetched and deserialized up to 5000 message rows via
  // rowToEmailSummary() even though this method only ever reads snapshot.syncCheckpoints.
  // Prove the narrow path never touches messages at all by dropping the messages table
  // out from under the index after indexing: any code path that queries it would throw.
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-checkpoint-narrow-test-"));
  const service = new LocalIndexService(createConfig(dataDir));

  try {
    await service.recordSnapshot({
      syncedAt: "2026-09-08T00:00:00.000Z",
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
          unseen: 0,
        },
      ],
      folderStats: [{ folder: "INBOX", fetched: 1, total: 1, strategy: "full" }],
      emails: [
        {
          id: "INBOX::1",
          folder: "INBOX",
          uid: 1,
          seq: 1,
          messageId: "<msg-1@example.com>",
          subject: "Hello",
          from: [{ address: "sender@example.com" }],
          to: [{ address: "owner@example.com" }],
          cc: [],
          bcc: [],
          replyTo: [],
          date: "2026-09-08T00:00:00.000Z",
          internalDate: "2026-09-08T00:00:00.000Z",
          isRead: true,
          isStarred: false,
          flags: [],
          preview: "Body",
          hasAttachments: false,
          attachments: [],
          labels: [],
        },
      ],
    });

    // Confirm the checkpoint exists via the normal path first.
    const before = await service.getSyncCheckpointMap();
    assert.equal(before.INBOX.strategy, "full");

    // Corrupt the messages table (via a second connection) so any query against it
    // throws — while sync_state is left completely intact.
    const raw = new Database(join(dataDir, "mail-index.sqlite"));
    raw.exec(`DROP TABLE messages`);
    raw.close();

    // getSyncCheckpointMap() must still succeed: it never queries the messages table.
    const after = await service.getSyncCheckpointMap();
    assert.equal(after.INBOX.strategy, "full");
    assert.equal(after.INBOX.fetched, 1);

    // Contrast: a path that genuinely needs message rows now fails, proving the
    // dropped table would have broken getSyncCheckpointMap() too if it still used it.
    await assert.rejects(() => service.getThreads({}));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

function referenceLinkedThreadEmails() {
  return [
    {
      id: "INBOX::1",
      folder: "INBOX",
      uid: 1,
      seq: 1,
      messageId: "<root@example.com>",
      subject: "Thread topic",
      from: [{ address: "alice@example.com" }],
      to: [{ address: "owner@example.com" }],
      cc: [],
      bcc: [],
      replyTo: [],
      date: "2026-03-24T11:00:00.000Z",
      internalDate: "2026-03-24T11:00:00.000Z",
      isRead: false,
      isStarred: false,
      flags: [],
      preview: "First note",
      hasAttachments: false,
      attachments: [],
      labels: [],
    },
    {
      id: "INBOX::2",
      folder: "INBOX",
      uid: 2,
      seq: 2,
      messageId: "<reply@example.com>",
      inReplyTo: "<root@example.com>",
      references: ["<root@example.com>"],
      subject: "Re: Thread topic",
      from: [{ address: "bob@example.com" }],
      to: [{ address: "owner@example.com" }],
      cc: [],
      bcc: [],
      replyTo: [],
      date: "2026-03-24T11:05:00.000Z",
      internalDate: "2026-03-24T11:05:00.000Z",
      isRead: false,
      isStarred: false,
      flags: [],
      preview: "Reply from bob",
      hasAttachments: false,
      attachments: [],
      labels: [],
    },
  ];
}

test("filtering a References-linked thread does not change its id or drop messages (Finding 1)", async () => {
  // Regression test for the P2 finding: loadThreadCandidateMessages() expanded
  // native thread_id membership unbounded, but did nothing for a thread grouped
  // only via References/In-Reply-To (no persisted thread_id) — a filtered query
  // matching only SOME of that thread's messages built an INCOMPLETE thread with
  // a DIFFERENT synthetic id than an unfiltered build, and getThreadById() for
  // that divergent id then threw "Thread not found".
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-thread-ref-filter-test-"));
  const service = new LocalIndexService(createConfig(dataDir));

  try {
    await service.recordSnapshot({
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
          messages: 2,
          unseen: 2,
        },
      ],
      folderStats: [{ folder: "INBOX", fetched: 2, total: 2, strategy: "recent" }],
      emails: referenceLinkedThreadEmails(),
    });

    const unfiltered = await service.getThreads({ limit: 10 });
    assert.equal(unfiltered.total, 1);
    assert.equal(unfiltered.threads[0].messageCount, 2);
    const unfilteredId = unfiltered.threads[0].id;

    // Only INBOX::2 (bob's reply) matches this query — the SQL candidate set is
    // an incomplete view of the thread.
    const filtered = await service.getThreads({ query: "bob@example.com", limit: 10 });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.threads[0].id, unfilteredId, "filtering must not change the thread's id");
    assert.equal(filtered.threads[0].messageCount, 2, "filtering must not drop the thread's other messages");

    const detail = await service.getThreadById(filtered.threads[0].id);
    assert.deepEqual(
      detail.messages.map((message) => message.primaryEmailId).sort(),
      ["INBOX::1", "INBOX::2"],
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("getThreadById resolves a References-linked thread beyond the DEFAULT_SNAPSHOT_LIMIT cap (Finding 2)", async () => {
  // Regression test for the P2 finding: the imap:<thread_id> path was already
  // fixed to query messages.thread_id directly (unbounded), but the fallback
  // path for References/In-Reply-To-based ids still resolved threads from the
  // DEFAULT_SNAPSHOT_LIMIT-capped snapshot, so a fallback thread entirely
  // outside the newest 5000 messages stayed unreachable via getThreadById().
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-thread-ref-cap-test-"));
  const service = new LocalIndexService(createConfig(dataDir));

  try {
    const oldPair = [
      {
        id: "INBOX::old-root",
        folder: "INBOX",
        uid: 1,
        seq: 1,
        messageId: "<old-root@example.com>",
        subject: "oldrefneedle report",
        from: [{ address: "alice@example.com" }],
        to: [{ address: "owner@example.com" }],
        cc: [],
        bcc: [],
        replyTo: [],
        date: "2026-01-01T00:00:01.000Z",
        internalDate: new Date(2026, 0, 1, 0, 0, 1).toISOString(),
        isRead: true,
        isStarred: false,
        flags: [],
        preview: "Contains oldrefneedle for regression coverage",
        hasAttachments: false,
        attachments: [],
        labels: [],
      },
      {
        id: "INBOX::old-reply",
        folder: "INBOX",
        uid: 2,
        seq: 2,
        messageId: "<old-reply@example.com>",
        inReplyTo: "<old-root@example.com>",
        references: ["<old-root@example.com>"],
        subject: "Re: oldrefneedle report",
        from: [{ address: "bob@example.com" }],
        to: [{ address: "owner@example.com" }],
        cc: [],
        bcc: [],
        replyTo: [],
        date: "2026-01-01T00:00:02.000Z",
        internalDate: new Date(2026, 0, 1, 0, 0, 2).toISOString(),
        isRead: true,
        isStarred: false,
        flags: [],
        preview: "Reply to oldrefneedle",
        hasAttachments: false,
        attachments: [],
        labels: [],
      },
    ];

    // 5000 unrelated, natively-threaded, more-recent messages so the reference-
    // linked pair above sorts dead last under the capped snapshot's `ORDER BY
    // internal_date DESC, uid DESC` and is fully excluded from it.
    const recentEmails = Array.from({ length: 5000 }, (_, i) => {
      const uid = i + 3;
      return {
        id: `INBOX::${uid}`,
        folder: "INBOX",
        uid,
        seq: uid,
        messageId: `<msg-${uid}@example.com>`,
        threadId: `thread-${uid}`,
        subject: `Routine update ${uid}`,
        from: [{ address: "sender@example.com" }],
        to: [{ address: "owner@example.com" }],
        cc: [],
        bcc: [],
        replyTo: [],
        date: `2026-02-01T00:${String(uid % 60).padStart(2, "0")}:00.000Z`,
        internalDate: new Date(2026, 1, 1, 0, 0, uid).toISOString(),
        isRead: true,
        isStarred: false,
        flags: [],
        preview: "Body",
        hasAttachments: false,
        attachments: [],
        labels: [],
      };
    });

    const emails = [...oldPair, ...recentEmails];

    await service.recordSnapshot({
      syncedAt: "2026-09-08T00:00:00.000Z",
      folders: [
        {
          path: "INBOX",
          name: "INBOX",
          delimiter: "/",
          specialUse: "\\Inbox",
          listed: true,
          subscribed: true,
          flags: [],
          messages: emails.length,
          unseen: 0,
        },
      ],
      folderStats: [{ folder: "INBOX", fetched: emails.length, total: emails.length, strategy: "full" }],
      emails,
    });

    const searchResult = await service.getThreads({ query: "oldrefneedle", limit: 10 });
    assert.equal(searchResult.total, 1, "getThreads() should find the reference-linked thread beyond the cap");
    assert.equal(searchResult.threads[0].messageCount, 2);
    const referenceThreadId = searchResult.threads[0].id;

    // getThreadById() for that id must resolve without throwing, even though both
    // of its messages are entirely outside the newest 5000.
    const detail = await service.getThreadById(referenceThreadId);
    assert.deepEqual(
      detail.messages.map((message) => message.primaryEmailId).sort(),
      ["INBOX::old-reply", "INBOX::old-root"],
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("getThreads() and getThreadById() agree on thread identity for a mix of native and fallback threads", async () => {
  // Round-trip regression test: for a mix of natively-threaded and
  // References-linked threads, every id getThreads() returns (filtered or not)
  // must resolve via getThreadById() to the same complete membership.
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-thread-roundtrip-test-"));
  const service = new LocalIndexService(createConfig(dataDir));

  try {
    const nativeThread = [
      {
        id: "INBOX::native-1",
        folder: "INBOX",
        uid: 101,
        seq: 101,
        messageId: "<native-a@example.com>",
        threadId: "native-thread",
        subject: "Native topic",
        from: [{ address: "carol@example.com" }],
        to: [{ address: "owner@example.com" }],
        cc: [],
        bcc: [],
        replyTo: [],
        date: "2026-04-01T10:00:00.000Z",
        internalDate: "2026-04-01T10:00:00.000Z",
        isRead: true,
        isStarred: false,
        flags: [],
        preview: "Native first",
        hasAttachments: false,
        attachments: [],
        labels: [],
      },
      {
        id: "INBOX::native-2",
        folder: "INBOX",
        uid: 102,
        seq: 102,
        messageId: "<native-b@example.com>",
        threadId: "native-thread",
        subject: "Re: Native topic",
        from: [{ address: "owner@example.com" }],
        to: [{ address: "carol@example.com" }],
        cc: [],
        bcc: [],
        replyTo: [],
        date: "2026-04-01T10:05:00.000Z",
        internalDate: "2026-04-01T10:05:00.000Z",
        isRead: true,
        isStarred: false,
        flags: [],
        preview: "Native second",
        hasAttachments: false,
        attachments: [],
        labels: [],
      },
    ];

    const standaloneMessage = [
      {
        id: "INBOX::solo",
        folder: "INBOX",
        uid: 103,
        seq: 103,
        messageId: "<solo@example.com>",
        subject: "Standalone note",
        from: [{ address: "dave@example.com" }],
        to: [{ address: "owner@example.com" }],
        cc: [],
        bcc: [],
        replyTo: [],
        date: "2026-04-01T10:10:00.000Z",
        internalDate: "2026-04-01T10:10:00.000Z",
        isRead: true,
        isStarred: false,
        flags: [],
        preview: "No relations",
        hasAttachments: false,
        attachments: [],
        labels: [],
      },
    ];

    const emails = [...referenceLinkedThreadEmails(), ...nativeThread, ...standaloneMessage];

    await service.recordSnapshot({
      syncedAt: "2026-04-01T12:00:00.000Z",
      folders: [
        {
          path: "INBOX",
          name: "INBOX",
          delimiter: "/",
          specialUse: "\\Inbox",
          listed: true,
          subscribed: true,
          flags: [],
          messages: emails.length,
          unseen: 0,
        },
      ],
      folderStats: [{ folder: "INBOX", fetched: emails.length, total: emails.length, strategy: "full" }],
      emails,
    });

    const unfiltered = await service.getThreads({ limit: 50 });
    assert.equal(unfiltered.total, 3);
    const completeCountsById = new Map(unfiltered.threads.map((thread) => [thread.id, thread.messageCount]));

    // Filter down to a query that only SQL-matches one message from the
    // reference-linked thread and one message from the native thread.
    const filtered = await service.getThreads({ query: "bob@example.com", limit: 50 });
    assert.equal(filtered.total, 1);

    for (const roundTripped of [unfiltered, filtered]) {
      for (const thread of roundTripped.threads) {
        const detail = await service.getThreadById(thread.id);
        assert.equal(
          detail.messageCount,
          completeCountsById.get(thread.id),
          `getThreadById(${thread.id}) should return the same complete membership as the unfiltered view`,
        );
      }
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

function uidMigrationFolderInfo() {
  return {
    path: "INBOX",
    name: "INBOX",
    delimiter: "/",
    specialUse: "\\Inbox",
    listed: true,
    subscribed: true,
    flags: [],
    messages: 1,
    unseen: 1,
  };
}

function uidMigrationBaseEmail(id) {
  return {
    id,
    folder: "INBOX",
    uid: 42,
    seq: 42,
    messageId: "<uid42@example.com>",
    subject: "Migration test",
    from: [{ address: "person@example.com" }],
    to: [{ address: "owner@example.com" }],
    cc: [],
    bcc: [],
    replyTo: [],
    date: "2026-04-05T09:00:00.000Z",
    internalDate: "2026-04-05T09:00:00.000Z",
    isStarred: false,
    flags: [],
    hasAttachments: false,
    attachments: [],
    labels: [],
  };
}

test("recordSnapshot reconciles an old-format id row into the new UIDVALIDITY-embedding id for the same physical message", async () => {
  // Reproduces the exact bug: UID 42 was indexed under the pre-UIDVALIDITY-fix
  // 3-field id (folder::uid::checksum). A later sync — same folder, same uid,
  // same generation — now mints the 4-field id (folder::uidValidity::uid::
  // checksum) via the current createEmailId. Without reconciliation this is a
  // brand-new primary key as far as ON CONFLICT(email_id) is concerned, so a
  // second row appears for one physical message.
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-id-migration-test-"));
  const service = new LocalIndexService(createConfig(dataDir));

  const oldFormatId = createEmailId("INBOX", 42); // legacy 3-field id, no uidValidity
  const newFormatId = createEmailId("INBOX", 42, "2000000002"); // current 4-field id, same message

  try {
    // First sync: indexed under the old id format, unread, with a body.
    await service.recordSnapshot({
      syncedAt: "2026-04-05T10:00:00.000Z",
      folders: [uidMigrationFolderInfo()],
      folderStats: [{ folder: "INBOX", fetched: 1, total: 1, strategy: "recent" }],
      emails: [{ ...uidMigrationBaseEmail(oldFormatId), isRead: false, preview: "body contains oldsecret" }],
    });

    let status = await service.getStatus();
    assert.equal(status.storedMessageCount, 1);

    // Second sync: the SAME uid, now indexed via the current id-producing
    // path (new 4-field id) — a metadata-only refresh (isRead flips, no body
    // re-fetched), which is exactly how a routine flags sync behaves.
    status = await service.recordSnapshot({
      syncedAt: "2026-04-05T10:05:00.000Z",
      folders: [uidMigrationFolderInfo()],
      folderStats: [{ folder: "INBOX", fetched: 1, total: 1, strategy: "incremental_window" }],
      emails: [{ ...uidMigrationBaseEmail(newFormatId), isRead: true, preview: undefined }],
    });

    assert.equal(status.storedMessageCount, 1, "the id-format upgrade must not create a duplicate row");

    const byOldId = await service.search({ query: undefined, folder: "INBOX", limit: 10 });
    const rows = byOldId.emails.filter((email) => email.uid === 42);
    assert.equal(rows.length, 1, "exactly one row should exist for this physical message");
    assert.equal(rows[0].id, newFormatId, "the surviving row should be keyed by the new-format id");
    assert.equal(rows[0].isRead, true, "the metadata refresh must be reflected");
    assert.equal(
      rows[0].preview,
      "body contains oldsecret",
      "body content captured under the old id must not be lost by the migration",
    );

    // FTS must reflect the merged single row: searchable under the new id,
    // and the old id's FTS entry must be gone (not a leftover duplicate).
    const ftsResult = await service.search({ query: "oldsecret", folder: "INBOX", limit: 10 });
    assert.equal(ftsResult.emails.length, 1, "full-text search must return exactly one match, not two");
    assert.equal(ftsResult.emails[0].id, newFormatId, "full-text search must find the message under its new id");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("recordSnapshot reconciles an old 2-field (pre-checksum) id row into the new UIDVALIDITY-embedding id for the same physical message", async () => {
  // Reproduces the P2 bug: a row is STILL stored under the oldest 2-field id
  // shape (folder::uid, no checksum at all — from before the checksum was
  // introduced), e.g. an index that predates the checksum feature and was
  // never fully re-synced for this folder. The 3-field migration check alone
  // never finds this row, so a genuine duplicate appears: the ancient
  // 2-field row plus a new 4-field row for the same physical message.
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-2field-id-migration-test-"));
  const service = new LocalIndexService(createConfig(dataDir));

  const oldFormatId2Field = "INBOX::42"; // legacy 2-field id, no checksum, no uidValidity
  const newFormatId = createEmailId("INBOX", 42, "2000000002"); // current 4-field id, same message

  try {
    // Prime the schema, then manually insert a row under the 2-field id —
    // simulating a pre-checksum index that was never re-synced for this UID.
    await service.recordSnapshot({
      syncedAt: "2026-04-05T09:00:00.000Z",
      folders: [uidMigrationFolderInfo()],
      folderStats: [{ folder: "INBOX", fetched: 0, total: 0, strategy: "recent" }],
      emails: [],
    });

    const raw = new Database(join(dataDir, "mail-index.sqlite"));
    raw
      .prepare(
        `INSERT INTO messages (
          email_id, folder, uid, seq, references_json, subject, from_json, to_json, cc_json, bcc_json,
          reply_to_json, is_read, is_starred, flags_json, preview, has_attachments, attachments_json, labels_json
        ) VALUES (?, ?, ?, ?, '[]', ?, '[]', '[]', '[]', '[]', '[]', ?, 0, '[]', ?, 0, '[]', '[]')`,
      )
      .run(oldFormatId2Field, "INBOX", 42, 42, "Hello", 0, "body contains oldsecret");
    raw.close();

    let status = await service.getStatus();
    assert.equal(status.storedMessageCount, 1);

    // A later sync — same folder, same uid, same generation — now mints the
    // current 4-field id, as a metadata-only refresh (isRead flips, no body
    // re-fetched).
    status = await service.recordSnapshot({
      syncedAt: "2026-04-05T10:05:00.000Z",
      folders: [uidMigrationFolderInfo()],
      folderStats: [{ folder: "INBOX", fetched: 1, total: 1, strategy: "incremental_window" }],
      emails: [{ ...uidMigrationBaseEmail(newFormatId), isRead: true, preview: undefined }],
    });

    assert.equal(status.storedMessageCount, 1, "the 2-field id-format upgrade must not create a duplicate row");

    const result = await service.search({ query: undefined, folder: "INBOX", limit: 10 });
    const rows = result.emails.filter((email) => email.uid === 42);
    assert.equal(rows.length, 1, "exactly one row should exist for this physical message");
    assert.equal(rows[0].id, newFormatId, "the surviving row should be keyed by the new-format id");
    assert.equal(rows[0].isRead, true, "the metadata refresh must be reflected");
    assert.equal(
      rows[0].preview,
      "body contains oldsecret",
      "body content captured under the old 2-field id must not be lost by the migration",
    );

    const ftsResult = await service.search({ query: "oldsecret", folder: "INBOX", limit: 10 });
    assert.equal(ftsResult.emails.length, 1, "full-text search must return exactly one match, not two");
    assert.equal(ftsResult.emails[0].id, newFormatId, "full-text search must find the message under its new id");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("recordSnapshot converges to one row when BOTH a 2-field and a 3-field legacy row exist for the same physical message", async () => {
  // Genuinely degenerate case: an index partially migrated through both
  // legacy stages (e.g. it upgraded 2-field -> 3-field for some other UID
  // range, or the checksum feature landed then UIDVALIDITY-embedding landed
  // before this exact UID was ever re-synced under either). Both the
  // 2-field and 3-field rows exist simultaneously for the same (folder, uid).
  // This must still converge to exactly one surviving row under the new
  // 4-field id, not crash and not leave a triple-duplicate.
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-both-legacy-formats-test-"));
  const service = new LocalIndexService(createConfig(dataDir));

  const oldFormatId2Field = "INBOX::42";
  const oldFormatId3Field = createEmailId("INBOX", 42); // legacy 3-field id, no uidValidity
  const newFormatId = createEmailId("INBOX", 42, "2000000002");

  try {
    await service.recordSnapshot({
      syncedAt: "2026-04-05T09:00:00.000Z",
      folders: [uidMigrationFolderInfo()],
      folderStats: [{ folder: "INBOX", fetched: 0, total: 0, strategy: "recent" }],
      emails: [],
    });

    const raw = new Database(join(dataDir, "mail-index.sqlite"));
    raw
      .prepare(
        `INSERT INTO messages (
          email_id, folder, uid, seq, references_json, subject, from_json, to_json, cc_json, bcc_json,
          reply_to_json, is_read, is_starred, flags_json, preview, has_attachments, attachments_json, labels_json
        ) VALUES (?, ?, ?, ?, '[]', ?, '[]', '[]', '[]', '[]', '[]', ?, 0, '[]', ?, 0, '[]', '[]')`,
      )
      .run(oldFormatId2Field, "INBOX", 42, 42, "Hello", 0, "oldest 2-field content");
    raw
      .prepare(
        `INSERT INTO messages (
          email_id, folder, uid, seq, references_json, subject, from_json, to_json, cc_json, bcc_json,
          reply_to_json, is_read, is_starred, flags_json, preview, has_attachments, attachments_json, labels_json
        ) VALUES (?, ?, ?, ?, '[]', ?, '[]', '[]', '[]', '[]', '[]', ?, 0, '[]', ?, 0, '[]', '[]')`,
      )
      .run(oldFormatId3Field, "INBOX", 42, 42, "Hello", 0, "3-field content");
    raw.close();

    let status = await service.getStatus();
    assert.equal(status.storedMessageCount, 2, "sanity: both degenerate legacy rows exist before the fixing sync");

    status = await service.recordSnapshot({
      syncedAt: "2026-04-05T10:05:00.000Z",
      folders: [uidMigrationFolderInfo()],
      folderStats: [{ folder: "INBOX", fetched: 1, total: 1, strategy: "incremental_window" }],
      emails: [{ ...uidMigrationBaseEmail(newFormatId), isRead: true, preview: undefined }],
    });

    assert.equal(
      status.storedMessageCount,
      1,
      "both legacy rows must be reconciled away, converging to exactly one row",
    );

    const result = await service.search({ query: undefined, folder: "INBOX", limit: 10 });
    const rows = result.emails.filter((email) => email.uid === 42);
    assert.equal(rows.length, 1, "exactly one row should exist for this physical message");
    assert.equal(rows[0].id, newFormatId, "the surviving row should be keyed by the new-format id");
    // 3-field is checked first (documented as the more likely/recent state),
    // so its content wins when both legacy rows carry content.
    assert.equal(
      rows[0].preview,
      "3-field content",
      "the more-recent legacy format's content should win when both exist",
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("recordSnapshot does not merge a genuine UIDVALIDITY change that reuses a UID for a different message", async () => {
  // A real UIDVALIDITY change means the server's UID numbering restarted —
  // uid 42 in the new generation is NOT the same physical message as uid 42
  // in the old generation, even though the id-migration reconciliation above
  // also keys off (folder, uid). This must stay handled by the existing
  // UIDVALIDITY-changed-folder wipe, not be merged by the new logic.
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-uidvalidity-reuse-test-"));
  const service = new LocalIndexService(createConfig(dataDir));

  const generationOneId = createEmailId("INBOX", 42, "1000000001");
  const generationTwoId = createEmailId("INBOX", 42, "2000000002");

  try {
    await service.recordSnapshot({
      syncedAt: "2026-04-05T10:00:00.000Z",
      folders: [uidMigrationFolderInfo()],
      folderStats: [
        { folder: "INBOX", fetched: 1, total: 1, strategy: "full", uidValidity: "1000000001", rangeStartUid: 1, rangeEndUid: 100 },
      ],
      emails: [{ ...uidMigrationBaseEmail(generationOneId), isRead: false, preview: "generation one secret" }],
    });

    let status = await service.getStatus();
    assert.equal(status.storedMessageCount, 1);

    // Genuine UIDVALIDITY change: a different message now legitimately reuses uid 42.
    status = await service.recordSnapshot({
      syncedAt: "2026-04-05T11:00:00.000Z",
      folders: [uidMigrationFolderInfo()],
      folderStats: [
        { folder: "INBOX", fetched: 1, total: 1, strategy: "full", uidValidity: "2000000002", rangeStartUid: 1, rangeEndUid: 100 },
      ],
      emails: [{ ...uidMigrationBaseEmail(generationTwoId), isRead: false, preview: "generation two content" }],
    });

    assert.equal(
      status.storedMessageCount,
      1,
      "the existing UIDVALIDITY-changed-folder cleanup should replace, not accumulate, rows",
    );

    const result = await service.search({ query: undefined, folder: "INBOX", limit: 10 });
    const rows = result.emails.filter((email) => email.uid === 42);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, generationTwoId);
    assert.equal(
      rows[0].preview,
      "generation two content",
      "the new generation's content must not be contaminated by the old generation's",
    );

    const staleSearch = await service.search({ query: "generation one secret", folder: "INBOX", limit: 10 });
    assert.equal(staleSearch.emails.length, 0, "the old generation's content must not still be searchable");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
