import test from "node:test";
import assert from "node:assert/strict";
import { SimpleIMAPService } from "../dist/services/simple-imap-service.js";
import { labelMatchesFolder } from "../dist/utils/helpers.js";

// Found live: search_emails(label:"Newsletters") took 26 s and returned nothing. Proton Bridge
// sends no X-GM-LABELS, so a label is only a folder ("Labels/Newsletters"), but the filter
// compared the bare label with the full folder path and scanned every folder to fail at it.
// The same messages via folder:"Labels/Newsletters" came back in 38 ms.

test("labelMatchesFolder: bare name, Labels/ and Folders/ paths, exact path, any case — and nothing else", () => {
  assert.equal(labelMatchesFolder("Labels/Newsletters", "Newsletters"), true);
  assert.equal(labelMatchesFolder("Labels/Newsletters", "newsletters"), true);
  assert.equal(labelMatchesFolder("Labels/Newsletters", "Labels/Newsletters"), true);
  assert.equal(labelMatchesFolder("Folders/Work", "Work"), true);
  assert.equal(labelMatchesFolder("INBOX", "inbox"), true);
  assert.equal(labelMatchesFolder("Labels/Newsletters", "News"), false, "no substring matching");
  assert.equal(labelMatchesFolder("Labels/Newsletters/Sub", "Newsletters"), false);
  assert.equal(labelMatchesFolder("Archive", "Newsletters"), false);
});

const FOLDERS = ["INBOX", "Sent", "Archive", "Labels/Newsletters", "Labels/Work", "Folders/Work", "All Mail"].map((path) => ({ path, flags: [] }));

function serviceWithFolders(messagesByFolder = {}) {
  const service = new SimpleIMAPService(
    { imap: { host: "127.0.0.1", port: 1143, secure: false, username: "o@example.com", password: "x" }, smtp: {}, dataDir: "/tmp/x", debug: false, runtime: {} },
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  service.getFolders = async () => FOLDERS;
  const opened = [];
  service.withMailbox = async (folder, _ro, action) => {
    opened.push(folder);
    const messages = messagesByFolder[folder] ?? [];
    const client = {
      mailbox: { path: folder },
      search: async () => messages.map((m) => m.uid),
      async *fetch(uids) {
        for (const uid of uids) {
          const m = messages.find((x) => x.uid === uid);
          if (m) yield { uid, seq: uid, envelope: { subject: `M${uid}`, from: [], to: [], cc: [], bcc: [], replyTo: [] }, internalDate: m.date, flags: new Set(), labels: [], bodyStructure: {} };
        }
      },
    };
    return action(client);
  };
  return { service, opened };
}

test("a label that names a folder searches only that folder, and matches by the bare name", async () => {
  const { service, opened } = serviceWithFolders({
    "Labels/Newsletters": [{ uid: 1, date: new Date("2026-01-01") }, { uid: 2, date: new Date("2026-02-01") }],
    INBOX: [{ uid: 9, date: new Date("2026-03-01") }],
  });
  const result = await service.resolveLabelFolders({ label: "Newsletters" });
  assert.deepEqual(result, ["Labels/Newsletters"]);

  const found = await service.searchEmails({ label: "newsletters", limit: 5 });
  assert.deepEqual(opened, ["Labels/Newsletters"], "no other folder is opened");
  assert.equal(found.emails.length, 2);
  assert.equal(found.totalMatched, 2, "exact count, as for an explicit folder");
  assert.equal(found.hasMore, false);
});

test("a label matching both Labels/X and Folders/X searches both", async () => {
  const { service } = serviceWithFolders();
  assert.deepEqual(await service.resolveLabelFolders({ label: "Work" }), ["Labels/Work", "Folders/Work"]);
});

test("on Bridge an unknown label matches nothing without opening any folder", async () => {
  const { service, opened } = serviceWithFolders({ INBOX: [{ uid: 1, date: new Date("2026-01-01") }] });
  assert.deepEqual(await service.resolveLabelFolders({ label: "Newsltters" }), []);
  const found = await service.searchEmails({ label: "Newsltters", limit: 5 });
  assert.deepEqual(opened, [], "no 25 s scan to arrive at an empty result");
  assert.equal(found.emails.length, 0);
  assert.equal(found.totalMatched, 0);
  assert.equal(found.hasMore, false);
});

test("on a server without Labels/ folders an unknown label still scans (labels may come from X-GM-LABELS)", async () => {
  const { service } = serviceWithFolders();
  service.getFolders = async () => ["INBOX", "Sent", "Archive"].map((path) => ({ path, flags: [] }));
  assert.equal(await service.resolveLabelFolders({ label: "DoesNotExist" }), undefined);
});

test("an explicit folder or no label leaves the scope to the old logic", async () => {
  const { service } = serviceWithFolders();
  assert.equal(await service.resolveLabelFolders({ label: "Newsletters", folder: "INBOX" }), undefined);
  assert.equal(await service.resolveLabelFolders({ query: "x" }), undefined);
});

test("label combined with another local-only filter still applies both", async () => {
  const { service, opened } = serviceWithFolders({
    "Labels/Newsletters": [{ uid: 1, date: new Date("2026-01-01") }, { uid: 2, date: new Date("2026-02-01") }],
  });
  const found = await service.searchEmails({ label: "Newsletters", hasAttachment: true, limit: 5 });
  assert.deepEqual(opened, ["Labels/Newsletters"]);
  assert.equal(found.emails.length, 0, "the attachment filter still runs (fake messages have none)");
});
