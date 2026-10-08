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

// An argument a tool does not declare is ignored, and the result says so.
const thread = (n) => ({ id: `t${n}`, subject: `s${n}`, score: 100 - n, latestDate: `2026-09-${String(30 - (n % 28)).padStart(2, "0")}T00:00:00Z`, messageCount: 1 });
const TOP = Array.from({ length: 25 }, (_, i) => thread(i));
const STALE = Array.from({ length: 4 }, (_, i) => thread(100 + i));

async function withServer(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), "digest-paging-"));
  const smtp = { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "x" };
  const imap = { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "x" };
  const config = {
    smtp, imap, dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: "owner@example.com", slug: "owner-example-com", imap, smtp, dataDir }],
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false,
      autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30,
      confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0 },
  };
  const { server, imapService, localIndexService } = createServer(config, { startBackgroundSync: false });
  imapService.getFolderStats = async () => { throw new Error("no bridge"); };
  localIndexService.getFreshness = async () => ({ storedMessageCount: 1, isStale: false });
  localIndexService.getSyncCheckpointMap = async () => ({ INBOX: { folder: "INBOX", uidNext: 2, total: 1 } });
  localIndexService.getThreads = async (input) => { globalThis.__threadsInput = input; return { total: 0, hasMore: false, offset: 0, threads: [] }; };
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try { await fn(async (args) => JSON.parse((await client.callTool({ name: "get_threads", arguments: args })).content[0].text), client); } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

import { ignoredArguments } from "../dist/index.js";

const noteOf = (result) => result.content.filter((part) => part.type === "text" && part.text.startsWith("Note:")).map((part) => part.text);

test("an undeclared argument is ignored and named in a note after the result", async () => {
  await withServer(async (_call, client) => {
    const result = await client.callTool({ name: "get_threads", arguments: { query: "x", bogus: true, other: 1 } });
    assert.ok(!result.isError);
    assert.equal(JSON.parse(result.content[0].text).total, 0, "the result itself is untouched");
    const notes = noteOf(result);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /"bogus", "other"/);
    assert.match(notes[0], /It accepts: .*folder/);
  });
});

test("no note when every argument is declared", async () => {
  await withServer(async (_call, client) => {
    const result = await client.callTool({ name: "get_threads", arguments: { query: "x", folder: "INBOX", limit: 5 } });
    assert.deepEqual(noteOf(result), []);
    const empty = await client.callTool({ name: "get_threads", arguments: {} });
    assert.deepEqual(noteOf(empty), []);
  });
});

test("ignoredArguments is empty for an unknown tool and for non-object arguments", () => {
  assert.deepEqual(ignoredArguments("no_such_tool", { a: 1 }), []);
  assert.deepEqual(ignoredArguments("get_threads", undefined), []);
  assert.deepEqual(ignoredArguments("get_threads", [1, 2]), []);
  assert.deepEqual(ignoredArguments("get_threads", { query: "a", zzz: 1 }), ["zzz"]);
});

test("a tool that takes no arguments says so", async () => {
  await withServer(async (_call, client) => {
    const { tools } = await client.listTools();
    const none = tools.find((tool) => Object.keys(tool.inputSchema.properties ?? {}).length === 0);
    if (!none) return;
    assert.deepEqual(ignoredArguments(none.name, { zzz: 1 }), ["zzz"]);
  });
});
