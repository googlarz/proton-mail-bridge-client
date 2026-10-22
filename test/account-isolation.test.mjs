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
import { createEmailId, slugifyAccountAddress } from "../dist/utils/helpers.js";

// For every tool that takes an `account`: name the second account and see whether the PRIMARY account's services are
// touched. Every method of the primary's services records the call and fails, so a handler that reads or writes the
// wrong account's mailbox shows up here instead of in somebody's mail. The audit log is the one thing allowed: an
// action on any account is recorded in the primary's audit log.

const SERVICES = ["imapService", "smtpService", "localIndexService", "draftStore", "deliveryQueueService", "snoozeService", "templateService", "replyReminderService", "autoresponderService", "rulesService", "backgroundSyncService"];

function trap(object, label, touched) {
  const seen = new Set();
  for (let o = object; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const key of Object.getOwnPropertyNames(o)) {
      if (seen.has(key) || key === "constructor") continue;
      seen.add(key);
      let value;
      try { value = object[key]; } catch { continue; }
      if (typeof value === "function") {
        object[key] = function () { touched?.push(`${label}.${key}`); throw new Error(`trapped ${label}.${key}`); };
      }
    }
  }
}

function sampleArguments(schema, secondSlug, secondAddress) {
  const args = {};
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    if (key === "account") { args[key] = secondAddress; continue; }
    const required = (schema.required ?? []).includes(key);
    if (!required && !["folder", "emailId", "emailIds", "threadId", "draftId", "path", "id"].includes(key)) continue;
    const type = Array.isArray(property.type) ? property.type[0] : property.type;
    if (key === "emailId") args[key] = `${secondSlug}::${createEmailId("INBOX", 1, "100")}`;
    else if (key === "emailIds") args[key] = [`${secondSlug}::${createEmailId("INBOX", 1, "100")}`];
    else if (type === "string") args[key] = property.enum ? property.enum[0] : "INBOX";
    else if (type === "number" || type === "integer") args[key] = 1;
    else if (type === "boolean") args[key] = false;
    else if (type === "array") args[key] = ["x@example.com"];
    else if (type === "object") args[key] = {};
  }
  return args;
}

test("no tool that takes an account argument touches the primary account when another one is named", async () => {
  const dir = await mkdtemp(join(tmpdir(), "account-isolation-"));
  const make = (address) => ({
    address, slug: slugifyAccountAddress(address),
    imap: { host: "127.0.0.1", port: 9, secure: false, username: address, password: "x" },
    smtp: { host: "127.0.0.1", port: 9, secure: false, username: address, password: "x" },
    dataDir: join(dir, address),
  });
  const accounts = [make("owner@example.com"), make("work@example.com")];
  const config = {
    smtp: accounts[0].smtp, imap: accounts[0].imap, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5, accounts,
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: ["delete", "move", "trash", "mark_read", "mark_unread", "star", "unstar", "archive", "restore"], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: false, allowEmptyFolder: true, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0 },
  };
  const { server, accountManager } = createServer(config, { startBackgroundSync: false });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const [primary, second] = accountManager.all();
  const touched = [];
  for (const service of SERVICES) {
    trap(primary[service], `primary.${service}`, touched);
    trap(second[service], `second.${service}`);
  }
  try {
    const checked = [];
    const offenders = [];
    for (const tool of TOOLS) {
      if (!("account" in (tool.inputSchema.properties ?? {}))) continue;
      touched.length = 0;
      await client.callTool({ name: tool.name, arguments: sampleArguments(tool.inputSchema, accounts[1].slug, accounts[1].address) }).catch(() => {});
      checked.push(tool.name);
      if (touched.length) offenders.push(`${tool.name} -> ${[...new Set(touched)].join(", ")}`);
    }
    assert.ok(checked.length >= 40, `expected the account-aware tools, found ${checked.length}`);
    assert.deepEqual(offenders, []);
  } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
