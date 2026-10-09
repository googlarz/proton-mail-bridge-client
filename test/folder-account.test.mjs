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

// The folder tools acted on the primary account only: get_folders shows "<slug>::" folders but create/rename/delete/empty
// took that prefix as part of the name. They now route by the prefix or the `account` argument, like the mail tools.

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
  const calls = [];
  bundles.forEach((bundle, index) => {
    const record = (method) => async (...args) => { calls.push({ account: index, method, args }); return { path: args[0], created: true, deleted: true, total: 3 }; };
    for (const method of ["createFolder", "renameFolder", "deleteFolder", "emptyFolder", "getFolderStats"]) bundle.imapService[method] = record(method);
  });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try { await fn({ client, bundles, calls }); } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
  }
}

const call = async (client, name, args) => {
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    return { error: r.isError === true, text, json: (() => { try { return JSON.parse(r.content.find((c) => c.type === "text" && !c.text.startsWith("Note:"))?.text ?? ""); } catch { return undefined; } })() };
  } catch (error) { return { error: true, text: String(error?.message ?? error), json: undefined }; }
};


const FOLDER_TOOLS = ["create_folder", "rename_folder", "delete_folder", "empty_folder"];
const W = "work@example.com";
const slug = slugifyAccountAddress(W);

test("the folder tools declare an account argument", async () => {
  await withServer(["owner@example.com", W], async ({ client }) => {
    const { tools } = await client.listTools();
    for (const name of FOLDER_TOOLS) assert.ok(tools.find((tool) => tool.name === name)?.inputSchema?.properties?.account, `${name} has no account argument`);
  });
});

test("a folder path with an account prefix acts on that account, with the bare path", async () => {
  await withServer(["owner@example.com", W], async ({ client, calls }) => {
    assert.equal((await call(client, "create_folder", { path: `${slug}::Folders/Zażółć/gęślą` })).error, false);
    assert.equal((await call(client, "rename_folder", { path: `${slug}::Folders/a`, newPath: "Folders/b" })).error, false);
    assert.equal((await call(client, "delete_folder", { path: `${slug}::Folders/b`, confirmed: true })).error, false);
    assert.equal((await call(client, "empty_folder", { folder: `${slug}::Folders/b`, confirmed: true })).error, false);
    assert.deepEqual(calls.map((c) => [c.account, c.method, ...c.args]), [
      [1, "createFolder", "Folders/Zażółć/gęślą"], [1, "renameFolder", "Folders/a", "Folders/b"],
      [1, "deleteFolder", "Folders/b"], [1, "emptyFolder", "Folders/b"],
    ]);
  });
});

test("the account argument picks the account; without either the primary account is used", async () => {
  await withServer(["owner@example.com", W], async ({ client, calls }) => {
    await call(client, "create_folder", { path: "Folders/x", account: W });
    await call(client, "create_folder", { path: "Folders/y" });
    await call(client, "create_folder", { path: "Folders/z", account: slug });
    assert.deepEqual(calls.map((c) => [c.account, c.args[0]]), [[1, "Folders/x"], [0, "Folders/y"], [1, "Folders/z"]]);
  });
});

test("a prefix and an account argument that disagree are refused, and nothing is touched", async () => {
  await withServer(["owner@example.com", W, "third@example.com"], async ({ client, calls }) => {
    const r = await call(client, "create_folder", { path: `${slug}::Folders/x`, account: "third@example.com" });
    assert.equal(r.error, true);
    assert.match(r.text, /different accounts/);
    const r2 = await call(client, "rename_folder", { path: `${slug}::Folders/a`, newPath: `${slugifyAccountAddress("third@example.com")}::Folders/b` });
    assert.equal(r2.error, true);
    assert.equal(calls.length, 0);
  });
});

test("text that only looks like a prefix stays part of the path on the primary account", async () => {
  await withServer(["owner@example.com", W], async ({ client, calls }) => {
    await call(client, "create_folder", { path: "no-such-account::Folders/x" });
    assert.deepEqual(calls.map((c) => [c.account, c.args[0]]), [[0, "no-such-account::Folders/x"]]);
  });
});
