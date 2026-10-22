import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { TOOLS } from "../dist/tools/definitions.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";

async function instructionsFor(tier) {
  const before = process.env.PROTONMAIL_TOOL_TIER;
  if (tier) process.env.PROTONMAIL_TOOL_TIER = tier; else delete process.env.PROTONMAIL_TOOL_TIER;
  const dir = await mkdtemp(join(tmpdir(), "instructions-tier-"));
  const conn = { host: "127.0.0.1", port: 9, secure: false, username: "owner@example.com", password: "x" };
  const config = {
    smtp: conn, imap: conn, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: "owner@example.com", slug: "owner-example-com", imap: conn, smtp: conn, dataDir: dir }],
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: true, allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0 },
  };
  const { server } = createServer(config, { startBackgroundSync: false });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    return { text: client.getInstructions(), exposed: new Set((await client.listTools()).tools.map((t) => t.name)) };
  } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    if (before === undefined) delete process.env.PROTONMAIL_TOOL_TIER; else process.env.PROTONMAIL_TOOL_TIER = before;
  }
}

test("with the core tier the instructions name only tools the client can see", async () => {
  const { text, exposed } = await instructionsFor("core");
  assert.ok(text);
  for (const word of text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []) assert.ok(exposed.has(word), `${word} is named but the client does not see it`);
  assert.ok(!/never mix ids/i.test(text), "the bulk tools do take ids of two accounts");
});

test("the server hands the client short instructions, and every tool they name exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "instructions-"));
  const conn = { host: "127.0.0.1", port: 9, secure: false, username: "owner@example.com", password: "x" };
  const config = {
    smtp: conn, imap: conn, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: "owner@example.com", slug: "owner-example-com", imap: conn, smtp: conn, dataDir: dir }],
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: true, allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0 },
  };
  const { server } = createServer(config, { startBackgroundSync: false });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    const text = client.getInstructions();
    assert.ok(text && text.length < 1500, "present and short");
    const names = new Set(TOOLS.map((tool) => tool.name));
    for (const word of text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []) assert.ok(names.has(word), `${word} is named but is not a tool`);
    assert.match(text, /<slug>::/);
  } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
