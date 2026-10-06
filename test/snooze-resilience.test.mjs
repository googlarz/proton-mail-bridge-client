import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { SnoozeService } from "../dist/services/snooze-service.js";
import { createServer } from "../dist/index.js";
import { createEmailId } from "../dist/utils/helpers.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";

net.Socket.prototype.connect = () => { throw new Error("Network disabled in this test file"); };

// A snooze was marked "failed" for good after five failed wake attempts in a row, and with the check running every
// 15 s that is about 75 seconds of Bridge being down, or of the server running in read-only mode. The message stayed
// in the snooze folder, cancel_snooze on a failed record moved nothing, and the record was deleted after 30 days:
// the only pointer to the message. Only a failure that retrying cannot fix should count.

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function config(dataDir, readOnly = false) {
  return {
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "x" },
    dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    runtime: { readOnly, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false,
      autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false,
      maxInlineBytes: 40960, opDelayMs: 0, sendDelaySeconds: 0 },
  };
}

function fakeImap() {
  const imap = {
    mode: "ok", moves: [], uid: 100,
    async createFolder() { return { path: "Folders/MCP-Snoozed", created: true }; },
    async withTimeout(promise) { return promise; },
    async moveEmail(emailId, targetFolder) {
      imap.moves.push({ from: emailId, to: targetFolder });
      if (imap.mode === "down") throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1143"), { code: "ECONNREFUSED" });
      if (imap.mode === "timeout") throw new Error("Timed out after 30000ms waking snooze x");
      if (imap.mode === "gone") throw new Error(`Email not found for id ${emailId}`);
      const targetUid = imap.uid++;
      return { emailId, targetFolder, uid: targetUid, targetUid, targetEmailId: `${targetFolder}::${targetUid}` };
    },
  };
  return imap;
}

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "protonmail-snooze-resilience-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

const dueSnooze = async (service) => service.snooze(createEmailId("INBOX", 5, "100"), new Date(Date.now() + 60_000).toISOString());
async function makeDue(service, dir) {
  // Rewind the wake time through the store so the next checkDue() considers it due.
  const record = await dueSnooze(service);
  const { readFile, writeFile } = await import("node:fs/promises");
  const path = join(dir, "snoozed.json");
  const store = JSON.parse(await readFile(path, "utf8"));
  store.items[record.id].wakeAt = new Date(Date.now() - 1000).toISOString();
  await writeFile(path, JSON.stringify(store));
  return record.id;
}

test("a Bridge outage does not use up the wake attempts: the message is woken when Bridge is back", async () => {
  await withDir(async (dir) => {
    const imap = fakeImap();
    const service = new SnoozeService(config(dir), imap, quiet);
    const id = await makeDue(service, dir);
    imap.mode = "down";
    for (let tick = 0; tick < 12; tick += 1) await service.checkDue();
    let record = await service.get(id);
    assert.equal(record.status, "pending", "still waiting, not failed");
    assert.equal(record.failureCount ?? 0, 0, "an outage is not counted as a failure of the snooze");
    imap.mode = "ok";
    const result = await service.checkDue();
    assert.equal(result.woken, 1);
    record = await service.get(id);
    assert.equal(record.status, "woken");
  });
});

test("a timeout does not use up the wake attempts either", async () => {
  await withDir(async (dir) => {
    const imap = fakeImap();
    const service = new SnoozeService(config(dir), imap, quiet);
    const id = await makeDue(service, dir);
    imap.mode = "timeout";
    for (let tick = 0; tick < 8; tick += 1) await service.checkDue();
    assert.equal((await service.get(id)).status, "pending");
  });
});

