import test from "node:test";
import assert from "node:assert/strict";
import { SimpleIMAPService } from "../dist/services/simple-imap-service.js";

// imapflow 2.1 types status() as StatusObject | false. The callers read fields off the result, so a
// `false` (STATUS produced nothing) must behave like "no data", falling back to the selected mailbox
// where there is one, instead of being read as an object.
function serviceWith(statusResult) {
  const service = new SimpleIMAPService(
    { imap: { host: "127.0.0.1", port: 1143, secure: false, username: "o@example.com", password: "x" }, smtp: {}, dataDir: "/tmp/x", debug: false, runtime: {} },
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  const client = {
    mailbox: { path: "INBOX", exists: 7, uidNext: 42, uidValidity: 114504891n },
    status: async () => statusResult,
  };
  service.withMailbox = async (_folder, _readOnly, action) => action(client);
  service.ensureConnected = async () => client;
  return service;
}

test("getFolderStats falls back to the selected mailbox when STATUS returns false", async () => {
  const stats = await serviceWith(false).getFolderStats("INBOX");
  assert.deepEqual(stats, { folder: "INBOX", total: 7, unseen: 0, uidNext: 42, uidValidity: "114504891" });
});

test("getFolderStats prefers STATUS values when STATUS answers", async () => {
  const stats = await serviceWith({ messages: 9, unseen: 2, uidNext: 50, uidValidity: 5n }).getFolderStats("INBOX");
  assert.deepEqual(stats, { folder: "INBOX", total: 9, unseen: 2, uidNext: 50, uidValidity: "5" });
});

test("getMailboxUidValidity returns undefined (unverifiable, not blocking) when STATUS returns false", async () => {
  assert.equal(await serviceWith(false).getMailboxUidValidity("Archive"), undefined);
  assert.equal(await serviceWith({ uidValidity: 77n }).getMailboxUidValidity("Archive"), "77");
});
