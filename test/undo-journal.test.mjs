import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountManager } from "../dist/services/account-manager.js";
import { createToolContext } from "../dist/tools/context.js";
import { handleMessageActionTool } from "../dist/tools/message-actions.js";
import { handleRuleTool } from "../dist/tools/rules.js";
import { handleTriageTool } from "../dist/tools/triage.js";
import { createEmailId, slugifyAccountAddress } from "../dist/utils/helpers.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";
import { createMessage, makeCertificate, startFakeBridge } from "./helpers/fake-bridge.mjs";

const certificate = makeCertificate();
const needsOpenssl = certificate ? {} : { skip: "openssl is not available to make a test certificate" };
const ADDRESS = "owner@example.com";
const LIST = { "List-Unsubscribe": "<mailto:u@x.example>" };
const OLD = new Date(Date.UTC(2020, 0, 1));

// bulk_move, bulk_update_flags, bulk_delete (permanent) and apply_rules write an undo journal before they change anything and
// return an undoId; undo_plan with it puts back only what really happened. Driven through the real handlers against the fake
// Bridge, so "put back" is checked on the mailbox itself.

function configFor(dir, port, runtimeOverrides = {}) {
  const imap = { host: "127.0.0.1", port, secure: false, username: ADDRESS, password: "secret" };
  const smtp = { host: "127.0.0.1", port: 9, secure: false, username: ADDRESS, password: "secret" };
  return {
    smtp, imap, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: true, syncInterval: 5,
    accounts: [{ address: ADDRESS, slug: slugifyAccountAddress(ADDRESS), imap, smtp, dataDir: dir }],
    runtime: { readOnly: false, allowSend: false, allowRemoteDraftSync: false, allowedActions: ["mark_read", "mark_unread", "star", "unstar", "archive", "move", "trash", "delete"], startupSync: false,
      autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 50, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: false,
      allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0, ...runtimeOverrides },
  };
}

function inbox() {
  return [
    createMessage(1, { subject: "One", from: "a@example.com" }),
    createMessage(2, { subject: "Two", from: "b@example.com", flags: ["\\Flagged"] }),
    createMessage(3, { subject: "Three", from: "c@example.com" }),
    createMessage(4, { subject: "Four", from: "d@example.com", flags: ["\\Seen"] }),
  ];
}

