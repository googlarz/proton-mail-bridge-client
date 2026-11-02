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


function accountConfig(dataDir, address) {
  return {
    address, slug: slugifyAccountAddress(address),
    imap: { host: "127.0.0.1", port: 9, secure: false, username: address, password: "x" },
    smtp: { host: "127.0.0.1", port: 9, secure: false, username: address, password: "x" },
    dataDir,
  };
}

async function withServer(addresses, fn) {
  const dirs = await Promise.all(addresses.map(() => mkdtemp(join(tmpdir(), "folder-account-"))));
  const accounts = addresses.map((address, i) => accountConfig(dirs[i], address));
  const config = {
    smtp: accounts[0].smtp, imap: accounts[0].imap, dataDir: dirs[0], debug: false, cacheEnabled: true,
    analyticsEnabled: true, autoSync: false, syncInterval: 5,
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: ["delete"], startupSync: false,
      autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30,
      confirmDestructive: false, allowEmptyFolder: true, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0 },
    accounts,
  };
  const { server, accountManager } = createServer(config, { startBackgroundSync: false });
  const bundles = accountManager.all();
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try { await fn({ client, bundles }); } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
  }
}



// The server offers ready-made workflows as MCP prompts. Each only instructs the assistant; each names tools that
// exist; each says to ask before sending or changing anything.

import { MAIL_PROMPTS } from "../dist/utils/mail-prompts.js";

test("the server declares prompts and lists every workflow", async () => {
  await withServer(["owner@example.com"], async ({ client }) => {
    assert.ok(client.getServerCapabilities()?.prompts, "prompts capability missing");
    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.map((prompt) => prompt.name).sort(), MAIL_PROMPTS.map((prompt) => prompt.name).sort());
    assert.ok(prompts.length >= 6);
    for (const prompt of prompts) assert.ok(prompt.description, `${prompt.name} has no description`);
  });
});

test("every prompt names only tools that exist, mentions them, and asks before changing anything", async () => {
  await withServer(["owner@example.com"], async ({ client }) => {
    const { tools } = await client.listTools();
    const known = new Set(tools.map((tool) => tool.name));
    for (const prompt of MAIL_PROMPTS) {
      const args = Object.fromEntries((prompt.arguments ?? []).filter((a) => a.required).map((a) => [a.name, "Anna"]));
      const result = await client.getPrompt({ name: prompt.name, arguments: args });
      const text = result.messages.map((message) => message.content.text).join("\n");
      for (const tool of prompt.tools) {
        assert.ok(known.has(tool), `${prompt.name} names ${tool}, which is not a tool`);
        assert.ok(text.includes(tool), `${prompt.name} does not mention ${tool}`);
      }
      assert.match(text, /without asking me first/, `${prompt.name} does not ask first`);
    }
  });
});

test("a required argument is checked and used; an unknown prompt is an error that lists the valid ones", async () => {
  await withServer(["owner@example.com"], async ({ client }) => {
    await assert.rejects(client.getPrompt({ name: "prepare-for-meeting", arguments: {} }), /needs the argument "who"/);
    await assert.rejects(client.getPrompt({ name: "prepare-for-meeting", arguments: { who: "   " } }), /needs the argument/);
    const ok = await client.getPrompt({ name: "prepare-for-meeting", arguments: { who: "anna@example.com" } });
    assert.match(ok.messages[0].content.text, /anna@example\.com/);
    await assert.rejects(client.getPrompt({ name: "nope" }), /Unknown prompt "nope"\. Available: morning-brief/);
  });
});

// Under a narrower tool profile (PROTONMAIL_TOOLSET) a prompt must not tell the model to call a tool the server refuses.
import { TOOLS, isToolListed } from "../dist/tools/definitions.js";

test("each prompt's tools list covers every tool its text names", () => {
  for (const prompt of MAIL_PROMPTS) {
    const args = Object.fromEntries((prompt.arguments ?? []).map((a) => [a.name, "x"]));
    const text = prompt.render(args);
    const named = TOOLS.map((tool) => tool.name).filter((name) => new RegExp(`\\b${name}\\b`).test(text));
    assert.deepEqual([...named].sort(), [...prompt.tools].sort(), `${prompt.name}: tools list and text disagree`);
  }
});

test("a narrower profile hides the prompts that name a tool it does not list, and refuses them", async () => {
  const saved = { set: process.env.PROTONMAIL_TOOLSET, tier: process.env.PROTONMAIL_TOOL_TIER };
  try {
    for (const profile of ["core", "reader"]) {
      process.env.PROTONMAIL_TOOLSET = profile;
      const expected = MAIL_PROMPTS.filter((prompt) => prompt.tools.every((tool) => isToolListed(tool))).map((prompt) => prompt.name);
      await withServer(["owner@example.com"], async ({ client }) => {
        const { prompts } = await client.listPrompts();
        assert.deepEqual(prompts.map((prompt) => prompt.name).sort(), expected.sort(), profile);
        for (const prompt of MAIL_PROMPTS.filter((entry) => !expected.includes(entry.name))) {
          await assert.rejects(client.getPrompt({ name: prompt.name, arguments: { who: "Anna" } }), /Unknown prompt/, `${profile}/${prompt.name}`);
        }
      });
    }
    process.env.PROTONMAIL_TOOLSET = "reader";
    assert.ok(MAIL_PROMPTS.some((prompt) => !prompt.tools.every((tool) => isToolListed(tool))), "reader should hide at least one prompt");
  } finally {
    if (saved.set === undefined) delete process.env.PROTONMAIL_TOOLSET; else process.env.PROTONMAIL_TOOLSET = saved.set;
    if (saved.tier === undefined) delete process.env.PROTONMAIL_TOOL_TIER; else process.env.PROTONMAIL_TOOL_TIER = saved.tier;
  }
});
