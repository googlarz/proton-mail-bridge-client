import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";

// The schema is what a client (and a model) is told it can send. These were found by comparing every tool's
// schema with what its handler reads.

async function tools() {
  const dir = await mkdtemp(join(tmpdir(), "schema-contract-"));
  const smtp = { host: "127.0.0.1", port: 1025, secure: false, username: "o@example.com", password: "x" };
  const imap = { ...smtp, port: 1143 };
  const { server } = createServer({
    smtp, imap, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: "o@example.com", slug: "o", imap, smtp, dataDir: dir }],
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false,
      autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false,
      maxInlineBytes: 40960, opDelayMs: 0, sendDelaySeconds: 0 },
  }, { startBackgroundSync: false });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

test("tools whose handler asks for confirmation (permanent delete) declare the confirmed parameter", async () => {
  const all = await tools();
  for (const name of ["batch_email_action", "apply_thread_action"]) {
    const tool = all.find((t) => t.name === name);
    assert.ok(tool.inputSchema.properties.confirmed, `${name} must declare confirmed`);
    assert.equal(tool.inputSchema.properties.confirmed.type, "boolean");
  }
});

test("reply_to_email does not require a body when a markdownBody can be given instead", async () => {
  const tool = (await tools()).find((t) => t.name === "reply_to_email");
  assert.ok(!(tool.inputSchema.required ?? []).includes("body"), JSON.stringify(tool.inputSchema.required));
  assert.ok(tool.inputSchema.properties.markdownBody, "markdownBody is declared");
  assert.match(tool.description, /body|markdownBody/i);
});

test("list_snoozed's status filter lists every status a snooze can have", async () => {
  const tool = (await tools()).find((t) => t.name === "list_snoozed");
  assert.deepEqual([...tool.inputSchema.properties.status.enum].sort(), ["canceled", "failed", "pending", "waking", "woken"]);
});

test("limit parameters state the cap that is applied to them", async () => {
  const all = await tools();
  for (const name of ["get_emails", "search_emails"]) {
    const limit = all.find((t) => t.name === name).inputSchema.properties.limit;
    assert.match(limit.description, /250/, `${name}: the limit is capped at 250 and the schema must say so`);
    assert.equal(limit.maximum, 250);
  }
});
