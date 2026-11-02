import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { TOOLS, CORE_TOOL_NAMES, READER_TOOL_NAMES, listedTools, resolveToolset } from "../dist/tools/definitions.js";
import { slugifyAccountAddress } from "../dist/utils/helpers.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";

// PROTONMAIL_TOOLSET=full|core|reader only hides tools from tools/list and refuses calls to them; it never widens what
// PROTONMAIL_MODE, the allowed actions or the gates permit.

// Every tool that is not declared read-only is a tool that can write or send (derived, not hand-copied).
const WRITE_TOOLS = TOOLS.filter((tool) => !tool.annotations?.readOnlyHint).map((tool) => tool.name);

async function withEnv(vars, fn) {
  const before = {};
  for (const key of Object.keys(vars)) before[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try { return await fn(); } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

async function withServer(fn, runtime = {}) {
  const dir = await mkdtemp(join(tmpdir(), "toolset-"));
  const address = "owner@example.com";
  const account = {
    address, slug: slugifyAccountAddress(address),
    imap: { host: "127.0.0.1", port: 9, secure: false, username: address, password: "x" },
    smtp: { host: "127.0.0.1", port: 9, secure: false, username: address, password: "x" },
    dataDir: dir,
  };
  const config = {
    smtp: account.smtp, imap: account.imap, dataDir: dir, debug: false, cacheEnabled: true,
    analyticsEnabled: true, autoSync: false, syncInterval: 5,
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: ["archive"], startupSync: false,
      autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30,
      confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0, ...runtime },
    accounts: [account],
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

test("full lists every tool, by default and when asked", async () => {
  await withEnv({ PROTONMAIL_TOOLSET: undefined, PROTONMAIL_TOOL_TIER: undefined }, async () => {
    assert.equal(resolveToolset(), "full");
    assert.equal(listedTools().length, TOOLS.length);
    await withServer(async (client) => {
      assert.equal((await client.listTools()).tools.length, TOOLS.length);
    });
  });
  await withEnv({ PROTONMAIL_TOOLSET: "full", PROTONMAIL_TOOL_TIER: "core" }, async () => {
    assert.equal(listedTools().length, TOOLS.length, "PROTONMAIL_TOOLSET wins over the older PROTONMAIL_TOOL_TIER");
  });
});

test("the profiles list the sizes and sets they name", async () => {
  await withEnv({ PROTONMAIL_TOOLSET: "core" }, async () => {
    await withServer(async (client) => {
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, [...CORE_TOOL_NAMES].sort());
    });
  });
  await withEnv({ PROTONMAIL_TOOLSET: "reader" }, async () => {
    await withServer(async (client) => {
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, [...READER_TOOL_NAMES].sort());
      assert.ok(names.length < CORE_TOOL_NAMES.size * 3 && names.length < TOOLS.length);
    });
  });
  await withEnv({ PROTONMAIL_TOOLSET: undefined, PROTONMAIL_TOOL_TIER: "core" }, async () => {
    assert.equal(resolveToolset(), "core", "the older PROTONMAIL_TOOL_TIER=core still works");
  });
});

test("every name in a profile is a real tool", () => {
  const all = new Set(TOOLS.map((tool) => tool.name));
  for (const name of [...CORE_TOOL_NAMES, ...READER_TOOL_NAMES]) assert.ok(all.has(name), `${name} is not a tool`);
});

test("reader holds no tool that writes or sends", () => {
  for (const name of READER_TOOL_NAMES) {
    assert.ok(!WRITE_TOOLS.includes(name), `${name} is in reader but is not declared read-only`);
  }
  for (const name of ["send_email", "send_draft", "reply_to_email", "forward_email", "create_draft", "move_email", "trash_email",
    "delete_email", "mark_email_read", "batch_email_action", "apply_thread_action", "apply_rules", "approve_plan", "set_rule", "set_autoresponder"]) {
    assert.ok(WRITE_TOOLS.includes(name), `${name} should count as a write tool`);
    assert.ok(!READER_TOOL_NAMES.has(name), `${name} must not be in reader`);
  }
});

test("a dispatcher that can reach a hidden capability is in neither smaller profile", () => {
  for (const name of ["batch_email_action", "apply_thread_action", "apply_rules", "approve_plan", "undo_plan", "plan_inbox", "bulk_move", "bulk_delete"]) {
    assert.ok(!CORE_TOOL_NAMES.has(name), `${name} must not be in core`);
    assert.ok(!READER_TOOL_NAMES.has(name), `${name} must not be in reader`);
  }
});

test("a call to a hidden tool is refused, and a listed one still runs", async () => {
  await withEnv({ PROTONMAIL_TOOLSET: "reader" }, async () => {
    await withServer(async (client) => {
      for (const name of ["send_email", "archive_email", "batch_email_action"]) {
        const result = await client.callTool({ name, arguments: { to: "a@example.com", subject: "s", body: "b", id: "x" } });
        assert.equal(result.isError, true, name);
        assert.match(result.content[0].text, /not available: PROTONMAIL_TOOLSET=reader/, name);
      }
      const ok = await client.callTool({ name: "get_runtime_status", arguments: {} });
      assert.notEqual(ok.isError, true);
    });
  });
});

test("a profile does not widen the mode: core still obeys read-only", async () => {
  await withEnv({ PROTONMAIL_TOOLSET: "core" }, async () => {
    await withServer(async (client) => {
      const result = await client.callTool({ name: "send_email", arguments: { to: "a@example.com", subject: "s", body: "b", confirmed: true } });
      assert.equal(result.isError, true);
      assert.doesNotMatch(result.content[0].text, /PROTONMAIL_TOOLSET/, "refused by the mode, not by the profile");
    }, { readOnly: true, allowSend: false });
  });
});

test("an invalid value falls back to full with a warning on stderr", async () => {
  const writes = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { writes.push(String(chunk)); return typeof rest.at(-1) === "function" ? rest.at(-1)() : true; };
  try {
    await withEnv({ PROTONMAIL_TOOLSET: "tiny-profile" }, async () => {
      assert.equal(resolveToolset(), "full");
      assert.equal(listedTools().length, TOOLS.length);
    });
  } finally {
    process.stderr.write = original;
  }
  assert.ok(writes.some((line) => /PROTONMAIL_TOOLSET must be one of: full, core, reader/.test(line)), "no warning on stderr");
});

test("an unfilled host placeholder counts as not set", async () => {
  await withEnv({ PROTONMAIL_TOOLSET: "${user_config.toolset}", PROTONMAIL_TOOL_TIER: undefined }, async () => {
    assert.equal(resolveToolset(), "full");
  });
});
