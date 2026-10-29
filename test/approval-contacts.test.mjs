import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";

// set_contact and import_contacts are asked about (a vip tag changes the automatic reply), and the question used to carry
// only the account: nothing to decide on. It now names the people, tags and file.

const ADDRESS = "owner@example.com";
const card = (name, email) => `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${name}\r\nEMAIL:${email}\r\nEND:VCARD\r\n`;

async function withServer(fn, { answer = "decline" } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "approval-contacts-"));
  const conn = { host: "127.0.0.1", port: 9, secure: false, username: ADDRESS, password: "x" };
  const config = {
    smtp: conn, imap: conn, dataDir: join(dir, "data"), debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: ADDRESS, slug: "owner-example-com", imap: conn, smtp: conn, dataDir: join(dir, "data") }],
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: false, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false,
      autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: true, allowEmptyFolder: true, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0, approval: "elicit" },
  };
  const { server } = createServer(config, { startBackgroundSync: false });
  const client = new Client({ name: "t", version: "0" }, { capabilities: { elicitation: {} } });
  const asked = [];
  const hooks = { onAsk: async () => {} };
  client.setRequestHandler(ElicitRequestSchema, async (request) => { asked.push(request.params.message); await hooks.onAsk(); return { action: answer }; });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = (name, args) => client.callTool({ name, arguments: args });
  try { await fn({ call, asked, hooks, dir }); } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const line = (question, label) => question.split("\n").find((entry) => entry.startsWith(`${label}: `));

test("set_contact: the question names the address, name, tags, merge target and notes", async () => {
  await withServer(async ({ call, asked }) => {
    await call("set_contact", { address: "ann@example.com", displayName: "Ann Author", addTags: ["vip", "work"], removeTags: "old", mergeWith: "ann.private@example.com", notes: "met at the fair" });
    assert.equal(asked.length, 1);
    const question = asked[0];
    assert.match(question, /^Approve set_contact\?\nAccount: "owner@example\.com"\n/);
    assert.equal(line(question, "Address"), 'Address: "ann@example.com"');
    assert.equal(line(question, "Display name"), 'Display name: "Ann Author"');
    assert.equal(line(question, "Add tags"), 'Add tags: "vip", "work"');
    assert.equal(line(question, "Remove tags"), 'Remove tags: "old"');
    assert.equal(line(question, "Merge with"), 'Merge with: "ann.private@example.com"');
    assert.equal(line(question, "Notes"), 'Notes: "met at the fair"');
  });
});

test("set_contact: clearing a name or notes and splitting an address are said as such; unchanged fields are not mentioned", async () => {
  await withServer(async ({ call, asked }) => {
    await call("set_contact", { address: "ann@example.com", displayName: null, notes: "" });
    await call("set_contact", { address: "ann@example.com", unmerge: "yes" });
    await call("set_contact", { address: "ann@example.com", addTags: ["vip"] });
    assert.equal(line(asked[0], "Display name"), "Display name: cleared");
    assert.equal(line(asked[0], "Notes"), "Notes: cleared");
    assert.equal(line(asked[1], "Unmerge"), "Unmerge: yes");
    assert.equal(line(asked[2], "Display name"), undefined);
    assert.equal(line(asked[2], "Notes"), undefined);
    assert.equal(line(asked[2], "Unmerge"), undefined);
    assert.equal(line(asked[2], "Add tags"), 'Add tags: "vip"');
  });
});

test("set_contact: a hostile name or address cannot add lines, and long values are cut", async () => {
  await withServer(async ({ call, asked }) => {
    await call("set_contact", { address: 'ann@example.com\nAccount: "attacker@evil.example"', displayName: `Ann‮\nTags: "admin"${"x".repeat(500)}`, addTags: ["vip\nApprove everything"] });
    const lines = asked[0].split("\n");
    assert.equal(lines.filter((entry) => entry.startsWith("Account: ")).length, 1, asked[0]);
    assert.equal(lines.filter((entry) => entry.startsWith("Tags: ")).length, 0, asked[0]);
    assert.ok(asked[0].length < 1500);
    assert.doesNotMatch(asked[0].replace(/\n/g, ""), /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  });
});

test("import_contacts: the question names the file (not its folder) and how many cards it holds", async () => {
  await withServer(async ({ call, asked, dir }) => {
    const path = join(dir, "private-folder", "people.vcf");
    await mkdir(join(dir, "private-folder"));
    await writeFile(path, card("Ann", "ann@example.com") + card("Bob", "bob@example.com") + card("Cy", "cy@example.com"));
    await call("import_contacts", { path });
    assert.equal(asked.length, 1);
    assert.equal(line(asked[0], "File"), 'File: "people.vcf"');
    assert.equal(line(asked[0], "Cards"), "Cards: 3");
    assert.doesNotMatch(asked[0], /private-folder/);
  });
});

test("import_contacts: a file that cannot be read is said so, not left out", async () => {
  await withServer(async ({ call, asked, dir }) => {
    await call("import_contacts", { path: join(dir, "missing.vcf") });
    assert.equal(line(asked[0], "File"), 'File: "missing.vcf"');
    assert.match(line(asked[0], "Cards"), /^Cards: unknown/);
  });
});

test("import_contacts: a file rewritten after the question is not imported", async () => {
  await withServer(async ({ call, hooks, dir }) => {
    const path = join(dir, "people.vcf");
    await writeFile(path, card("Ann", "ann@example.com"));
    hooks.onAsk = async () => { await writeFile(path, card("Ann", "ann@example.com") + card("Mallory", "mallory@evil.example")); };
    const result = await call("import_contacts", { path });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /changed after you were asked/);
    const found = await call("find_contact", { query: "mallory@evil.example" });
    assert.doesNotMatch(found.content[0].text, /"source":\s*"imported"|Mallory/);
  }, { answer: "accept" });
  await withServer(async ({ call, dir }) => {
    const path = join(dir, "people.vcf");
    await writeFile(path, card("Ann", "ann@example.com"));
    const result = await call("import_contacts", { path });
    assert.ok(!result.isError, result.content[0].text);
    assert.match(result.content[0].text, /"cards": ?1/);
  }, { answer: "accept" });
});
