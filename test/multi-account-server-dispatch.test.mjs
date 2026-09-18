import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../dist/index.js";
import { DraftStoreService } from "../dist/services/draft-store-service.js";
import { DeliveryQueueService } from "../dist/services/delivery-queue-service.js";
import { slugifyAccountAddress, withAccountPrefix } from "../dist/utils/helpers.js";

// First test that drives the real MCP handlers (createServer + in-memory transport)
// for a multi-account config. Found by external review of 2.1.18: MCP resources were
// primary-account-only, and list_scheduled_sends had no default bound.

function accountConfig(dataDir, address) {
  return {
    address,
    slug: slugifyAccountAddress(address),
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: address, password: "secret" },
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: address, password: "secret" },
    dataDir,
  };
}

function buildConfig(primaryDir, secondaryDir) {
  const primary = accountConfig(primaryDir, "primary@example.com");
  const secondary = accountConfig(secondaryDir, "workaddress@example.com");
  return {
    smtp: primary.smtp,
    imap: primary.imap,
    dataDir: primaryDir,
    debug: false,
    cacheEnabled: true,
    analyticsEnabled: true,
    autoSync: false,
    syncInterval: 5,
    runtime: {
      readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [],
      startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25,
      idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: false, allowEmptyFolder: false,
      restrictOutboundToSelf: false, allowFileDownloadDir: undefined, maxInlineBytes: 40960, opDelayMs: 0,
    },
    accounts: [primary, secondary],
    _secondary: secondary,
  };
}

async function withServer(seed, fn) {
  const primaryDir = await mkdtemp(join(tmpdir(), "dispatch-primary-"));
  const secondaryDir = await mkdtemp(join(tmpdir(), "dispatch-secondary-"));
  const config = buildConfig(primaryDir, secondaryDir);
  const secondaryConfig = { ...config, dataDir: secondaryDir, smtp: config._secondary.smtp, imap: config._secondary.imap };
  await seed({ secondaryConfig });
  const { server } = createServer(config, { startBackgroundSync: false });
  const client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await fn({ client, secondarySlug: config._secondary.slug });
  } finally {
    await client.close();
    await server.close();
    await rm(primaryDir, { recursive: true, force: true });
    await rm(secondaryDir, { recursive: true, force: true });
  }
}

test("a secondary account's draft is listed as a resource with a prefixed URI and can be read back", async () => {
  let draftId;
  await withServer(
    async ({ secondaryConfig }) => {
      const draft = await new DraftStoreService(secondaryConfig).createDraft({ to: ["x@example.com"], subject: "Secondary draft", body: "hello" });
      draftId = draft.id;
    },
    async ({ client, secondarySlug }) => {
      const prefixed = withAccountPrefix(secondarySlug, draftId);
      const { resources } = await client.listResources();
      const entry = resources.find((r) => r.name === prefixed);
      assert.ok(entry, "the secondary draft must be enumerated under its prefixed id");
      const read = await client.readResource({ uri: entry.uri });
      assert.match(read.contents[0].text, /Secondary draft/);
    },
  );
});

test("list_scheduled_sends is bounded by default, newest first, and pages with offset/hasMore", async () => {
  await withServer(
    async ({ secondaryConfig }) => {
      const queue = new DeliveryQueueService(secondaryConfig);
      for (let i = 0; i < 55; i++) {
        await queue.enqueue({ to: ["x@example.com"], subject: `s${i}`, body: "b" }, new Date(Date.now() + 3_600_000).toISOString(), "undo_send");
      }
    },
    async ({ client }) => {
      const call = async (args) => JSON.parse((await client.callTool({ name: "list_scheduled_sends", arguments: args })).content[0].text);
      const first = await call({});
      assert.equal(first.total, 55);
      assert.equal(first.returned, 50);
      assert.equal(first.hasMore, true);
      assert.equal(first.items[0].payload.subject, "s54", "newest first");
      const second = await call({ offset: 50 });
      assert.equal(second.returned, 5);
      assert.equal(second.hasMore, false);
      const all = await call({ limit: 10000 });
      assert.equal(all.returned, 55);
    },
  );
});