test("running read-only does not fail a due snooze, and it wakes once writes are allowed again", async () => {
  await withDir(async (dir) => {
    const imap = fakeImap();
    const cfg = config(dir, false);
    const service = new SnoozeService(cfg, imap, quiet);
    const id = await makeDue(service, dir);
    cfg.runtime.readOnly = true; // the server restarted into read-only mode before the wake time
    for (let tick = 0; tick < 8; tick += 1) await service.checkDue();
    assert.equal((await service.get(id)).status, "pending");
    assert.equal(imap.moves.length, 1, "only the original move into the snooze folder: nothing was attempted while read-only");
    cfg.runtime.readOnly = false;
    await service.checkDue();
    assert.equal((await service.get(id)).status, "woken");
  });
});

test("a failure that retrying cannot fix (the message is gone) still ends as failed after the retry cap", async () => {
  await withDir(async (dir) => {
    const imap = fakeImap();
    const service = new SnoozeService(config(dir), imap, quiet);
    const id = await makeDue(service, dir);
    imap.mode = "gone";
    for (let tick = 0; tick < 6; tick += 1) await service.checkDue();
    const record = await service.get(id);
    assert.equal(record.status, "failed");
    assert.match(record.failureReason, /not found/i);
  });
});

test("cancel_snooze on a failed snooze tries to put the message back", async () => {
  await withDir(async (dir) => {
    const imap = fakeImap();
    const service = new SnoozeService(config(dir), imap, quiet);
    const id = await makeDue(service, dir);
    imap.mode = "gone";
    for (let tick = 0; tick < 6; tick += 1) await service.checkDue();
    assert.equal((await service.get(id)).status, "failed");

    imap.mode = "ok";
    const before = imap.moves.length;
    const restored = await service.cancel(id);
    assert.equal(imap.moves.length, before + 1, "a move back was attempted");
    assert.equal(imap.moves.at(-1).to, "INBOX");
    assert.equal(restored.status, "canceled");
  });
});

test("if the message still cannot be moved back, a failed snooze stays failed with the reason", async () => {
  await withDir(async (dir) => {
    const imap = fakeImap();
    const service = new SnoozeService(config(dir), imap, quiet);
    const id = await makeDue(service, dir);
    imap.mode = "gone";
    for (let tick = 0; tick < 6; tick += 1) await service.checkDue();
    const record = await service.cancel(id).catch((error) => error);
    assert.ok(record instanceof Error || record.status === "failed");
    assert.equal((await service.get(id)).status, "failed");
  });
});

test("a message that is already in the snooze folder cannot be snoozed again", async () => {
  await withDir(async (dir) => {
    const imap = fakeImap();
    const service = new SnoozeService(config(dir), imap, quiet);
    await assert.rejects(
      service.snooze(createEmailId("Folders/MCP-Snoozed", 7, "100"), new Date(Date.now() + 60_000).toISOString()),
      /already (snoozed|in the snooze)/i,
    );
    assert.equal(imap.moves.length, 0);
  });
});

test("snooze_email refuses a wake time further away than ten years, and a date without a time zone is read as UTC", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "snooze-handler-"));
  const smtp = { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "x" };
  const imap = { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "x" };
  const base = config(dataDir);
  base.runtime.allowedActions = ["archive", "mark_read", "move", "trash"];
  const { server, accountManager } = createServer({ ...base, smtp, imap, accounts: [{ address: "owner@example.com", slug: "owner-example-com", imap, smtp, dataDir }] }, { startBackgroundSync: false });
  const wakes = [];
  accountManager.primary().snoozeService.snooze = async (_emailId, wakeAt) => { wakes.push(wakeAt); return { id: "s1", currentEmailId: "x", wakeAt }; };
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const emailId = createEmailId("INBOX", 5, "100");
  try {
    await assert.rejects(
      client.callTool({ name: "snooze_email", arguments: { emailId, wakeAt: "+275760-09-13T00:00:00.000Z" } }),
      (error) => error instanceof McpError && error.code === -32602,
    );
    const year = new Date().getUTCFullYear() + 1;
    await client.callTool({ name: "snooze_email", arguments: { emailId, wakeAt: `${year}-03-05T09:30:00` } });
    assert.equal(wakes[0], `${year}-03-05T09:30:00.000Z`, "no offset given: UTC, not the server's local time");
  } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
