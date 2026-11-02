import test from "node:test";
import assert from "node:assert/strict";
import { SimpleIMAPService } from "../dist/services/simple-imap-service.js";
import { dedupeEmails } from "../dist/utils/helpers.js";

// Issue #68: two distinct messages in one folder can share an RFC Message-ID (a sender that delivers the same
// newsletter twice). They are separate messages and must both be returned and counted. Copies of one message in
// different folders (a label view repeating an INBOX message) still collapse.

const mail = (folder, uid, messageId) => ({
  id: `${folder}::${uid}`, folder, uid, subject: "", from: [], to: [], cc: [], labels: [], attachments: [], flags: [], preview: "", messageId,
});

test("dedupeEmails keeps two messages with one Message-ID in the same folder", () => {
  const result = dedupeEmails([mail("INBOX", 1, "<dup@x>"), mail("INBOX", 2, "<dup@x>")]);
  assert.deepEqual(result.map((e) => e.uid), [1, 2]);
});

test("dedupeEmails still collapses copies of one message across folders", () => {
  const result = dedupeEmails([mail("INBOX", 1, "<a@x>"), mail("Labels/news", 7, "<a@x>"), mail("INBOX", 2, "<b@x>")]);
  assert.deepEqual(result.map((e) => e.id), ["INBOX::1", "INBOX::2"]);
});

test("dedupeEmails drops an exact repeat of one id and keeps messages without a Message-ID", () => {
  const result = dedupeEmails([mail("INBOX", 1), mail("INBOX", 1), mail("INBOX", 2)]);
  assert.deepEqual(result.map((e) => e.uid), [1, 2]);
});

function serviceWith(folders) {
  const service = new SimpleIMAPService(
    { imap: { host: "127.0.0.1", port: 1143, secure: false, username: "o@example.com", password: "x" }, smtp: {}, dataDir: "/tmp/x", debug: false, runtime: {} },
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  service.resolveSearchFolders = async () => Object.keys(folders);
  service.resolveLabelFolders = async () => undefined;
  service.withMailbox = async (folder, _ro, action) =>
    action({
      mailbox: { path: folder, uidValidity: 1n, exists: folders[folder].length },
      search: async () => folders[folder].map((m) => m.uid),
      fetch: async function* (uids) {
        for (const uid of uids) {
          const m = folders[folder].find((x) => x.uid === uid);
          yield { uid, internalDate: new Date(m.date), flags: new Set(), envelope: { subject: "s", from: [], to: [], messageId: m.messageId }, bodyStructure: { type: "text/plain" }, size: 1 };
        }
      },
    });
  return service;
}

test("searchEmails returns both same-folder messages sharing a Message-ID and totalMatched matches", async () => {
  const service = serviceWith({
    INBOX: [
      { uid: 1, date: "2026-09-30T10:00:00Z", messageId: "<dup@x>" },
      { uid: 2, date: "2026-09-29T10:00:00Z", messageId: "<dup@x>" },
    ],
  });
  const result = await service.searchEmails({ folder: "INBOX", limit: 50 });
  assert.deepEqual(result.emails.map((e) => e.uid), [1, 2]);
  assert.equal(result.totalMatched, 2);
  assert.equal(result.hasMore, false);
});

test("searchEmails does not count a cross-folder copy it collapsed, so hasMore is false", async () => {
  const service = serviceWith({
    INBOX: [{ uid: 1, date: "2026-09-30T10:00:00Z", messageId: "<a@x>" }],
    "Labels/news": [{ uid: 9, date: "2026-09-30T10:00:00Z", messageId: "<a@x>" }],
  });
  const result = await service.searchEmails({ limit: 50 });
  assert.equal(result.emails.length, 1);
  assert.equal(result.totalMatched, 1);
  assert.equal(result.hasMore, false);
});
