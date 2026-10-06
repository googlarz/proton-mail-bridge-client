import test from "node:test";
import assert from "node:assert/strict";
import { SimpleIMAPService } from "../dist/services/simple-imap-service.js";

// Found live: get_emails with sortByUid:"desc" (the default) returned pages sorted by Date
// header, not UID. In a folder whose dates don't track UID order (imports, Trash), a page
// came back UID-scrambled and the order broke across pages and beforeUid cursors, even
// though each page's window is chosen by UID/sequence number.

function createConfig() {
  return {
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "o@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "o@example.com", password: "x" },
    dataDir: "/tmp/get-emails-desc-order-test",
    debug: false,
    runtime: {},
  };
}

// 30 messages; UID n has a date that runs opposite to UID for the older 20 (like an
// imported batch), and with UID for the newest 10.
function dateForUid(uid) {
  return uid > 20
    ? new Date(Date.UTC(2026, 5, 1, 0, uid))
    : new Date(Date.UTC(2025, 0, 1, 0, 100 - uid));
}

function createService(total = 30) {
  const service = new SimpleIMAPService(createConfig());
  const toMessage = (uid) => ({
    uid,
    seq: uid,
    envelope: { subject: `M${uid}`, from: [], to: [], cc: [], bcc: [], replyTo: [], date: dateForUid(uid) },
    internalDate: dateForUid(uid),
    flags: new Set(),
  });
  const client = {
    mailbox: { path: "INBOX", exists: total },
    search: async (query) => {
      const [, hi] = query.uid.split(":").map(Number);
      return Array.from({ length: Math.min(hi, total) }, (_, i) => i + 1);
    },
    async *fetch(range) {
      const uids = typeof range === "string" && range.includes(":")
        ? (() => { const [a, b] = range.split(":").map(Number); return Array.from({ length: b - a + 1 }, (_, i) => a + i); })()
        : String(range).split(",").map(Number);
      // IMAP returns FETCH responses in sequence order, not request order.
      for (const uid of [...uids].sort((a, b) => a - b)) yield toMessage(uid);
    },
  };
  service.withMailbox = async (_folder, _ro, action) => action(client);
  return service;
}

const range = (from, to) => Array.from({ length: from - to + 1 }, (_, i) => from - i);

test("getEmails default (desc) returns each page in strictly descending UID order", async () => {
  const service = createService();
  const page1 = await service.getEmails({ folder: "INBOX", limit: 15, offset: 0 });
  const page2 = await service.getEmails({ folder: "INBOX", limit: 15, offset: 15 });
  assert.deepEqual(page1.emails.map((e) => e.uid), range(30, 16));
  assert.deepEqual(page2.emails.map((e) => e.uid), range(15, 1));
});

test("getEmails(sortByUid:'desc', beforeUid) pages continue the same UID-descending sequence", async () => {
  const service = createService();
  const first = await service.getEmails({ folder: "INBOX", limit: 10, sortByUid: "desc" });
  const cursor = first.emails.at(-1).uid;
  const next = await service.getEmails({ folder: "INBOX", limit: 10, sortByUid: "desc", beforeUid: cursor });
  assert.deepEqual(first.emails.map((e) => e.uid), range(30, 21));
  assert.deepEqual(next.emails.map((e) => e.uid), range(20, 11));
});

test("getEmails with beforeUid 1 (the oldest message's cursor) returns nothing and never asks for the range 1:0", async () => {
  // IMAP ranges are unordered, so "1:0" means "0:1" and would return UID 1 again; a cursor loop that has
  // reached the oldest message would then never end.
  const service = createService();
  const queries = [];
  const original = service.withMailbox;
  service.withMailbox = async (folder, readOnly, action) =>
    original.call(service, folder, readOnly, (client) => action({
      ...client,
      mailbox: client.mailbox,
      search: async (query, options) => { queries.push(query); return client.search(query, options); },
      fetch: (...args) => client.fetch(...args),
    }));
  for (const beforeUid of [1, 0, -5]) {
    const page = await service.getEmails({ folder: "INBOX", limit: 10, sortByUid: "desc", beforeUid });
    assert.deepEqual(page.emails, [], `beforeUid ${beforeUid}`);
  }
  assert.deepEqual(queries.filter((q) => String(q.uid) === "1:0" || String(q.uid) === "1:-1"), []);
});
