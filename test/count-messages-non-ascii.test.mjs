import test from "node:test";
import assert from "node:assert/strict";
import { SimpleIMAPService } from "../dist/services/simple-imap-service.js";

// Bridge's IMAP SEARCH never matches a non-ASCII value, so count_messages("from: Pelcová")
// returned 0 for mail that plainly has that sender (search_emails already worked around it).
// The mock client behaves like Bridge: a non-ASCII value in the SEARCH query matches nothing;
// the ASCII narrowing the service sends instead returns every candidate that contains it.

function createConfig() {
  return {
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "o@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "o@example.com", password: "x" },
    dataDir: "/tmp/count-messages-non-ascii-test",
    debug: false,
    runtime: {},
  };
}

const MESSAGES = [
  { uid: 1, name: "Jana Pelcová", addr: "pelcova@firma.cz", subject: "Faktura", body: "Dobrý den" },
  { uid: 2, name: "JAN PELCOVA", addr: "jan@other.cz", subject: "Faktura", body: "ahoj" },
  { uid: 3, name: "Ann", addr: "ann@example.com", subject: "Nowe książki w ofercie", body: "lista" },
  { uid: 4, name: "Bob", addr: "bob@example.com", subject: "Ksiazki stare", body: "Rücksendung bestätigt" },
  { uid: 5, name: "Eve", addr: "eve@example.com", subject: "Hello", body: "nothing" },
];

function rfc822(m) {
  return Buffer.from(`From: ${m.name} <${m.addr}>\r\nSubject: ${m.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${m.body}\r\n`);
}

function createService({ total = MESSAGES } = {}) {
  const service = new SimpleIMAPService(createConfig());
  const sent = { queries: [], fetched: 0 };
  const client = {
    mailbox: { path: "INBOX", exists: total.length },
    search: async (query) => {
      sent.queries.push(query);
      const text = JSON.stringify(query);
      if (/[^\x00-\x7f]/.test(text)) return []; // Bridge: non-ASCII never matches
      const needle = (query.from ?? query.subject ?? query.body ?? "").toString().toLowerCase();
      return total.filter((m) => !needle || `${m.name} ${m.addr} ${m.subject} ${m.body}`.toLowerCase().includes(needle)).map((m) => m.uid);
    },
    async *fetch(uids) {
      for (const uid of uids) {
        const m = total.find((x) => x.uid === uid);
        if (!m) continue;
        sent.fetched += 1;
        const [mailbox, host] = m.addr.split("@");
        yield {
          uid, seq: uid,
          envelope: { subject: m.subject, from: [{ name: m.name, address: m.addr, mailbox, host }], to: [], cc: [], bcc: [], replyTo: [] },
          internalDate: new Date(Date.UTC(2026, 0, uid)), flags: new Set(), labels: new Set(), bodyStructure: {}, source: rfc822(m),
        };
      }
    },
  };
  service.withMailbox = async (folder, _ro, action) => action(client);
  return { service, sent };
}

test("count_messages finds a non-ASCII sender, ignoring accents and case", async () => {
  const { service, sent } = createService();
  const result = await service.countMessages({ folder: "INBOX", from: "Pelcová" });
  assert.equal(result.count, 2); // "Pelcová" and the accent-less, upper-case "PELCOVA"
  assert.equal(result.approximate, undefined);
  assert.ok(sent.queries.every((q) => !/[^\x00-\x7f]/.test(JSON.stringify(q))), "no non-ASCII value may be sent to Bridge");
});

test("count_messages folds letters Unicode does not decompose (ł, ą)", async () => {
  const { service } = createService();
  assert.equal((await service.countMessages({ folder: "INBOX", subject: "książki" })).count, 2);
});

test("count_messages matches a non-ASCII free-text query against the body", async () => {
  const { service } = createService();
  assert.equal((await service.countMessages({ folder: "INBOX", query: "Rücksendung" })).count, 1);
});

test("count_messages combines a non-ASCII value with a local-only filter", async () => {
  const { service } = createService();
  assert.equal((await service.countMessages({ folder: "INBOX", from: "Pelcová", senderDomain: "firma.cz" })).count, 1);
});

test("count_messages agrees with search_emails for non-ASCII values", async () => {
  const { service } = createService();
  for (const filters of [{ from: "Pelcová" }, { subject: "książki" }, { query: "Rücksendung" }]) {
    const searched = await service.searchEmails({ folder: "INBOX", limit: 50, ...filters });
    const counted = await service.countMessages({ folder: "INBOX", ...filters });
    assert.equal(counted.count, searched.emails.length, JSON.stringify(filters));
  }
});

test("count_messages says so when only the newest candidates were checked", async () => {
  const many = Array.from({ length: 600 }, (_, i) => ({ uid: i + 1, name: "Jana Pelcová", addr: `p${i}@firma.cz`, subject: "x", body: "y" }));
  const { service } = createService({ total: many });
  const result = await service.countMessages({ folder: "INBOX", from: "Pelcová" });
  assert.equal(result.approximate, true);
  assert.equal(result.count, 500);
});

test("an ASCII-only count still comes straight from SEARCH, with no fetch", async () => {
  const { service, sent } = createService();
  const result = await service.countMessages({ folder: "INBOX", from: "ann" });
  assert.equal(result.count, 1);
  assert.equal(sent.fetched, 0);
  assert.equal(result.approximate, undefined);
});
