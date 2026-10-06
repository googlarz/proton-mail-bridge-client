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
    address,
    slug: slugifyAccountAddress(address),
    imap: { host: "127.0.0.1", port: 9, secure: false, username: address, password: "secret" },
    smtp: { host: "127.0.0.1", port: 9, secure: false, username: address, password: "secret" },
    dataDir,
  };
}

async function withServer(fn) {
  const primaryDir = await mkdtemp(join(tmpdir(), "sync-route-a-"));
  const secondaryDir = await mkdtemp(join(tmpdir(), "sync-route-b-"));
  const primary = accountConfig(primaryDir, "primary@example.com");
  const secondary = accountConfig(secondaryDir, "work@example.com");
  const config = {
    smtp: primary.smtp, imap: primary.imap, dataDir: primaryDir, debug: false, cacheEnabled: true,
    analyticsEnabled: true, autoSync: false, syncInterval: 5,
    runtime: {
      readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [],
      startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25,
      idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: false, allowEmptyFolder: false,
      restrictOutboundToSelf: false, allowFileDownloadDir: undefined, maxInlineBytes: 40960, opDelayMs: 0,
    },
    accounts: [primary, secondary],
  };
  const { server } = createServer(config, { startBackgroundSync: false });
  const client = new Client({ name: "test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    await fn({ client, secondaryDir, secondarySlug: secondary.slug });
  } finally {
    await client.close();
    await server.close();
    await closeTrackedIndexes();
    await rm(primaryDir, { recursive: true, force: true });
    await rm(secondaryDir, { recursive: true, force: true });
  }
}

const TOOLS = ["sync_emails", "sync_folders", "run_background_sync", "wait_for_mailbox_changes"];

test("sync tools declare an account parameter", async () => {
  await withServer(async ({ client }) => {
    const { tools } = await client.listTools();
    for (const name of TOOLS) {
      assert.ok(tools.find((t) => t.name === name)?.inputSchema?.properties?.account, `${name} lacks account`);
    }
  });
});

test("sync tools reject an unknown account instead of silently using the primary", async () => {
  await withServer(async ({ client }) => {
    for (const name of TOOLS) {
      const result = await client.callTool({ name, arguments: { account: "nobody@example.com", timeoutSeconds: 1 } }).catch((e) => ({ isError: true, content: [{ text: String(e.message) }] }));
      assert.equal(result.isError, true, name);
      assert.match(JSON.stringify(result.content), /Unknown account/, name);
    }
  });
});

test("run_background_sync with account reports that account's index, not the primary's", async () => {
  await withServer(async ({ client, secondaryDir, secondarySlug }) => {
    const result = await client.callTool({ name: "run_background_sync", arguments: { account: secondarySlug } });
    const text = result.content.find((p) => p.type === "text").text;
    assert.ok(text.includes(secondaryDir), text.slice(0, 300));
  });
});
