import test from "node:test";
import assert from "node:assert/strict";
import { SimpleIMAPService } from "../dist/services/simple-imap-service.js";
import { asciiNarrowing, foldSearchText, hasNonAscii, matchesNonAsciiCriteria, splitNonAsciiCriteria } from "../dist/utils/helpers.js";

// Proton Bridge's IMAP SEARCH never matches a non-ASCII value (checked live against a real Bridge:
// "Pelcová", "für", "książki", "Prägung" -> nothing, even for mail that contains them). Such criteria
// are narrowed to their longest ASCII run and verified locally, ignoring accents and case.

test("hasNonAscii / foldSearchText / asciiNarrowing", () => {
  assert.equal(hasNonAscii("Pelcova"), false);
  assert.equal(hasNonAscii("Pelcová"), true);
  assert.equal(foldSearchText("Pelcová"), "pelcova");
  assert.equal(foldSearchText("Książki Łódź Straße Prägung"), "ksiazki lodz strasse pragung");
  assert.equal(asciiNarrowing("Pelcová"), "Pelcov");
  assert.equal(asciiNarrowing("Rücksendung"), "cksendung");
  assert.equal(asciiNarrowing("żż"), "", "nothing usable -> criterion is dropped from the IMAP query");
  assert.equal(asciiNarrowing("ża"), "", "a single character is too broad to send");
});

test("splitNonAsciiCriteria leaves ASCII-only searches untouched", () => {
  const input = { from: "alice", subject: "invoice", limit: 5 };
  const { imapInput, criteria } = splitNonAsciiCriteria(input);
  assert.deepEqual(imapInput, input);
  assert.equal(criteria, undefined);
});

test("splitNonAsciiCriteria narrows the IMAP side and keeps the original for local verification", () => {
  const { imapInput, criteria } = splitNonAsciiCriteria({ from: "Pelcová", subject: "żż", query: "Prägung", to: "bob" });
  assert.deepEqual(imapInput, { from: "Pelcov", query: "gung", to: "bob" });
  assert.deepEqual(criteria, { from: "Pelcová", subject: "żż", query: "Prägung" });
});

const mail = (over) => ({
  id: "INBOX::1", folder: "INBOX", uid: 1, subject: "", from: [], to: [], cc: [], labels: [], attachments: [], flags: [], preview: "", ...over,
});

test("matchesNonAsciiCriteria is accent- and case-insensitive and checks the right field", () => {
  const m = mail({ from: [{ name: "Pelcová Dita", address: "dita@example.cz" }], subject: "Wycena książki", to: [{ address: "me@example.com" }] });
  assert.equal(matchesNonAsciiCriteria(m, { from: "Pelcová" }), true);
  assert.equal(matchesNonAsciiCriteria(m, { from: "PELCOVA" }), true, "typed without the accent still matches");
  assert.equal(matchesNonAsciiCriteria(m, { subject: "KSIĄŻKI" }), true);
  assert.equal(matchesNonAsciiCriteria(m, { from: "Novák" }), false);
  assert.equal(matchesNonAsciiCriteria(m, { to: "Pelcová" }), false, "from is not to");
  assert.equal(matchesNonAsciiCriteria(m, { query: "Prägung" }, "Die Prägung ist teuer."), true, "free text also looks in the body");
  assert.equal(matchesNonAsciiCriteria(m, { query: "Prägung" }, "nothing relevant"), false);
});

// A fake Bridge: SEARCH matches only ASCII values, as a substring of the (accented) header text.
function serviceOverFakeBridge(messages) {
  const service = new SimpleIMAPService(
    { imap: { host: "127.0.0.1", port: 1143, secure: false, username: "o@example.com", password: "x" }, smtp: {}, dataDir: "/tmp/x", debug: false, runtime: {} },
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  const searches = [];
  const client = {
    mailbox: { path: "INBOX", uidValidity: 1n, exists: messages.length },
    search: async (query) => {
      searches.push(query);
      for (const value of Object.values(query)) if (typeof value === "string" && /[^\x00-\x7f]/.test(value)) return []; // Bridge's behaviour
      return messages
        .filter((m) => (!query.from || (m.fromText).toLowerCase().includes(query.from.toLowerCase())) && (!query.subject || m.subject.toLowerCase().includes(query.subject.toLowerCase())))
        .map((m) => m.uid);
    },
    fetch: async function* (uids) {
      for (const uid of uids) {
        const m = messages.find((x) => x.uid === uid);
        yield { uid, internalDate: new Date(m.date), flags: new Set(), envelope: { subject: m.subject, from: [{ name: m.fromName, address: m.address }], to: [{ address: "me@example.com" }], messageId: `<${uid}@x>` }, bodyStructure: { type: "text/plain" }, source: m.source ? Buffer.from(m.source) : undefined, size: 100 };
      }
    },
  };
  service.resolveSearchFolders = async () => ["INBOX"];
  service.resolveLabelFolders = async () => undefined;
  service.withMailbox = async (_f, _ro, action) => action(client);
  return { service, searches };
}

const messages = [
  { uid: 1, date: "2026-09-30T10:00:00Z", subject: "Quote request", fromName: "Pelcová Dita", address: "pelcova.dita@pbtisk.cz", fromText: "Pelcová Dita pelcova.dita@pbtisk.cz" },
  { uid: 2, date: "2026-09-29T10:00:00Z", subject: "Re: Wycena książki dla dzieci", fromName: "Anna", address: "anna@opolgraf.com.pl", fromText: "Anna anna@opolgraf.com.pl" },
  { uid: 3, date: "2026-09-28T10:00:00Z", subject: "Unrelated", fromName: "Pelcov Someone", address: "ps@other.test", fromText: "Pelcov Someone ps@other.test" },
];

test("searchEmails finds a sender by a name with an accent, which Bridge alone cannot", async () => {
  const { service, searches } = serviceOverFakeBridge(messages);
  const result = await service.searchEmails({ from: "Pelcová", folder: "INBOX" });
  assert.deepEqual(result.emails.map((e) => e.uid), [1], "uid 3 is in the narrowed superset but fails the local check");
  assert.equal(searches[0].from, "Pelcov", "Bridge is only ever sent the ASCII narrowing");
});

test("searchEmails finds a subject with non-ASCII letters, and still works when the narrowing is empty", async () => {
  const { service } = serviceOverFakeBridge(messages);
  assert.deepEqual((await service.searchEmails({ subject: "książki", folder: "INBOX" })).emails.map((e) => e.uid), [2]);
  assert.deepEqual((await service.searchEmails({ subject: "żż", folder: "INBOX" })).emails, [], "dropped criterion: scans candidates, verifies, finds none");
});

test("searchEmails with an ASCII-only criterion does not take the local path", async () => {
  const { service, searches } = serviceOverFakeBridge(messages);
  const result = await service.searchEmails({ from: "anna", folder: "INBOX" });
  assert.deepEqual(result.emails.map((e) => e.uid), [2]);
  assert.equal(searches[0].from, "anna");
});

test("a non-ASCII free-text query is verified against the message body", async () => {
  const withBody = messages.map((m) => (m.uid === 2 ? { ...m, source: "From: a@b.c\r\nSubject: x\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nDie Prägung ist teuer.\r\n" } : { ...m, source: "From: a@b.c\r\nSubject: x\r\nContent-Type: text/plain\r\n\r\nnothing\r\n" }));
  const { service } = serviceOverFakeBridge(withBody);
  const result = await service.searchEmails({ query: "Prägung", folder: "INBOX" });
  assert.deepEqual(result.emails.map((e) => e.uid), [2]);
});
