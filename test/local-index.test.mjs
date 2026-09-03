import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalIndexService } from "../dist/services/local-index-service.js";

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
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("search surfaces a warning instead of silently returning empty when the query has no searchable terms", async () => {
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

    // Every token is either a bare FTS5 operator or a leading-hyphen negation, so
    // no safe search term survives — this must warn, not silently return empty.
    const result = await service.search({ query: "NOT AND -foo", limit: 10 });

    assert.equal(result.total, 0);
    assert.ok(Array.isArray(result.warnings) && result.warnings.length === 1);
    assert.match(result.warnings[0], /no searchable terms/i);
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
