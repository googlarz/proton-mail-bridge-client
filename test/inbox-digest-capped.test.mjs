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

// get_inbox_digest must say when its counts only cover the newest indexed messages.
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
  localIndexService.getInboxDigest = async ({ limit }) => ({ counts: {}, ...(globalThis.__capped ? { countsCapped: true } : {}), indexUpdatedAt: "2026-09-30T00:00:00Z", topThreads: TOP.slice(0, limit), staleAwaitingYou: STALE.slice(0, limit) });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try { await fn(async (args) => JSON.parse((await client.callTool({ name: "get_inbox_digest", arguments: args })).content[0].text)); } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

test("digest surfaces countsCapped when the index reports it", async () => {
  globalThis.__capped = true;
  try { await withServer(async (call) => { const r = await call({}); assert.equal(r.countsCapped, true); assert.match(r.countsNote, /5000/); }); } finally { delete globalThis.__capped; }
});

test("digest omits countsCapped when counts are complete", async () => {
  await withServer(async (call) => { const r = await call({}); assert.equal(r.countsCapped, undefined); });
});
