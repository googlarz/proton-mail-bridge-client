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

test("send_draft: update_draft between the question and the answer => refused, nothing is sent", async () => {
  await withServer(async ({ call, text, makeDraft, hooks, asked, sent }) => {
    const draftId = await makeDraft();
    hooks.onAsk = async () => { assert.ok(!(await call("update_draft", { draftId, to: ["evil@example.com"] })).isError); };
    const result = await call("send_draft", { draftId });
    assert.equal(result.isError, true);
    assert.match(text(result), CHANGED);
    assert.equal(asked.length, 1);
    assert.match(asked[0], /real@example\.com/);
    assert.deepEqual(sent, []);
    const stored = JSON.parse(text(await call("get_draft", { draftId })));
    assert.equal(stored.draft?.status ?? stored.status, "draft", "the draft is left as it was, not claimed");
  });
});

test("send_draft: every part of what goes out is bound (body, subject, cc, bcc, attachment)", async () => {
  const swaps = {
    body: { body: "A different body" },
    subject: { subject: "A different subject" },
    cc: { cc: ["extra@example.com"] },
    bcc: { bcc: ["hidden@example.com"] },
    attachment: { attachments: [{ filename: "a.txt", content: Buffer.from("x").toString("base64"), contentType: "text/plain" }] },
  };
  for (const [part, patch] of Object.entries(swaps)) {
    await withServer(async ({ call, text, makeDraft, hooks, sent }) => {
      const draftId = await makeDraft();
      hooks.onAsk = async () => { assert.ok(!(await call("update_draft", { draftId, ...patch })).isError, part); };
      const result = await call("send_draft", { draftId });
      assert.equal(result.isError, true, part);
      assert.match(text(result), CHANGED, part);
      assert.deepEqual(sent, [], part);
    });
  }
});

test("send_draft: an unchanged draft is sent, to who was shown", async () => {
  await withServer(async ({ call, text, makeDraft, asked, sent }) => {
    const draftId = await makeDraft();
    const result = await call("send_draft", { draftId });
    assert.ok(!result.isError, text(result));
    assert.equal(asked.length, 1);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, ["real@example.com"]);
  });
});

test("send_draft: an update that changes nothing does not stop a send", async () => {
  await withServer(async ({ call, text, makeDraft, hooks, sent }) => {
    const draftId = await makeDraft();
    hooks.onAsk = async () => { await call("update_draft", { draftId, subject: "Stored subject" }); };
    const result = await call("send_draft", { draftId });
    assert.ok(!result.isError, text(result));
    assert.equal(sent.length, 1);
  });
});

test("a model-supplied digest field is ignored, whatever it is called and whatever it holds", async () => {
  const names = ["approvedDigest", "approvedDraftDigest", "draftDigest", "digest", "_approved", "__approvedDraftDigest", "approved", "approvedBinding"];
  // "forged" is nonsense; "future" is the digest of the draft as it will be after the swap, which is what a model that
  // wanted to get past the check would supply (it knows what it is about to change).
  for (const kind of ["forged", "future"]) {
    await withServer(async ({ call, text, makeDraft, hooks, sent, bundle }) => {
      const draftId = await makeDraft();
      const future = draftApprovalDigest({ ...(await bundle.draftStore.getDraft(draftId)), to: ["evil@example.com"] });
      const value = kind === "forged" ? "forged" : future;
      hooks.onAsk = async () => { await call("update_draft", { draftId, to: ["evil@example.com"] }); };
      const result = await call("send_draft", { draftId, ...Object.fromEntries(names.map((name) => [name, value])), approved: { kind: "draft", digest: value } });
      assert.equal(result.isError, true, kind);
      assert.match(text(result), CHANGED, kind);
      assert.deepEqual(sent, [], kind);
    });
  }
});

test("a forged field does not break an ordinary approved send", async () => {
  await withServer(async ({ call, text, makeDraft, sent }) => {
    const draftId = await makeDraft();
    const result = await call("send_draft", { draftId, approvedDigest: "forged", approved: true });
    assert.ok(!result.isError, text(result));
    assert.equal(sent.length, 1);
  });
});

test("schedule_draft: a swap between the question and the answer => refused, nothing queued", async () => {
  await withServer(async ({ call, text, makeDraft, hooks, bundle }) => {
    const draftId = await makeDraft();
    hooks.onAsk = async () => { await call("update_draft", { draftId, bcc: ["hidden@example.com"] }); };
    const sendAt = new Date(Date.now() + 3_600_000).toISOString();
    const result = await call("schedule_draft", { draftId, sendAt });
    assert.equal(result.isError, true);
    assert.match(text(result), CHANGED);
    assert.deepEqual(await bundle.deliveryQueueService.list(), []);
  });
  await withServer(async ({ call, text, makeDraft, bundle }) => {
    const draftId = await makeDraft();
    const result = await call("schedule_draft", { draftId, sendAt: new Date(Date.now() + 3_600_000).toISOString() });
    assert.ok(!result.isError, text(result));
    assert.equal((await bundle.deliveryQueueService.list()).length, 1);
  });
});

test("delete_draft: a swap between the question and the answer => refused, the draft stays", async () => {
  await withServer(async ({ call, text, makeDraft, hooks }) => {
    const draftId = await makeDraft();
    hooks.onAsk = async () => { await call("update_draft", { draftId, subject: "Something else" }); };
    const result = await call("delete_draft", { draftId });
    assert.equal(result.isError, true);
    assert.match(text(result), CHANGED);
    assert.ok(!(await call("get_draft", { draftId })).isError, "still there");
  });
  await withServer(async ({ call, text, makeDraft }) => {
    const draftId = await makeDraft();
    assert.ok(!(await call("delete_draft", { draftId })).isError);
    assert.equal((await call("get_draft", { draftId })).isError, true);
  });
});

test("approve_plan: a plan whose items changed after the question is refused, nothing is applied", async () => {
  await withServer(async ({ call, text, hooks, archived, dir }) => {
    const made = await call("plan_inbox", { scan: false, items: [{ emailId: "INBOX::1", action: "archive" }] });
    assert.ok(!made.isError, text(made));
    const planId = JSON.parse(text(made)).planId;
    assert.ok(planId, text(made));
    const storePath = join(dir, "triage-plans.json");
    hooks.onAsk = async () => {
      // Another process (or a later call) rewrites the stored plan after the person was shown it.
      const state = JSON.parse(await readFile(storePath, "utf8"));
      state.plans.find((plan) => plan.id === planId).items[0].emailId = "INBOX::2";
      await writeFile(storePath, JSON.stringify(state));
    };
    const result = await call("approve_plan", { planId });
    assert.equal(result.isError, true);
    assert.match(text(result), /changed after you were asked/);
    assert.deepEqual(archived, []);
  });
  await withServer(async ({ call, text, archived }) => {
    const made = await call("plan_inbox", { scan: false, items: [{ emailId: "INBOX::1", action: "archive" }] });
    const planId = JSON.parse(text(made)).planId;
    const result = await call("approve_plan", { planId });
    assert.ok(!result.isError, text(result));
    assert.deepEqual(archived, ["INBOX::1"], text(result));
  });
});