async function withBridge(fn, { messages = inbox(), runtime = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "undo-journal-"));
  const bridge = await startFakeBridge({
    mode: "starttls", certificate,
    folders: {
      INBOX: { uidValidity: 1, messages },
      "Folders/Geek": { uidValidity: 2, messages: [] },
      Archive: { uidValidity: 3, specialUse: "\\Archive", messages: [] },
      Trash: { uidValidity: 4, specialUse: "\\Trash", messages: [] },
    },
  });
  const config = configFor(dir, bridge.port, runtime);
  const manager = new AccountManager(config);
  const bundle = manager.primary();
  const ctx = createToolContext(config, manager);
  const parse = (result) => JSON.parse(result.content[0].text);
  const bulk = async (name, args) => parse(await handleMessageActionTool(name, args, ctx));
  const undo = async (args) => parse(await handleTriageTool("undo_plan", args, ctx));
  const idOf = (folder, uid, uidValidity = bridge.folders[folder].uidValidity) => createEmailId(folder, uid, String(uidValidity));
  const subjects = (folder) => bridge.folders[folder].messages.map((m) => m.subject).sort();
  try {
    await fn({ bundle, bridge, ctx, bulk, undo, idOf, subjects, dir });
  } finally {
    bundle.backgroundSyncService.stop();
    await bundle.imapService.disconnect().catch(() => {});
    await bundle.localIndexService.close();
    await closeTrackedIndexes();
    await bridge.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("bulk_move returns an undoId, and undo_plan puts the messages back", needsOpenssl, async () => {
  await withBridge(async ({ bridge, bulk, undo, idOf, subjects }) => {
    const moved = await bulk("bulk_move", { emailIds: [idOf("INBOX", 1), idOf("INBOX", 3)], targetFolder: "Archive" });
    assert.equal(moved.succeeded, 2);
    assert.match(moved.undoId, /^undo-[0-9a-f]{8}$/);
    assert.ok(moved.undoExpiresAt);
    assert.ok(moved.results.every((entry) => entry.targetEmailId?.startsWith("Archive") || entry.targetEmailId?.includes("Archive")), "the new ids are reported");
    assert.deepEqual(subjects("INBOX"), ["Four", "Two"]);
    assert.deepEqual(subjects("Archive"), ["One", "Three"]);

    const back = await undo({ undoId: moved.undoId });
    assert.equal(back.undone, 2);
    assert.deepEqual(back.failed, []);
    assert.equal(back.status, "undone");
    assert.deepEqual(subjects("INBOX"), ["Four", "One", "Three", "Two"], "everything is back in the INBOX");
    assert.deepEqual(subjects("Archive"), []);
    assert.equal(bridge.folders.INBOX.messages.find((m) => m.subject === "Two").flags.has("\\Flagged"), true, "flags came along");

    await assert.rejects(undo({ undoId: moved.undoId }), /already undone/);
  });
});

test("a message that moved again since is found by its Message-ID", needsOpenssl, async () => {
  await withBridge(async ({ bridge, bulk, undo, subjects }) => {
    const moved = await bulk("bulk_move", { folder: "INBOX", match: { isRead: false }, targetFolder: "Archive" });
    assert.equal(moved.succeeded, 3);
    // Something else gave the archived copies new UIDs (a move out and back, a folder rebuilt): the recorded ids are stale.
    for (const message of bridge.folders.Archive.messages) message.uid += 100;

    const back = await undo({ undoId: moved.undoId });
    assert.equal(back.undone, 3, JSON.stringify(back));
    assert.deepEqual(subjects("INBOX"), ["Four", "One", "Three", "Two"]);
  });
});

test("a Message-ID that two messages share is not guessed", needsOpenssl, async () => {
  await withBridge(async ({ bridge, bulk, undo, idOf, subjects }) => {
    const moved = await bulk("bulk_move", { emailIds: [idOf("INBOX", 1)], targetFolder: "Archive" });
    const [original] = bridge.folders.Archive.messages;
    original.uid += 100;
    bridge.folders.Archive.messages.push({ ...original, uid: original.uid + 1, flags: new Set() });

    const back = await undo({ undoId: moved.undoId });
    assert.equal(back.undone, 0);
    assert.match(back.failed[0].error, /carry the same Message-ID/);
    assert.deepEqual(subjects("INBOX"), ["Four", "Three", "Two"], "nothing was moved on a guess");
  });
});

test("bulk_update_flags: undo restores only the flags the call really changed", needsOpenssl, async () => {
  await withBridge(async ({ bridge, bulk, undo, idOf }) => {
    const flagsOf = (subject) => [...bridge.folders.INBOX.messages.find((m) => m.subject === subject).flags].sort();
    // "Two" is already flagged, "Four" is read.
    const changed = await bulk("bulk_update_flags", { emailIds: [1, 2, 3, 4].map((uid) => idOf("INBOX", uid)), flagsToAdd: ["\\Flagged"], flagsToRemove: ["\\Seen"] });
    assert.equal(changed.succeeded, 4);
    assert.ok(changed.undoId);
    assert.deepEqual(flagsOf("One"), ["\\Flagged"]);
    assert.deepEqual(flagsOf("Four"), ["\\Flagged"]);

    const back = await undo({ undoId: changed.undoId });
    assert.equal(back.undone, 3, "\"Two\" had nothing changed, so there is nothing to put back for it");
    assert.equal(back.status, "undone");
    assert.deepEqual(flagsOf("One"), []);
    assert.deepEqual(flagsOf("Two"), ["\\Flagged"], "it was flagged before the call, so it stays flagged");
    assert.deepEqual(flagsOf("Three"), []);
    assert.deepEqual(flagsOf("Four"), ["\\Seen"], "the read mark is back");
  });
});

test("a partly failed operation journals only what was done, and a partly failed undo says which and can be retried", needsOpenssl, async () => {
  await withBridge(async ({ bundle, bridge, bulk, undo, idOf, subjects }) => {
    // uid 999 does not exist: the call reports it as failed and the journal never held it.
    const moved = await bulk("bulk_move", { emailIds: [idOf("INBOX", 1), idOf("INBOX", 2), idOf("INBOX", 999)], targetFolder: "Archive" });
    assert.equal(moved.succeeded, 2);
    assert.equal(moved.failed, 1);
    const [journal] = await bundle.undoJournalService.list();
    assert.equal(journal.items.length, 2, "the message that was never there is not in the journal");

    // The user deletes one of the archived messages before undoing.
    bridge.folders.Archive.messages = bridge.folders.Archive.messages.filter((m) => m.subject !== "One");
    const partial = await undo({ undoId: moved.undoId });
    assert.equal(partial.undone, 1);
    assert.equal(partial.failed.length, 1);
    assert.match(partial.failed[0].error, /no longer in Archive|not found/i);
    assert.equal(partial.status, "done", "something is still left to put back, so it stays open");
    assert.deepEqual(subjects("INBOX"), ["Four", "Three", "Two"]);

    const again = await undo({ undoId: moved.undoId });
    assert.equal(again.undone, 0, "the message that was put back is not moved again");
    assert.equal(again.failed.length, 1);
  });
});

test("undo obeys the runtime policy as the original action did, and can be retried", needsOpenssl, async () => {
  await withBridge(async ({ bundle, bulk, undo, idOf, subjects }) => {
    const moved = await bulk("bulk_move", { emailIds: [idOf("INBOX", 1)], targetFolder: "Archive" });
    bundle.config.runtime.allowedActions = ["archive"];
    const refused = await undo({ undoId: moved.undoId });
    assert.equal(refused.undone, 0);
    assert.match(refused.failed[0].error, /disabled by the current runtime policy/);
    assert.deepEqual(subjects("Archive"), ["One"], "nothing moved");

    bundle.config.runtime.allowedActions = ["move"];
    bundle.config.runtime.readOnly = true;
    assert.match((await undo({ undoId: moved.undoId })).failed[0].error, /read-only/);

    bundle.config.runtime.readOnly = false;
    assert.equal((await undo({ undoId: moved.undoId })).undone, 1);
    assert.deepEqual(subjects("Archive"), []);
  });
});

test("a permanent delete is journaled as irreversible and undo says so", needsOpenssl, async () => {
  await withBridge(async ({ bulk, undo, idOf, subjects }) => {
    const deleted = await bulk("bulk_delete", { emailIds: [idOf("INBOX", 3)], permanent: true });
    assert.equal(deleted.succeeded, 1);
    assert.ok(deleted.undoId, "it is recorded");
    assert.match(deleted.undoNote, /cannot be undone/);
    assert.deepEqual(subjects("INBOX"), ["Four", "One", "Two"]);
    await assert.rejects(undo({ undoId: deleted.undoId }), /cannot be undone: permanently deleted/);
    assert.deepEqual(subjects("Trash"), [], "and nothing was invented");
  });
});

test("apply_rules: moves and marks are undone, a delete is counted as irreversible", needsOpenssl, async () => {
  const messages = [
    createMessage(1, { subject: "Promo", from: "promo@shop.example", headers: LIST, date: OLD }),
    createMessage(2, { subject: "Old stuff", from: "old@x.example", headers: LIST, date: OLD }),
  ];
  await withBridge(async ({ bundle, bridge, ctx, undo, subjects }) => {
    await bundle.rulesService.set({ name: "promo away", when: { from: ["promo@shop.example"], automated: true }, actions: { markRead: true, moveTo: "Folders/Geek" } });
    await bundle.rulesService.set({ name: "wipe", when: { from: ["old@x.example"], automated: true }, actions: { delete: true } });
    await bundle.backgroundSyncService.runNow("manual");

    const done = JSON.parse((await handleRuleTool("apply_rules", { dryRun: false }, ctx)).content[0].text);
    assert.equal(done.changed, 2, JSON.stringify(done));
    assert.ok(done.undo.undoId);
    assert.equal(done.undo.reversible, 1);
    assert.equal(done.undo.irreversible, 1, "the delete cannot be put back");
    assert.deepEqual(subjects("INBOX"), []);
    assert.deepEqual(subjects("Folders/Geek"), ["Promo"]);
    assert.ok(bridge.folders["Folders/Geek"].messages[0].flags.has("\\Seen"));

    const back = await undo({ undoId: done.undo.undoId });
    assert.equal(back.undone, 1, JSON.stringify(back));
    assert.equal(back.irreversible, 1);
    assert.deepEqual(subjects("INBOX"), ["Promo"], "the deleted one stays deleted");
    assert.equal(bridge.folders.INBOX.messages[0].flags.has("\\Seen"), false, "and the read mark the rule added is gone");
    assert.deepEqual(subjects("Folders/Geek"), []);
  }, { messages, runtime: { confirmDestructive: false } });
});

test("a dry run writes no journal and returns no undoId", needsOpenssl, async () => {
  await withBridge(async ({ bundle, bulk, idOf }) => {
    const preview = await bulk("bulk_move", { emailIds: [idOf("INBOX", 1)], targetFolder: "Archive", dryRun: true });
    assert.equal(preview.undoId, undefined);
    assert.deepEqual(await bundle.undoJournalService.list(), []);
  });
});

test("an expired journal is refused, and an unfinished one is not guessed at", needsOpenssl, async () => {
  await withBridge(async ({ bundle, bulk, undo, idOf, dir, subjects }) => {
    const moved = await bulk("bulk_move", { emailIds: [idOf("INBOX", 1)], targetFolder: "Archive" });
    const file = join(dir, "undo-journals.json");
    const state = JSON.parse(await readFile(file, "utf8"));
    state.journals[0].createdAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(file, JSON.stringify(state));
    await assert.rejects(undo({ undoId: moved.undoId }), /expired/);
    assert.deepEqual(subjects("Archive"), ["One"], "nothing moved");

    const pending = await bundle.undoJournalService.begin("bulk_move", [{ emailId: idOf("INBOX", 3), folder: "INBOX" }]);
    await assert.rejects(undo({ undoId: pending.id }), /never finished/);
    await assert.rejects(undo({ undoId: "undo-00000000" }), /No undo journal/);
    await assert.rejects(undo({ undoId: moved.undoId, planId: "plan-x" }), /planId or undoId, not both/);
  });
});

test("list_plans shows the stored undo journals", needsOpenssl, async () => {
  await withBridge(async ({ ctx, bulk, idOf }) => {
    const moved = await bulk("bulk_move", { emailIds: [idOf("INBOX", 1)], targetFolder: "Archive" });
    const listed = JSON.parse((await handleTriageTool("list_plans", {}, ctx)).content[0].text);
    assert.equal(listed.undoJournals.length, 1);
    assert.equal(listed.undoJournals[0].undoId, moved.undoId);
    assert.equal(listed.undoJournals[0].undoableItems, 1);
    assert.equal(listed.undoJournals[0].status, "done");
  });
});
