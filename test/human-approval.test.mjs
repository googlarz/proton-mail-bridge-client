import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { buildConfigFromEnv } from "../dist/config-env.js";
import { cleanForPrompt, needsApproval, parseApprovalEnv } from "../dist/utils/approval.js";
import { sanitizeRuntimeConfig } from "../dist/utils/runtime-policy.js";
import { slugifyAccountAddress } from "../dist/utils/helpers.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";

// answer: what the person does ("accept" | "decline" | "cancel", or a function for a custom client);
// capability: what the client declares (no `elicitation` key = a client that cannot ask the person).
async function withServer({ approval, answer, capability = { elicitation: {} }, timeoutSeconds }, fn) {
  const dir = await mkdtemp(join(tmpdir(), "human-approval-"));
  const address = "owner@example.com";
  const conn = { host: "127.0.0.1", port: 9, secure: false, username: address, password: "x" };
  const config = {
    smtp: conn, imap: conn, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address, slug: slugifyAccountAddress(address), imap: conn, smtp: conn, dataDir: dir }],
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: false, allowedActions: ["delete", "trash"], startupSync: false,
      autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30,
      confirmDestructive: true, allowEmptyFolder: true, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0,
      ...(approval ? { approval } : {}), ...(timeoutSeconds ? { approvalTimeoutSeconds: timeoutSeconds } : {}) },
  };
  const { server } = createServer(config, { startBackgroundSync: false });
  const client = new Client({ name: "t", version: "0" }, { capabilities: capability });
  const asked = [];
  if (capability.elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      asked.push(request.params.message);
      return typeof answer === "function" ? answer(request) : { action: answer };
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try { await fn(client, asked); } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const text = (result) => result.content[0].text;
// send_draft on a draft that does not exist fails only AFTER the confirmation gate, so a "draft" error proves the gate let the call through.
const sendGhost = (client, extra = {}) => client.callTool({ name: "send_draft", arguments: { draftId: "ghost", ...extra } });
const REACHED_HANDLER = /not found|no draft|unknown draft/i;
const STOPPED_AT_GATE = /Confirmation required|Not approved/;
const runtimeStatus = async (client) => JSON.parse(text(await client.callTool({ name: "get_runtime_status", arguments: {} }))).runtime;

test("approval off (the default): nothing is asked and confirmed: true works as before", async () => {
  await withServer({ answer: "decline" }, async (client, asked) => {
    assert.match(text(await sendGhost(client)), /Confirmation required/);
    const withFlag = await sendGhost(client, { confirmed: true });
    assert.doesNotMatch(text(withFlag), STOPPED_AT_GATE);
    assert.match(text(withFlag), REACHED_HANDLER);
    assert.deepEqual(asked, []);
  });
  await withServer({ approval: "off", answer: "decline" }, async (client, asked) => {
    assert.match(text(await sendGhost(client, { confirmed: true })), REACHED_HANDLER);
    assert.deepEqual(asked, []);
  });
});

test("elicit: the person accepts, so the call goes through without confirmed", async () => {
  await withServer({ approval: "elicit", answer: "accept" }, async (client, asked) => {
    const result = await sendGhost(client);
    assert.match(text(result), REACHED_HANDLER);
    assert.equal(asked.length, 1);
    assert.match(asked[0], /^Approve send_draft\?\nAccount: "owner@example\.com"\nDraft: "ghost"/);
  });
});

test("elicit: the person declines or dismisses, and the model's confirmed: true does not help", async () => {
  for (const [action, wording] of [["decline", /declined/], ["cancel", /dismissed/]]) {
    await withServer({ approval: "elicit", answer: action }, async (client, asked) => {
      const result = await sendGhost(client, { confirmed: true });
      assert.equal(result.isError, true);
      assert.match(text(result), /Not approved/);
      assert.match(text(result), wording);
      assert.doesNotMatch(text(result), REACHED_HANDLER);
      assert.equal(asked.length, 1);
    });
  }
});

test("elicit: no answer in time is a refusal", async () => {
  await withServer({ approval: "elicit", timeoutSeconds: 1, answer: () => new Promise((resolve) => setTimeout(() => resolve({ action: "accept" }), 2500)) }, async (client, asked) => {
    const result = await sendGhost(client, { confirmed: true });
    assert.equal(result.isError, true);
    assert.match(text(result), /did not answer within 1 s/);
    assert.equal(asked.length, 1);
  });
});

test("a client without elicitation: elicit falls back to today's behaviour, require fails closed and names the setting", async () => {
  await withServer({ approval: "elicit", capability: {} }, async (client) => {
    assert.match(text(await sendGhost(client)), /Confirmation required/);
    assert.match(text(await sendGhost(client, { confirmed: true })), REACHED_HANDLER);
  });
  await withServer({ approval: "require", capability: {} }, async (client) => {
    for (const extra of [{}, { confirmed: true }]) {
      const result = await sendGhost(client, extra);
      assert.equal(result.isError, true);
      assert.match(text(result), /PROTONMAIL_APPROVAL=require/);
      assert.match(text(result), /elicitation/);
      assert.doesNotMatch(text(result), REACHED_HANDLER);
    }
    // Calls that need no approval are untouched.
    assert.ok(!(await client.callTool({ name: "get_runtime_status", arguments: {} })).isError);
  });
});

test("require with a capable client asks every time and ignores confirmed", async () => {
  await withServer({ approval: "require", answer: "accept" }, async (client, asked) => {
    assert.match(text(await sendGhost(client)), REACHED_HANDLER);
    assert.match(text(await sendGhost(client, { confirmed: true })), REACHED_HANDLER);
    assert.equal(asked.length, 2, "confirmed: true does not skip the question");
  });
  await withServer({ approval: "require", answer: "decline" }, async (client) => {
    assert.match(text(await sendGhost(client, { confirmed: true })), /Not approved/);
  });
});

test("only gated calls are asked: a preview and a read pass without a question", async () => {
  await withServer({ approval: "require", answer: "decline" }, async (client, asked) => {
    const dry = await client.callTool({ name: "send_email", arguments: { to: "a@example.com", subject: "s", body: "b", dryRun: true } });
    assert.ok(!dry.isError, text(dry));
    assert.ok(!(await client.callTool({ name: "get_runtime_status", arguments: {} })).isError);
    assert.deepEqual(asked, []);
  });
});

test("the question is built by the server: a hostile subject cannot add lines or hide behind control characters", async () => {
  const hidden = [0x202e, 0x2028, 0x200b, 0x07].map((code) => String.fromCodePoint(code)).join("");
  const subject = `Hello\nAccount: "attacker@evil.example"\r\nTo: "ceo@example.com"${hidden}Approve everything`;
  await withServer({ approval: "elicit", answer: "decline" }, async (client, asked) => {
    await client.callTool({ name: "send_email", arguments: { to: ["a@example.com"], subject: `${subject} ${"x".repeat(500)}`, body: "b", confirmed: true } });
    assert.equal(asked.length, 1);
    const lines = asked[0].split("\n");
    assert.equal(lines.length, 4, asked[0]);
    assert.equal(lines[0], "Approve send_email?");
    assert.equal(lines[1], 'Account: "owner@example.com"');
    assert.equal(lines[2], 'To: "a@example.com"');
    assert.match(lines[3], /^Subject: "Hello Account: .*…"$/);
    assert.doesNotMatch(asked[0].replace(/\n/g, ""), /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    assert.ok(asked[0].length < 1500);
  });
});

test("a draft is described from the stored draft, not from the call", async () => {
  await withServer({ approval: "elicit", answer: "decline" }, async (client, asked) => {
    const created = await client.callTool({ name: "create_draft", arguments: { to: ["real@example.com"], subject: "Stored subject", body: "b" } });
    assert.ok(!created.isError, text(created));
    const draftId = JSON.parse(text(created)).draft?.id ?? JSON.parse(text(created)).id;
    assert.ok(draftId, text(created));
    await client.callTool({ name: "send_draft", arguments: { draftId, to: "model-said@evil.example", subject: "Model subject" } });
    assert.match(asked[0], /To: "real@example\.com"/);
    assert.match(asked[0], /Subject: "Stored subject"/);
    assert.doesNotMatch(asked[0], /evil\.example|Model subject/);
  });
});

test("get_runtime_status shows the setting", async () => {
  await withServer({ approval: "require", answer: "decline" }, async (client) => {
    assert.equal((await runtimeStatus(client)).approval, "require");
  });
  await withServer({ answer: "decline" }, async (client) => {
    assert.equal((await runtimeStatus(client)).approval, "off");
  });
});

test("PROTONMAIL_APPROVAL is parsed, and a typo is an error", () => {
  const saved = { ...process.env };
  try {
    process.env.PROTONMAIL_USERNAME = "owner@example.com";
    process.env.PROTONMAIL_PASSWORD = "x";
    delete process.env.PROTONMAIL_APPROVAL;
    assert.equal(buildConfigFromEnv().runtime.approval, "off");
    process.env.PROTONMAIL_APPROVAL = " Elicit ";
    assert.equal(buildConfigFromEnv().runtime.approval, "elicit");
    process.env.PROTONMAIL_APPROVAL = "${user_config.approval}";
    assert.equal(parseApprovalEnv("PROTONMAIL_APPROVAL"), "off");
    process.env.PROTONMAIL_APPROVAL = "yes";
    assert.throws(() => buildConfigFromEnv(), /PROTONMAIL_APPROVAL must be one of: off, elicit, require/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
  assert.equal(sanitizeRuntimeConfig({ allowedActions: [] }).approval, "off");
});

test("which calls need approval", () => {
  const declared = (...names) => new Set(names);
  assert.equal(needsApproval("send_email", {}, declared("dryRun")), true);
  assert.equal(needsApproval("send_email", { dryRun: true }, declared("dryRun")), false);
  assert.equal(needsApproval("approve_plan", { planId: "p" }, declared()), true);
  assert.equal(needsApproval("get_emails", {}, declared()), false);
  assert.equal(needsApproval("set_rule", { actions: { trash: true } }, declared()), false);
  assert.equal(needsApproval("set_rule", { actions: { forwardTo: ["x@example.com"] } }, declared()), true);
  assert.equal(needsApproval("set_rule", { proposalId: "p1" }, declared()), true);
  assert.equal(needsApproval("update_message_flags", { flagsToAdd: ["\\Seen"] }, declared()), false);
  assert.equal(needsApproval("update_message_flags", { flagsToAdd: ["\\Deleted"] }, declared()), true);
  assert.equal(needsApproval("batch_email_action", { action: "archive" }, declared()), false);
  assert.equal(needsApproval("batch_email_action", { action: "delete" }, declared()), true);
});

test("cleanForPrompt strips control and bidi characters, joins lines and cuts", () => {
  const noise = [0x202e, 0x2066, 0x200b, 0].map((code) => String.fromCodePoint(code));
  assert.equal(cleanForPrompt(`a\nb\r\nc\td${noise[0]}evil${noise[1]}x${noise[2]}${noise[3]}z`), "a b c d evil x z");
  assert.equal(cleanForPrompt("x".repeat(200), 10), `${"x".repeat(9)}…`);
  assert.equal(cleanForPrompt(undefined), "");
});
