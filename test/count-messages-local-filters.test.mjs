import test from "node:test";
import assert from "node:assert/strict";
import { SimpleIMAPService } from "../dist/services/simple-imap-service.js";

// Found live: count_messages ignored hasAttachment, senderDomain, label and threadId — IMAP
// SEARCH can't express them, and countMessages only ran SEARCH — so every call returned the
// unfiltered folder total (98 in INBOX) while search_emails with the same filters returned
// 28 (hasAttachment) and 1 (senderDomain).

function createConfig() {
  return {
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "o@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "o@example.com", password: "x" },
    dataDir: "/tmp/count-messages-local-filters-test",
    debug: false,
    runtime: {},
  };
}

const MESSAGES = [
  { uid: 1, from: "a@cognition.ai", attachment: true, labels: ["Work"], threadId: "t-1" },
  { uid: 2, from: "b@cognition.ai", attachment: false, labels: [], threadId: "t-1" },
  { uid: 3, from: "c@not-cognition.com", attachment: true, labels: [], threadId: "t-2" },
  { uid: 4, from: "d@example.org", attachment: false, labels: ["Work"], threadId: "t-3" },
  { uid: 5, from: "e@example.org", attachment: false, labels: [], threadId: "t-4" },
];

function createService() {
  const service = new SimpleIMAPService(createConfig());
  const byUid = new Map(MESSAGES.map((m) => [m.uid, m]));
  const client = {
    mailbox: { path: "INBOX", exists: MESSAGES.length },
    search: async () => MESSAGES.map((m) => m.uid),
    async *fetch(uids) {
      for (const uid of uids) {
        const m = byUid.get(uid);
        if (!m) continue;
        const [mailbox, host] = m.from.split("@");
        yield {
          uid,
          seq: uid,
          threadId: m.threadId,
          envelope: { subject: `M${uid}`, from: [{ address: m.from, mailbox, host }], to: [], cc: [], bcc: [], replyTo: [] },
          internalDate: new Date(Date.UTC(2026, 0, uid)),
          flags: new Set(),
          labels: new Set(m.labels),
          bodyStructure: m.attachment ? { disposition: "attachment", parameters: { filename: "f.pdf" } } : {},
        };
      }
    },
  };
  service.withMailbox = async (folder, _ro, action) => {
    client.mailbox = { path: folder, exists: MESSAGES.length };
    return action(client);
  };
  return service;
}

test("countMessages without local-only filters still returns the IMAP SEARCH count", async () => {
  assert.equal((await createService().countMessages({ folder: "INBOX" })).count, 5);
});

test("countMessages applies hasAttachment", async () => {
  const service = createService();
  assert.equal((await service.countMessages({ folder: "INBOX", hasAttachment: true })).count, 2);
  assert.equal((await service.countMessages({ folder: "INBOX", hasAttachment: false })).count, 3);
});

test("countMessages applies senderDomain", async () => {
  const service = createService();
  assert.equal((await service.countMessages({ folder: "INBOX", senderDomain: "not-cognition.com" })).count, 1);
  assert.equal((await service.countMessages({ folder: "INBOX", senderDomain: "cognition.ai" })).count, 2);
});

test("countMessages applies label and threadId", async () => {
  const service = createService();
  assert.equal((await service.countMessages({ folder: "INBOX", label: "Work" })).count, 2);
  assert.equal((await service.countMessages({ folder: "INBOX", threadId: "t-1" })).count, 2);
});

test("countMessages combines local-only filters", async () => {
  const service = createService();
  assert.equal((await service.countMessages({ folder: "INBOX", senderDomain: "cognition.ai", hasAttachment: true })).count, 1);
});

test("countMessages agrees with searchEmails for the same local-only filters", async () => {
  const service = createService();
  for (const filters of [{ hasAttachment: true }, { senderDomain: "not-cognition.com" }, { label: "Work" }, { threadId: "t-1" }]) {
    const searched = await service.searchEmails({ folder: "INBOX", limit: 50, ...filters });
    const counted = await service.countMessages({ folder: "INBOX", ...filters });
    assert.equal(counted.count, searched.emails.length, JSON.stringify(filters));
  }
});

test("countMessages applies attachmentName and mailboxRole too", async () => {
  const service = createService();
  assert.equal((await service.countMessages({ folder: "INBOX", attachmentName: "f.pdf" })).count, 2);
  assert.equal((await service.countMessages({ folder: "INBOX", attachmentName: "nothing-like-this" })).count, 0);
  assert.equal((await service.countMessages({ folder: "INBOX", mailboxRole: "inbox" })).count, 5);
  assert.equal((await service.countMessages({ folder: "INBOX", mailboxRole: "trash" })).count, 0);
});
