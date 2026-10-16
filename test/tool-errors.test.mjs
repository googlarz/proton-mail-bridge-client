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



// A tool that ran and failed answers with an isError result carrying the real message, so Claude Desktop shows it to
// the model (it hides protocol errors behind a generic "connector returned an error"). Only a tool that does not
// exist is still a protocol error. The CLI starts the server with PROTONMAIL_TOOL_ERRORS=protocol to keep its stderr.

test("a refused call comes back as an isError result with the message, not as a thrown protocol error", async () => {
  await withServer(["owner@example.com"], async ({ client }) => {
    const result = await client.callTool({ name: "mark_email_read", arguments: { emailId: "INBOX::1", isRead: "perhaps" } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /true or false/i);
    assert.doesNotMatch(result.content[0].text, /^MCP error/);
  });
});

test("an argument problem, a policy refusal and a missing resource all read the same way", async () => {
  await withServer(["owner@example.com"], async ({ client }) => {
    for (const [name, args, message] of [
      ["get_email_by_id", { emailId: "not-an-id" }, /emailId|identifier/i],
      ["send_email", { to: "a@b.test" }, /subject|body|required/i],
      ["bulk_delete", { folder: "INBOX", match: { from: "a@b.test" } }, /disabled by the current runtime policy/i],
    ]) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, name);
      assert.match(result.content[0].text, message, name);
    }
  });
});

test("a tool that does not exist is still a protocol error", async () => {
  await withServer(["owner@example.com"], async ({ client }) => {
    await assert.rejects(client.callTool({ name: "no_such_tool", arguments: {} }), /Unknown tool/);
  });
});

test("PROTONMAIL_TOOL_ERRORS=protocol (the CLI's setting) keeps the thrown error", async () => {
  const saved = process.env.PROTONMAIL_TOOL_ERRORS;
  process.env.PROTONMAIL_TOOL_ERRORS = "protocol";
  try {
    await withServer(["owner@example.com"], async ({ client }) => {
      await assert.rejects(client.callTool({ name: "mark_email_read", arguments: { emailId: "INBOX::1", isRead: "perhaps" } }), /true or false/i);
    });
  } finally {
    if (saved === undefined) delete process.env.PROTONMAIL_TOOL_ERRORS; else process.env.PROTONMAIL_TOOL_ERRORS = saved;
  }
});
