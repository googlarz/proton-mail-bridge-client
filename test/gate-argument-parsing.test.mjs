import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { TOOLS } from "../dist/tools/definitions.js";
import { TAINT_GATED_TOOLS, isGatedAction } from "../dist/utils/mail-security.js";
import { buildApprovalMessage, needsApproval } from "../dist/utils/approval.js";
import { slugifyAccountAddress } from "../dist/utils/helpers.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";

// The gate and the approval decide from the same argument the handler acts on. The handlers read a flag with
// normalizeBoolean / optionalBoolean ("false", "no", "off", 0, " FALSE " all mean false), so a predicate that compares
// with `=== false` lets "dryRun: 'false'" run for real without being asked. Each flag below is read through the handlers' parser.

const declaredOf = (name) => new Set(Object.keys(TOOLS.find((tool) => tool.name === name).inputSchema.properties ?? {}));
const FALSE_LIKE = [false, "false", "no", "off", 0, "0", " FALSE "];
const TRUE_LIKE = [true, "true", "yes", "on", 1, "1", " TRUE "];
const NOT_GIVEN = [null, undefined];
const GARBAGE = "garbage";
const label = (value) => (value === undefined ? "undefined" : JSON.stringify(value));

// apply_rules previews unless dryRun is false: only an explicit false-like value runs it for real.
test("apply_rules: every spelling of false runs for real, so every one is gated and needs approval", () => {
  const declared = declaredOf("apply_rules");
  for (const value of FALSE_LIKE) {
    assert.equal(isGatedAction("apply_rules", { dryRun: value }, declared), true, `isGatedAction dryRun ${label(value)}`);
    assert.equal(needsApproval("apply_rules", { dryRun: value }, declared), true, `needsApproval dryRun ${label(value)}`);
  }
  for (const value of [...TRUE_LIKE, ...NOT_GIVEN]) {
    assert.equal(isGatedAction("apply_rules", { dryRun: value }, declared), false, `isGatedAction dryRun ${label(value)}`);
    assert.equal(needsApproval("apply_rules", { dryRun: value }, declared), false, `needsApproval dryRun ${label(value)}`);
  }
  assert.equal(isGatedAction("apply_rules", {}, declared), false, "no dryRun is the preview");
  // The handler refuses a value that is not a boolean spelling; so does the gate, with the same error.
  assert.throws(() => isGatedAction("apply_rules", { dryRun: GARBAGE }, declared), /Expected true or false/);
  assert.throws(() => needsApproval("apply_rules", { dryRun: GARBAGE }, declared), /Expected true or false/);
});

// Every other gated tool that declares dryRun: a preview passes, however it is spelled; anything else is gated.
test("dryRun on the other gated tools: true-like spellings preview, everything else is gated", () => {
  const withDryRun = [...TAINT_GATED_TOOLS, "batch_email_action", "apply_thread_action"].filter((name) => declaredOf(name).has("dryRun"));
  assert.ok(withDryRun.length >= 6, withDryRun.join(","));
  for (const name of withDryRun) {
    const declared = declaredOf(name);
    // batch_email_action and apply_thread_action are only gated for an action that destroys.
    const base = name === "batch_email_action" || name === "apply_thread_action" ? { action: "delete" } : {};
    for (const value of TRUE_LIKE) {
      assert.equal(isGatedAction(name, { ...base, dryRun: value }, declared), false, `${name} isGatedAction dryRun ${label(value)}`);
      assert.equal(needsApproval(name, { ...base, dryRun: value }, declared), false, `${name} needsApproval dryRun ${label(value)}`);
    }
    for (const value of [...FALSE_LIKE, ...NOT_GIVEN]) {
      assert.equal(isGatedAction(name, { ...base, dryRun: value }, declared), true, `${name} isGatedAction dryRun ${label(value)}`);
      assert.equal(needsApproval(name, { ...base, dryRun: value }, declared), true, `${name} needsApproval dryRun ${label(value)}`);
    }
    assert.throws(() => isGatedAction(name, { ...base, dryRun: GARBAGE }, declared), /Expected true or false/, name);
  }
});

test("a dryRun the tool does not declare is still ignored, whatever its spelling", () => {
  for (const value of TRUE_LIKE) {
    assert.equal(isGatedAction("empty_folder", { dryRun: value }, declaredOf("empty_folder")), true, label(value));
    assert.equal(isGatedAction("set_contact", { dryRun: value }, declaredOf("set_contact")), true, label(value));
  }
});

