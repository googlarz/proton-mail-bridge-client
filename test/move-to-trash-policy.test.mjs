import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";

net.Socket.prototype.connect = () => { throw new Error("Network disabled in this test file"); };

// Moving a message into the Trash folder is trashing it. A list of allowed actions that leaves out "trash" must
// stop every tool that can move there, not only trash_email.
const thread = (n) => ({ id: `t${n}`, subject: `s${n}`, score: 100 - n, latestDate: `2026-09-${String(30 - (n % 28)).padStart(2, "0")}T00:00:00Z`, messageCount: 1 });
const TOP = Array.from({ length: 25 }, (_, i) => thread(i));
const STALE = Array.from({ length: 4 }, (_, i) => thread(100 + i));


async function withServer(allowedActions, fn) {
  const dataDir = await mkdtemp(join(tmpdir(), "move-trash-"));
  const smtp = { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "x" };
  const imap = { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "x" };
  const config = {
    smtp, imap, dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: "owner@example.com", slug: "owner-example-com", imap, smtp, dataDir }],
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions, startupSync: false,
      autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30,
      confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0 },
  };
  const { server, imapService, localIndexService } = createServer(config, { startBackgroundSync: false });
  const moved = [];
  imapService.getFolderStructure = async () => [
    { path: "INBOX", specialUse: "\\Inbox" }, { path: "Papierkorb", specialUse: "\\Trash" }, { path: "Archive", specialUse: "\\Archive" }, { path: "Folders/Trash" },
  ];
  imapService.moveEmail = async (id, target) => { moved.push(target); return { emailId: id, sourceEmailId: id, fromFolder: "INBOX", targetFolder: target, uid: 1 }; };
  localIndexService.getThreadById = async () => ({ id: "t", messages: [], messageCount: 0 });
  imapService.getFolderStats = async () => { throw new Error("no bridge"); };
  localIndexService.getFreshness = async () => ({ storedMessageCount: 1, isStale: false });
  localIndexService.getSyncCheckpointMap = async () => ({ INBOX: { folder: "INBOX", uidNext: 2, total: 1 } });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try { await fn(client, moved, imapService); } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

const POLICY = /Mailbox action trash is disabled/;
const run = async (client, name, args) => {
  try {
    const r = await client.callTool({ name, arguments: args });
    return { error: r.isError === true, text: r.content.map((c) => c.text ?? "").join(" ") };
  } catch (error) {
    return { error: true, text: String(error?.message ?? error) };
  }
};

for (const [tool, args] of [
  ["move_email", { emailId: "INBOX::1", targetFolder: "Trash" }],
  ["move_email", { emailId: "INBOX::1", targetFolder: " trash/ " }],
  ["move_email", { emailId: "INBOX::1", targetFolder: "Papierkorb" }],
  ["bulk_move", { emailIds: ["INBOX::1"], targetFolder: "Trash" }],
  ["move_thread", { messageId: "<a@example.com>", destination: "Trash" }],
  ["batch_email_action", { emailIds: ["INBOX::1"], action: "move", targetFolder: "Trash" }],
  ["apply_thread_action", { threadId: "t", action: "move", targetFolder: "Papierkorb" }],
  ["move_email", { emailId: "INBOX::1", targetFolder: "/Trash" }],
  ["move_email", { emailId: "INBOX::1", targetFolder: "INBOX.Trash" }],
]) {
  test(`${tool} to ${JSON.stringify(args.targetFolder ?? args.destination)} is refused when only move is allowed`, async () => {
    await withServer(["move"], async (client, moved) => {
      const result = await run(client, tool, args);
      assert.equal(result.error, true);
      assert.match(result.text, POLICY);
      assert.deepEqual(moved, [], "nothing was moved");
    });
  });
}

test("moving to an ordinary folder, including one that is only named Trash, still works with move allowed", async () => {
  await withServer(["move"], async (client, moved) => {
    for (const target of ["Archive", "Folders/Trash", "Folders/Receipts"]) {
      const result = await run(client, "move_email", { emailId: "INBOX::1", targetFolder: target });
      assert.equal(result.error, false, `${target}: ${result.text}`);
    }
    assert.deepEqual(moved, ["Archive", "Folders/Trash", "Folders/Receipts"]);
  });
});

test("with trash allowed as well, moving to the Trash folder goes through", async () => {
  await withServer(["move", "trash"], async (client, moved) => {
    const result = await run(client, "move_email", { emailId: "INBOX::1", targetFolder: "Trash" });
    assert.equal(result.error, false, result.text);
    assert.deepEqual(moved, ["Trash"]);
  });
});

// restore takes a destination too, and a destination of Trash is trashing, not restoring.
for (const [tool, args] of [
  ["restore_email", { emailId: "Trash::1", targetFolder: "Trash" }],
  ["restore_email", { emailId: "Trash::1", targetFolder: "/trash/" }],
  ["batch_email_action", { emailIds: ["Trash::1"], action: "restore", targetFolder: "Papierkorb" }],
  ["apply_thread_action", { threadId: "t", action: "restore", targetFolder: "Trash" }],
]) {
  test(`${tool} (restore) to ${JSON.stringify(args.targetFolder)} is refused when only restore is allowed`, async () => {
    await withServer(["restore"], async (client) => {
      const result = await run(client, tool, args);
      assert.equal(result.error, true);
      assert.match(result.text, POLICY);
    });
  });
}

test("restoring to an ordinary destination still works with only restore allowed", async () => {
  await withServer(["restore"], async (client) => {
    const result = await run(client, "restore_email", { emailId: "Trash::1", targetFolder: "Folders/Receipts" });
    assert.doesNotMatch(result.text, POLICY);
  });
});

test("isTrashFolder reads the folder the server marks as Trash, in any spelling", async () => {
  await withServer(["move", "trash"], async (_client, _moved, imapService) => {
    for (const name of ["Trash", " TRASH ", "/Trash/", "inbox.trash", "Papierkorb", "/papierkorb"]) {
      assert.equal(await imapService.isTrashFolder(name), true, name);
    }
    for (const name of ["Folders/Trash", "Archive", "INBOX", "Trash2", ""]) {
      assert.equal(await imapService.isTrashFolder(name), false, JSON.stringify(name));
    }
  });
});
