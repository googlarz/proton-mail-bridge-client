import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../dist/index.js";
import { normalizeBoolean, normalizeLimit, InvalidArgumentError, createEmailId } from "../dist/utils/helpers.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";

const EMAIL_ID = createEmailId("INBOX", 5, "114504891");

net.Socket.prototype.connect = () => { throw new Error("Network disabled in this test file"); };

// The server does not validate inputSchema, and normalizeBoolean only accepted a real boolean: dryRun:"true",
// confirmed:"true" or isRead:"false" fell through to the default, so a dry run performed the real operation
// and isRead:"false" marked the message read. Clients (and models) do send strings.

test("normalizeBoolean understands the usual spellings of true and false", () => {
  for (const value of [true, "true", "TRUE", " True ", "yes", "1", 1, "on"]) assert.equal(normalizeBoolean(value, false), true, String(value));
  for (const value of [false, "false", "FALSE", " no ", "0", 0, "off"]) assert.equal(normalizeBoolean(value, true), false, String(value));
});

test("normalizeBoolean uses the default only when nothing was given", () => {
  for (const value of [undefined, null, ""]) {
    assert.equal(normalizeBoolean(value, true), true);
    assert.equal(normalizeBoolean(value, false), false);
  }
});

test("normalizeBoolean refuses a value it cannot read instead of silently using the default", () => {
  for (const value of ["maybe", "tru", 2, -1, {}, [], "dry"]) {
    assert.throws(() => normalizeBoolean(value, false), InvalidArgumentError, JSON.stringify(value));
  }
});

test("normalizeLimit reads numeric strings, clamps numbers, and refuses junk", () => {
  assert.equal(normalizeLimit("5", 10), 5);
  assert.equal(normalizeLimit(" 7 ", 10), 7);
  assert.equal(normalizeLimit(undefined, 10), 10);
  assert.equal(normalizeLimit(null, 10), 10);
  assert.equal(normalizeLimit(-3, 10), 1);
  assert.equal(normalizeLimit(1e9, 10), 250);
  assert.equal(normalizeLimit(2.9, 10), 2);
  for (const value of ["abc", "5x", true, {}, [], NaN]) assert.throws(() => normalizeLimit(value, 10), InvalidArgumentError, JSON.stringify(value));
});

async function withServer(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), "argument-coercion-"));
  const smtp = { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "x" };
  const imap = { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "x" };
  const config = {
    smtp, imap, dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: "owner@example.com", slug: "owner-example-com", imap, smtp, dataDir }],
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: ["mark_read", "mark_unread", "star", "unstar", "archive", "trash", "restore", "move", "delete"],
      startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30,
      confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0, sendDelaySeconds: 0 },
  };
  const { server, imapService } = createServer(config, { startBackgroundSync: false });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try { await fn(client, imapService); } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

test('mark_email_read with isRead:"false" marks the message unread, not read', async () => {
  await withServer(async (client, imapService) => {
    const calls = [];
    imapService.markEmailRead = async (emailId, isRead) => { calls.push(isRead); return { id: emailId, isRead }; };
    await client.callTool({ name: "mark_email_read", arguments: { emailId: EMAIL_ID, isRead: "false" } });
    assert.deepEqual(calls, [false]);
  });
});

test('batch_email_action with dryRun:"true" does not touch the mailbox, and dryRun:"false" does', async () => {
  await withServer(async (client, imapService) => {
    let marked = 0;
    imapService.markEmailRead = async (emailId, isRead) => { marked += 1; return { id: emailId, isRead }; };
    const run = (dryRun) => client.callTool({ name: "batch_email_action", arguments: { emailIds: [EMAIL_ID], action: "mark_read", dryRun } });
    await run("true");
    assert.equal(marked, 0, "a dry run must not act");
    await run(true);
    assert.equal(marked, 0, "a boolean dry run must not act either");
    await run("false");
    assert.equal(marked, 1, "dryRun:\"false\" really acts");
  });
});

test("a boolean argument that cannot be read is an InvalidParams error, not a silent default", async () => {
  await withServer(async (client, imapService) => {
    imapService.markEmailRead = async () => { throw new Error("must not be reached"); };
    await assert.rejects(
      client.callTool({ name: "mark_email_read", arguments: { emailId: EMAIL_ID, isRead: "perhaps" } }),
      (error) => error instanceof McpError && error.code === -32602 && /true or false/i.test(error.message),
    );
  });
});