// Switching off is always allowed; only an explicit false-like enabled is a switch-off.
test("enabled on set_rule and set_autoresponder: a switch-off passes in every spelling", () => {
  for (const name of ["set_rule", "set_autoresponder"]) {
    const declared = declaredOf(name);
    assert.ok(declared.has("enabled"));
    for (const value of FALSE_LIKE) {
      assert.equal(isGatedAction(name, { enabled: value }, declared), false, `${name} isGatedAction enabled ${label(value)}`);
      assert.equal(needsApproval(name, { enabled: value }, declared), false, `${name} needsApproval enabled ${label(value)}`);
    }
    for (const value of [...TRUE_LIKE, ...NOT_GIVEN, ""]) {
      assert.equal(isGatedAction(name, { enabled: value }, declared), true, `${name} isGatedAction enabled ${label(value)}`);
      assert.equal(needsApproval(name, { enabled: value }, declared), true, `${name} needsApproval enabled ${label(value)}`);
    }
    assert.throws(() => isGatedAction(name, { enabled: GARBAGE }, declared), /Expected true or false/, name);
  }
});

// `active` is read the same way, for a tool that declares it (none does today).
test("active: read with the handlers' parser for a tool that declares it", () => {
  const declared = new Set(["active"]);
  for (const value of FALSE_LIKE) assert.equal(isGatedAction("set_contact", { active: value }, declared), false, label(value));
  for (const value of [...TRUE_LIKE, ...NOT_GIVEN]) assert.equal(isGatedAction("set_contact", { active: value }, declared), true, label(value));
  assert.equal(isGatedAction("set_contact", { active: false }, new Set()), true, "undeclared");
});

// The handler trims the action (requireString), so " delete" deletes; the gate must see the same word.
test("batch_email_action and apply_thread_action: the action is read the way the handler reads it", () => {
  for (const name of ["batch_email_action", "apply_thread_action"]) {
    const declared = declaredOf(name);
    for (const action of ["delete", " delete", "trash ", "\ttrash\n", "  delete  "]) {
      assert.equal(isGatedAction(name, { action }, declared), true, `${name} ${JSON.stringify(action)}`);
      assert.equal(needsApproval(name, { action }, declared), true, `${name} ${JSON.stringify(action)}`);
    }
    for (const action of ["archive", " archive ", "mark_read", "move"]) {
      assert.equal(isGatedAction(name, { action }, declared), false, `${name} ${JSON.stringify(action)}`);
    }
  }
});

const lookups = {
  account: () => "owner@example.com",
  subject: async () => "A subject",
  draft: async () => undefined,
  plan: async () => undefined,
  reply: async () => undefined,
};

// bulk_delete and delete_thread read `permanent` with normalizeBoolean: the question must not say "no" for "true".
test("the question reads permanent the way the handler does", async () => {
  for (const [name, args] of [["bulk_delete", { emailIds: ["a"] }], ["delete_thread", { messageId: "m" }]]) {
    for (const value of TRUE_LIKE) {
      assert.match(await buildApprovalMessage(name, { ...args, permanent: value }, lookups), /Permanently: yes/, `${name} ${label(value)}`);
    }
    for (const value of [...FALSE_LIKE, ...NOT_GIVEN]) {
      assert.match(await buildApprovalMessage(name, { ...args, permanent: value }, lookups), /Permanently: no/, `${name} ${label(value)}`);
    }
  }
});

async function withServer(fn) {
  const dir = await mkdtemp(join(tmpdir(), "gate-parsing-"));
  const address = "owner@example.com";
  const conn = { host: "127.0.0.1", port: 9, secure: false, username: address, password: "x" };
  const config = {
    smtp: conn, imap: conn, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address, slug: slugifyAccountAddress(address), imap: conn, smtp: conn, dataDir: dir }],
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: false, allowedActions: ["delete", "trash"], startupSync: false,
      autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30,
      confirmDestructive: true, allowEmptyFolder: true, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0, approval: "require" },
  };
  const { server } = createServer(config, { startBackgroundSync: false });
  const client = new Client({ name: "t", version: "0" }, { capabilities: { elicitation: {} } });
  const asked = [];
  client.setRequestHandler(ElicitRequestSchema, async (request) => { asked.push(request.params.message); return { action: "decline" }; });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try { await fn(client, asked); } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("through a server: apply_rules with dryRun 'false' asks the person, a preview does not", async () => {
  await withServer(async (client, asked) => {
    for (const value of ["false", "no", "off", 0, "0", " FALSE "]) {
      asked.length = 0;
      const result = await client.callTool({ name: "apply_rules", arguments: { dryRun: value } });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Not approved/, label(value));
      assert.equal(asked.length, 1, `asked for dryRun ${label(value)}`);
    }
    for (const value of [true, "true", undefined]) {
      asked.length = 0;
      const result = await client.callTool({ name: "apply_rules", arguments: value === undefined ? {} : { dryRun: value } });
      assert.doesNotMatch(result.content[0].text, /Not approved/, label(value));
      assert.equal(asked.length, 0, `no question for dryRun ${label(value)}`);
    }
  });
});

test("through a server: a padded action is asked about like a plain one", async () => {
  await withServer(async (client, asked) => {
    const result = await client.callTool({ name: "batch_email_action", arguments: { emailIds: ["INBOX::1::1::abc"], action: " delete " } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Not approved/);
    assert.equal(asked.length, 1);
  });
});
