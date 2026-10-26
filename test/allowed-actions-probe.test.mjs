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

// With the mailbox writable but no action allowed (PROTONMAIL_ALLOWED_ACTIONS empty), no tool may reach a method that moves,
// archives, trashes, deletes or re-flags a message. (Folder, label and draft management are governed by other switches.)
// Same method as read-only-probe. Every writing-looking method of every service is
// replaced by one that records the call and fails, then each tool is called with plausible arguments. The exceptions are
// deliberate: removing a rule is always allowed (so a user can always switch things off), and saving an attachment writes
// a file into the download folder the user configured, not into the mailbox.

const WRITES = /^(moveEmail|archiveEmail|trashEmail|restoreEmail|deleteEmail|markEmail|starEmail|updateMessageFlags|expunge|bulk|moveThread|deleteThread|emptyFolder|applyThread|batch)/;
const ALLOWED = new Set();
const SERVICES = ["imapService"];

function sample(schema) {
  const args = {};
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    const required = (schema.required ?? []).includes(key);
    if (!required && !["folder", "emailId", "emailIds", "threadId", "draftId", "path", "id", "enabled", "dryRun", "confirmed"].includes(key)) continue;
    const type = Array.isArray(property.type) ? property.type[0] : property.type;
    if (key === "emailId") args[key] = createEmailId("INBOX", 1, "100");
    else if (key === "emailIds") args[key] = [createEmailId("INBOX", 1, "100")];
    else if (key === "confirmed" || key === "enabled") args[key] = true;
    else if (key === "dryRun") args[key] = false;
    else if (type === "string") args[key] = property.enum ? property.enum[0] : "INBOX";
    else if (type === "number" || type === "integer") args[key] = 1;
    else if (type === "boolean") args[key] = false;
    else if (type === "array") args[key] = ["x@example.com"];
    else if (type === "object") args[key] = {};
  }
  return args;
}

test("with no action allowed, no tool reaches a method that moves, trashes, deletes or re-flags mail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "allowed-actions-probe-"));
  const address = "owner@example.com";
  const conn = { host: "127.0.0.1", port: 9, secure: false, username: address, password: "x" };
  const accounts = [{ address, slug: slugifyAccountAddress(address), imap: conn, smtp: conn, dataDir: join(dir, address) }];
  const config = {
    smtp: conn, imap: conn, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5, accounts,
    runtime: { readOnly: false, allowSend: false, allowRemoteDraftSync: false, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: true, allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0 },
  };
  const { server, accountManager } = createServer(config, { startBackgroundSync: false });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const [primary] = accountManager.all();
  const touched = [];
  for (const service of SERVICES) {
    const object = primary[service];
    const seen = new Set();
    for (let o = object; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const key of Object.getOwnPropertyNames(o)) {
        if (seen.has(key) || key === "constructor") continue;
        seen.add(key);
        let value;
        try { value = object[key]; } catch { continue; }
        if (typeof value === "function" && WRITES.test(key)) object[key] = () => { touched.push(`${service}.${key}`); throw new Error(`trapped ${service}.${key}`); };
      }
    }
  }
  try {
    const offenders = [];
    for (const tool of TOOLS) {
      touched.length = 0;
      await client.callTool({ name: tool.name, arguments: sample(tool.inputSchema) }).catch(() => {});
      if (touched.length && !ALLOWED.has(tool.name)) offenders.push(`${tool.name} -> ${[...new Set(touched)].join(", ")}`);
    }
    assert.ok(TOOLS.length >= 100);
    assert.deepEqual(offenders, []);
  } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
