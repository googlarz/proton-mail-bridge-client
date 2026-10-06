import test from "node:test";
import assert from "node:assert/strict";
import { SimpleIMAPService } from "../dist/services/simple-imap-service.js";

// delete_folder refused the system folders by an exact, case-sensitive name match, so "inbox", "INBOX/", "Labels/"
// or "/Trash" reached the server, and a folder the server itself marks as a system folder (by special-use) was
// only protected if it happened to carry one of the usual names.

function service(folders = []) {
  const svc = new SimpleIMAPService({
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "o@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "o@example.com", password: "x" },
    dataDir: "/tmp/folder-safety-test", debug: false, runtime: {},
  });
  const deleted = [];
  svc.getFolders = async () => folders;
  svc.mutateFolderWithReconnectCheck = async (action) => { deleted.push("called"); return { path: "x" }; };
  return { svc, deleted };
}

test("system folders are refused whatever their capitalisation or slashes", async () => {
  for (const name of ["INBOX", "inbox", "Inbox/", "/Trash", " sent ", "DRAFTS", "Spam", "junk", "Archive", "all mail", "Starred", "Folders", "Labels", "Labels/", "folders/", "Deleted Messages", "Sent Mail"]) {
    const { svc, deleted } = service();
    await assert.rejects(svc.deleteFolder(name), /reserved|system/i, JSON.stringify(name));
    assert.deepEqual(deleted, [], `${JSON.stringify(name)} must not reach the server`);
  }
});

test("a folder the server marks with a special use is refused even under an unusual name", async () => {
  const { svc, deleted } = service([{ path: "Mein Postausgang", specialUse: "\\Sent" }, { path: "Labels/Work", specialUse: undefined }]);
  await assert.rejects(svc.deleteFolder("Mein Postausgang"), /system|special|reserved/i);
  assert.deepEqual(deleted, []);
});

test("an ordinary folder or label is still deleted", async () => {
  const { svc, deleted } = service([{ path: "Labels/Work" }]);
  await svc.deleteFolder("Labels/Work");
  assert.deepEqual(deleted, ["called"]);
});
