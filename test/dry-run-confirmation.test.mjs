import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { slugifyAccountAddress } from "../dist/utils/helpers.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";

async function withServer(fn) {
  const dir = await mkdtemp(join(tmpdir(), "dry-run-confirm-"));
  const address = "owner@example.com";
  const conn = { host: "127.0.0.1", port: 9, secure: false, username: address, password: "x" };
  const config = {
    smtp: conn, imap: conn, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address, slug: slugifyAccountAddress(address), imap: conn, smtp: conn, dataDir: dir }],
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: ["delete", "trash"], startupSync: false,
      autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30,
      confirmDestructive: true, allowEmptyFolder: true, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0 },
  };
  const { server } = createServer(config, { startBackgroundSync: false });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try { await fn(client); } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const text = (result) => result.content[0].text;

test("a dry run previews without the confirmation a real send or delete needs", async () => {
  await withServer(async (client) => {
    const real = await client.callTool({ name: "send_email", arguments: { to: "a@example.com", subject: "s", body: "b" } });
    assert.equal(real.isError, true);
    assert.match(text(real), /Confirmation required/, "the real call still asks");

    const dry = await client.callTool({ name: "send_email", arguments: { to: "a@example.com", subject: "s", body: "b", dryRun: true } });
    assert.ok(!dry.isError, text(dry));
    assert.equal(JSON.parse(text(dry)).dryRun, true);
  });
});

test("a tool without a dry run is not unlocked by passing dryRun", async () => {
  await withServer(async (client) => {
    const result = await client.callTool({ name: "delete_email", arguments: { emailId: "INBOX::1", dryRun: true } });
    assert.equal(result.isError, true);
    assert.match(text(result), /Confirmation required/);
  });
});
