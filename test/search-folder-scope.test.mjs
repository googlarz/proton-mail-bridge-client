import test from "node:test";
import assert from "node:assert/strict";
import { SimpleIMAPService, isVirtualMailView } from "../dist/services/simple-imap-service.js";

// Measured live (search_emails took ~20 s on a Bridge mailbox): with no `folder`, the search
// walked All Mail (57k) and Labels/* (50k) — views of mail already in INBOX/Sent/Archive — so
// the same messages were scanned several times (12 of the 19 s) and totalMatched was inflated.

const entry = (path, specialUse, flags = []) => ({ path, specialUse, flags });
const FOLDERS = [
  entry("INBOX", "\\Inbox"), entry("Sent", "\\Sent"), entry("Drafts", "\\Drafts"), entry("Archive", "\\Archive"),
  entry("Spam", "\\Junk"), entry("Trash", "\\Trash"), entry("All Mail"), entry("Starred"),
  entry("Folders/Work"), entry("Labels/gmail"), entry("Labels/Newsletters"), entry("Folders", undefined, ["\\Noselect"]),
];
const scope = (input) =>
  SimpleIMAPService.prototype.resolveSearchFolders.call(
    {
      getFolders: async () => FOLDERS,
      getFolderStructure: async () => FOLDERS,
      resolveFolders: (folder) =>
        SimpleIMAPService.prototype.resolveFolders.call({ getFolders: async () => FOLDERS, getFolderStructure: async () => FOLDERS }, folder),
    },
    input,
  );

test("isVirtualMailView flags All Mail, Labels/* and Starred but no real folder", () => {
  for (const path of ["All Mail", "Starred", "Labels/x"]) assert.equal(isVirtualMailView({ path }), true, path);
  for (const e of FOLDERS.filter((f) => !["All Mail", "Starred"].includes(f.path) && !f.path.startsWith("Labels/"))) {
    assert.equal(isVirtualMailView(e), false, e.path);
  }
});

test("a search without folder covers every real folder and none of the duplicating views", async () => {
  assert.deepEqual(await scope({ query: "x" }), ["INBOX", "Sent", "Drafts", "Archive", "Spam", "Trash", "Folders/Work"]);
});

test("an explicit folder is honored as-is, including a view", async () => {
  assert.deepEqual(await scope({ folder: "All Mail" }), ["All Mail"]);
  assert.deepEqual(await scope({ folder: "Labels/gmail,INBOX" }), ["Labels/gmail", "INBOX"]);
});

test("label and mailboxRole searches keep the full folder set (labels are only visible in Labels/*)", async () => {
  const everything = ["INBOX", "Sent", "Drafts", "Archive", "Spam", "Trash", "All Mail", "Starred", "Folders/Work", "Labels/gmail", "Labels/Newsletters"];
  assert.deepEqual(await scope({ label: "gmail" }), everything);
  assert.deepEqual(await scope({ mailboxRole: "Starred" }), everything);
});
