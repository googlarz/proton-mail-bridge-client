import test from "node:test";
import assert from "node:assert/strict";
import { SimpleIMAPService } from "../dist/services/simple-imap-service.js";
import { createEmailId } from "../dist/utils/helpers.js";

// imapflow 2 types fetchOne as FetchMessageObject | false | undefined (false: no such
// message; undefined: no mailbox selected). The guards around it must treat both as
// "nothing there" — the exists-check in deleteEmail is what stops a permanent delete
// from reporting success for a UID that never existed.

// a well-formed id (they carry a checksum, so it has to be generated, not typed)
const EMAIL_ID = createEmailId("INBOX", 999, "114504891");

function serviceWith(fetchOneResult) {
  const service = new SimpleIMAPService(
    { imap: { host: "127.0.0.1", port: 1143, secure: false, username: "o@example.com", password: "x" }, smtp: {}, dataDir: "/tmp/x", debug: false, runtime: {} },
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  const calls = { messageDelete: 0, messageFlagsAdd: 0 };
  const client = {
    mailbox: { path: "INBOX", uidValidity: 114504891n },
    fetchOne: async () => fetchOneResult,
    messageDelete: async () => { calls.messageDelete += 1; return true; },
    messageFlagsAdd: async () => { calls.messageFlagsAdd += 1; return true; },
    messageFlagsRemove: async () => true,
  };
  service.withMailbox = async (_folder, _readOnly, action) => action(client);
  service.withTimeout = async (promise) => promise;
  return { service, calls };
}

for (const [label, result] of [["false (no such message)", false], ["undefined (no mailbox selected)", undefined]]) {
  test(`deleteEmail does not delete when fetchOne returns ${label}`, async () => {
    const { service, calls } = serviceWith(result);
    await assert.rejects(service.deleteEmail(EMAIL_ID), /not found/i);
    assert.equal(calls.messageDelete, 0, "no EXPUNGE may be issued against a message that is not there");
  });
}

test("deleteEmail still deletes a message fetchOne finds", async () => {
  const { service, calls } = serviceWith({ uid: 999 });
  const result = await service.deleteEmail(EMAIL_ID);
  assert.equal(result.deleted, true);
  assert.equal(calls.messageDelete, 1);
});
