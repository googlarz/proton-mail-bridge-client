import test from "node:test";
import assert from "node:assert/strict";
import { SimpleIMAPService } from "../dist/services/simple-imap-service.js";
import { InvalidArgumentError } from "../dist/utils/helpers.js";

// bulk_delete / bulk_move / bulk_update_* take either emailIds or a `match`. A match with no recognised
// criterion ({}, a misspelled field, an empty string) fell back to IMAP "ALL" and resolved to every message in
// the folder (up to the 500-message cap). Values given as strings were ignored the same way ("isRead":"false").

function service() {
  return new SimpleIMAPService({
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "o@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "o@example.com", password: "x" },
    dataDir: "/tmp/bulk-safety-test", debug: false, runtime: {},
  });
}

function withStubbedMailbox(svc, { uids = [1, 2, 3, 4, 5], validities = ["100"] } = {}) {
  const searches = [];
  const deleted = [];
  let opened = 0;
  svc.withMailbox = async (folder, readOnly, action) => {
    const validity = validities[Math.min(opened, validities.length - 1)];
    opened += 1;
    const client = {
      mailbox: { path: folder, uidValidity: BigInt(validity), exists: uids.length },
      search: async (query) => { searches.push(query); return uids; },
      messageDelete: async (set) => { deleted.push(set); },
    };
    return action(client);
  };
  svc.getMailboxUidValidity = async () => validities[0];
  return { searches, deleted };
}

test("a match with nothing to match on is refused instead of matching the whole folder", async () => {
  for (const match of [{}, { sender: "boss@x.com" }, { from: "" }, { from: undefined, isRead: undefined }, { frm: "a@b.c" }]) {
    const svc = service();
    const { searches } = withStubbedMailbox(svc);
    await assert.rejects(svc.resolveUidsForBulkOp("INBOX", undefined, match), InvalidArgumentError, JSON.stringify(match));
    assert.deepEqual(searches, [], `no search may run for ${JSON.stringify(match)}`);
  }
});

test("an unknown match field is named in the error, with the valid ones", async () => {
  const svc = service();
  withStubbedMailbox(svc);
  await assert.rejects(svc.resolveUidsForBulkOp("INBOX", undefined, { from: "a@b.c", sender: "x" }), /sender.*from.*subject/s);
});

test("match values given as strings are read, not ignored", async () => {
  const svc = service();
  const { searches } = withStubbedMailbox(svc);
  await svc.resolveUidsForBulkOp("INBOX", undefined, { isRead: "false", sizeLarger: "1000", from: " boss@x.com " });
  assert.equal(searches.length, 1);
  assert.equal(searches[0].seen, false);
  assert.equal(searches[0].larger, 1000);
  assert.equal(searches[0].from, "boss@x.com");
});

test("a normal match still resolves", async () => {
  const svc = service();
  const { searches } = withStubbedMailbox(svc, { uids: [7, 9] });
  assert.deepEqual(await svc.resolveUidsForBulkOp("INBOX", undefined, { from: "boss@x.com" }), [7, 9]);
  assert.equal(searches[0].from, "boss@x.com");
});

test("emptyFolder deletes nothing if the folder was recreated between listing and deleting", async () => {
  const svc = service();
  const { deleted } = withStubbedMailbox(svc, { uids: [1, 2, 3], validities: ["100", "200"] });
  await assert.rejects(svc.emptyFolder("Trash"), /UIDVALIDITY|changed|recreated/i);
  assert.deepEqual(deleted, [], "UIDs listed in one generation must not be deleted in another");
});

test("emptyFolder still empties a folder whose generation did not change", async () => {
  const svc = service();
  const { deleted } = withStubbedMailbox(svc, { uids: [1, 2, 3], validities: ["100", "100"] });
  assert.deepEqual(await svc.emptyFolder("Trash"), { folder: "Trash", deleted: 3 });
  assert.deepEqual(deleted, ["1,2,3"]);
});

test("a match resolved under one folder generation is refused if the folder is now another", async () => {
  const svc = service();
  withStubbedMailbox(svc, { uids: [1, 2], validities: ["200"] });
  await assert.rejects(svc.resolveUidsForBulkOp("INBOX", undefined, { from: "a@b.c" }, "100"), /UIDVALIDITY|changed|recreated/i);
});
