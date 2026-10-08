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

// Every tool is called through the real MCP server, with arguments made from its own schema, against a Bridge
// that does not exist (a closed port). The answer may be a result or a clean error; it must never be a crash
// in the handler itself ("Cannot read properties of undefined", "is not a function", ...), and never hang.
// Run with one account and with two, so the single-account branch and the fan-out merge branch both execute.

const CRASH = /TypeError|ReferenceError|RangeError|Cannot read propert|is not a function|is not defined|is not iterable|undefined is not|Maximum call stack/i;
const CLOSED_PORT = 9;

function accountConfig(dataDir, address) {
  return {
    address,
    slug: slugifyAccountAddress(address),
    imap: { host: "127.0.0.1", port: CLOSED_PORT, secure: false, username: address, password: "x" },
    smtp: { host: "127.0.0.1", port: CLOSED_PORT, secure: false, username: address, password: "x" },
    dataDir,
  };
}

function buildConfig(dirs) {
  const accounts = dirs.map((dir, i) => accountConfig(dir, i === 0 ? "owner@example.com" : `second${i}@example.com`));
  return {
    smtp: accounts[0].smtp, imap: accounts[0].imap, dataDir: dirs[0], debug: false, cacheEnabled: true,
    analyticsEnabled: true, autoSync: false, syncInterval: 5,
    runtime: {
      readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: ["mark_read", "mark_unread", "star", "unstar", "archive", "trash", "restore", "move", "delete"],
      startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25,
      idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: false, allowEmptyFolder: false,
      restrictOutboundToSelf: false, allowFileDownloadDir: undefined, maxInlineBytes: 40960, opDelayMs: 0, sendDelaySeconds: 0,
    },
    accounts,
  };
}

function sample(name, schema) {
  if (schema.enum?.length) return schema.enum[0];
  switch (schema.type) {
    case "string":
      if (/email|address|^to$|^cc$|^bcc$|^from$|replyTo/i.test(name)) return "someone@example.com";
      if (/id$/i.test(name)) return "INBOX::1";
      if (/date|since|before|wakeAt/i.test(name)) return "2026-01-01T00:00:00Z";
      return "test";
    case "number":
    case "integer":
      return 1;
    case "boolean":
      return false;
    case "array":
      return schema.items ? [sample(name, schema.items)] : [];
    case "object":
      return Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([k]) => schema.required?.includes(k)).map(([k, v]) => [k, sample(k, v)]));
    default:
      return "test";
  }
}

function argsFor(tool) {
  const props = tool.inputSchema.properties ?? {};
  const required = tool.inputSchema.required ?? [];
  const args = Object.fromEntries(required.map((key) => [key, sample(key, props[key] ?? {})]));
  if ("timeoutSeconds" in props) args.timeoutSeconds = 1;
  if ("timeBudgetSeconds" in props) args.timeBudgetSeconds = 1;
  return args;
}

async function exerciseAllTools(accountCount) {
  const dirs = await Promise.all(Array.from({ length: accountCount }, () => mkdtemp(join(tmpdir(), "dispatch-all-"))));
  const { server } = createServer(buildConfig(dirs), { startBackgroundSync: false });
  const client = new Client({ name: "dispatch-all", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const crashes = [];
  const slow = [];
  let called = 0;
  try {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      for (const args of [{}, argsFor(tool)]) {
        const started = Date.now();
        let text = "";
        try {
          const result = await Promise.race([
            client.callTool({ name: tool.name, arguments: args }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("HANG")), 25_000)),
          ]);
          text = (result.content ?? []).map((part) => part.text ?? "").join("\n");
        } catch (error) {
          text = String(error?.message ?? error);
        }
        called += 1;
        if (Date.now() - started > 15_000) slow.push(`${tool.name} ${Date.now() - started}ms`);
        if (text === "HANG" || /HANG/.test(text) && text.length < 10) crashes.push(`${tool.name}: no answer in 25 s`);
        else if (CRASH.test(text)) crashes.push(`${tool.name} ${JSON.stringify(args).slice(0, 80)}: ${text.slice(0, 200)}`);
      }
    }
  } finally {
    await client.close();
    await server.close();
    await closeTrackedIndexes();
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
  }
  return { crashes, slow, called };
}

test("every tool answers without crashing, one account", { timeout: 600_000 }, async () => {
  const { crashes, called } = await exerciseAllTools(1);
  assert.ok(called >= 180, `only ${called} calls`);
  assert.deepEqual(crashes, []);
});

test("every tool answers without crashing, two accounts", { timeout: 600_000 }, async () => {
  const { crashes, called } = await exerciseAllTools(2);
  assert.ok(called >= 180, `only ${called} calls`);
  assert.deepEqual(crashes, []);
});
