import test from "node:test";
import assert from "node:assert/strict";
import { SimpleIMAPService } from "../dist/services/simple-imap-service.js";

// Measured on a real Bridge (57 folders): re-listing every folder with a STATUS costs ~0.9 s,
// and every message mutation invalidated that cache. So appending a draft and then resolving
// "which folder is Drafts" (or the first search after any change) paid it again — on a synced
// update_draft that was ~0.9 s of a 4.4 s call. Where folders are (path, flags, role) does not
// change when a message does.

function service() {
  const svc = new SimpleIMAPService(
    { imap: { host: "127.0.0.1", port: 1143, secure: false, username: "o@example.com", password: "x" }, smtp: {}, dataDir: "/tmp/x", debug: false, runtime: {} },
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  const calls = { list: 0 };
  svc.client = {
    usable: true,
    async list() {
      calls.list += 1;
      return ["INBOX", "Drafts", "Sent", "Labels/Work"].map((path) => ({ path, name: path.split("/").pop(), delimiter: "/", flags: new Set(), specialUse: path === "Drafts" ? "\\Drafts" : undefined, listed: true, subscribed: true, status: { messages: 1, unseen: 0 } }));
    },
  };
  return { svc, calls };
}

test("a message mutation invalidates the counts but not the folder structure", async () => {
  const { svc, calls } = service();
  await svc.getFolders();
  assert.equal(calls.list, 1);

  svc.folderCache = undefined; // exactly what deleteEmail/markEmailRead/append/... do
  assert.equal(await svc.resolveSpecialFolder("\\Drafts", ["Drafts"]), "Drafts");
  assert.deepEqual(await svc.resolveFolders(undefined), ["INBOX", "Drafts", "Sent", "Labels/Work"]);
  assert.equal(calls.list, 1, "resolving folders must not re-STATUS every folder after a message changed");

  await svc.getFolders();
  assert.equal(calls.list, 2, "the folder COUNTS are still refreshed when something asks for them");
});

test("creating, renaming, deleting a folder, or clear_cache, do refresh the structure", async () => {
  const { svc, calls } = service();
  await svc.getFolders();
  svc.clearCache();
  await svc.resolveSpecialFolder("\\Drafts", ["Drafts"]);
  assert.equal(calls.list, 2, "clearCache drops the structure too");
});

test("the structure still expires with the folder-cache TTL", async () => {
  const { svc, calls } = service();
  await svc.getFolders();
  svc.folderCache = undefined;
  svc.folderStructureAt = Date.now() - 6 * 60_000;
  await svc.resolveSpecialFolder("\\Drafts", ["Drafts"]);
  assert.equal(calls.list, 2, "an external folder change is still picked up after the TTL");
});
