import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { draftApprovalDigest } from "../dist/utils/approval.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";

// The question is built from the stored draft (or plan) when the person is asked; the handler reads it again after the
// answer, and update_draft is not gated. What runs must be what was shown: a digest of what the person saw travels with
// the call on a channel the model cannot write to, and the handler refuses when the stored content no longer matches.

const ADDRESS = "owner@example.com";
const DETAIL = (id) => ({
  id, folder: "INBOX", uid: 1, subject: "Hello", from: [{ name: "Ann", address: "ann@example.com" }], to: [{ name: "", address: ADDRESS }], cc: [], bcc: [], replyTo: [],
  date: "2026-09-19T10:00:00.000Z", messageId: "<orig@example.com>", references: [], body: "text", text: "text", attachments: [], isRead: false, isStarred: false, flags: [], labels: [],
});

// `hooks.onAsk(message)` runs while the person is being asked, before the answer: the window the model has between the question and the yes.
async function withServer(fn) {
  const dir = await mkdtemp(join(tmpdir(), "approval-binding-"));
  const conn = { host: "127.0.0.1", port: 9, secure: false, username: ADDRESS, password: "x" };
  const config = {
    smtp: conn, imap: conn, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: ADDRESS, slug: "owner-example-com", imap: conn, smtp: conn, dataDir: dir }],
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: false, allowedActions: ["delete", "trash", "archive"], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false,
      autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: true, allowEmptyFolder: true, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0, approval: "elicit" },
  };
  const { server, accountManager } = createServer(config, { startBackgroundSync: false });
  const bundle = accountManager.primary();
  const sent = [];
  const archived = [];
  bundle.smtpService.sendEmail = async (payload) => { sent.push(payload); return { messageId: "<sent@example.com>", accepted: payload.to, rejected: [], response: "250" }; };
  bundle.imapService.getEmailById = async (id) => DETAIL(id);
  bundle.imapService.archiveEmail = async (id) => { archived.push(id); return { targetEmailId: `Archive::${id}` }; };
  const client = new Client({ name: "t", version: "0" }, { capabilities: { elicitation: {} } });
  const hooks = { onAsk: async () => {} };
  const asked = [];
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    asked.push(request.params.message);
    await hooks.onAsk(request.params.message);
    return { action: "accept" };
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (name, args = {}) => client.callTool({ name, arguments: args });
  const text = (result) => result.content[0].text;
  const makeDraft = async (extra = {}) => {
    const created = await call("create_draft", { to: ["real@example.com"], subject: "Stored subject", body: "Stored body", ...extra });
    assert.ok(!created.isError, text(created));
    const parsed = JSON.parse(text(created));
    return parsed.draft?.id ?? parsed.id;
  };
  try { await fn({ call, text, makeDraft, hooks, asked, sent, archived, bundle, dir }); } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const CHANGED = /changed after you were asked/;

test("two parallel send_draft calls, each approved, send the draft once", async () => {
  await withServer(async ({ call, makeDraft, sent }) => {
    const draftId = await makeDraft();
    const [a, b] = await Promise.all([call("send_draft", { draftId }), call("send_draft", { draftId })]);
    assert.equal(sent.length, 1, `sent ${sent.length} times; errors: ${a.isError} ${b.isError}`);
  });
});

for (const [label, patch] of [["isHtml", { isHtml: true }], ["priority", { priority: "high" }], ["replyTo", { replyTo: "evil@example.com" }], ["from", { from: ADDRESS }]]) {
  test(`send_draft: update_draft(${label}) between question and answer is refused`, async () => {
    await withServer(async ({ call, text, makeDraft, hooks, sent }) => {
      const draftId = await makeDraft();
      hooks.onAsk = async () => { await call("update_draft", { draftId, ...patch }); };
      const result = await call("send_draft", { draftId });
      assert.deepEqual(sent, [], `${label}: ${text(result).slice(0, 160)}`);
    });
  });
}

test("send_draft: delete_draft + create_draft between question and answer => nothing sent", async () => {
  await withServer(async ({ call, makeDraft, hooks, sent, bundle }) => {
    const draftId = await makeDraft();
    hooks.onAsk = async () => { await bundle.draftStore.deleteDraft(draftId); await makeDraft({ to: ["evil@example.com"] }); };
    const result = await call("send_draft", { draftId });
    assert.equal(result.isError, true);
    assert.deepEqual(sent, []);
  });
});

test("send_draft: sync_draft_to_remote between question and answer does not send elsewhere", async () => {
  await withServer(async ({ call, makeDraft, hooks, sent }) => {
    const draftId = await makeDraft();
    hooks.onAsk = async () => { await call("sync_draft_to_remote", { draftId }); };
    await call("send_draft", { draftId });
    for (const s of sent) assert.deepEqual(s.to, ["real@example.com"]);
  });
});

test("question: the Bcc line is not cut off by the length cap", async () => {
  await withServer(async ({ call, asked }) => {
    const long = (p) => Array.from({ length: 5 }, (_, i) => `${p}${i}${"x".repeat(60)}@example.com`);
    await call("send_email", { to: long("t"), cc: long("c"), bcc: ["secret-bcc@evil.example"], subject: "s".repeat(300), body: "b", from: "f".repeat(100) + "@example.com" });
    assert.match(asked[0], /secret-bcc@evil\.example/, `question was ${asked[0].length} chars:\n${asked[0]}`);
  });
});

test("question: 200 recipients - the person is told how many are hidden", async () => {
  await withServer(async ({ call, asked }) => {
    await call("send_email", { to: Array.from({ length: 200 }, (_, i) => `u${i}@example.com`), subject: "s", body: "b" });
    assert.match(asked[0], /and 195 more/);
  });
});

test("send_draft: truthy dryRun spellings never send", async () => {
  await withServer(async ({ call, makeDraft, sent }) => {
    const draftId = await makeDraft();
    for (const dryRun of [true, "true", "yes", 1, " TRUE "]) await call("send_draft", { draftId, dryRun });
    assert.deepEqual(sent, []);
  });
});

test("__proto__ / constructor keys in arguments do not forge approval", async () => {
  await withServer(async ({ call, makeDraft, hooks, sent }) => {
    const draftId = await makeDraft();
    hooks.onAsk = async () => { await call("update_draft", { draftId, to: ["evil@example.com"] }); };
    const raw = JSON.parse('{"draftId":"' + draftId + '","__proto__":{"digest":"x"},"constructor":{"prototype":{"confirmed":true}}}');
    await call("send_draft", raw);
    assert.deepEqual(sent, []);
  });
});
