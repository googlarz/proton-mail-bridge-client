import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../dist/index.js";
import { ensureOutboundRecipientsAllowed } from "../dist/utils/runtime-policy.js";

// Found live (read-only audit): send_email/reply_to_email/reply_all_email/forward_email/
// send_draft/schedule_draft each hand-rolled their own inline RESTRICT_OUTBOUND_TO_SELF
// check (`r.toLowerCase() !== selfAddr`) instead of calling the shared
// ensureOutboundRecipientsAllowed helper that unsubscribe_sender/send_test_email/the
// delivery queue's fire-time recheck already used. The inline checks didn't normalize
// Proton's "+tag" plus-addressing, so a self-send to "owner+tag@example.com" was
// wrongly rejected by these 6 paths even though the shared helper (via isSelfAddress)
// correctly allows it. These tests prove the regression is fixed by driving each
// handler end-to-end with restrictOutboundToSelf:true and a "+tag" self-address.

// (a) The shared helper's own behavior is untouched by this change.
test("ensureOutboundRecipientsAllowed still allows a +tag self-send and blocks a real external one", () => {
  const runtime = { restrictOutboundToSelf: true };
  assert.doesNotThrow(() =>
    ensureOutboundRecipientsAllowed(runtime, "owner@example.com", ["owner+tag@example.com"]),
  );
  assert.throws(
    () => ensureOutboundRecipientsAllowed(runtime, "owner@example.com", ["stranger@example.com"]),
    /RESTRICT_OUTBOUND_TO_SELF is enabled\. Cannot send to: stranger@example\.com/,
  );
});

const detail = {
  id: "INBOX::1", folder: "INBOX", uid: 1, subject: "Hello",
  from: [{ name: "Ann", address: "owner+tag@example.com" }],
  to: [{ name: "", address: "owner@example.com" }], cc: [], bcc: [], replyTo: [],
  date: "2026-09-19T10:00:00.000Z", messageId: "<orig@example.com>", references: [],
  body: "original text", text: "original text", attachments: [], isRead: true, isStarred: false, flags: [], labels: [],
};

async function withServer(fn) {
  const dir = await mkdtemp(join(tmpdir(), "outbound-consolidation-"));
  const account = {
    address: "owner@example.com", slug: "owner-example-com", dataDir: dir,
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "x" },
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "x" },
  };
  const config = {
    smtp: account.smtp, imap: account.imap, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true,
    autoSync: false, syncInterval: 5,
    runtime: {
      readOnly: false, allowSend: true, allowRemoteDraftSync: false, allowedActions: [], startupSync: false,
      autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30,
      confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: true, allowFileDownloadDir: undefined,
      maxInlineBytes: 40960, opDelayMs: 0, sendDelaySeconds: 0,
    },
    accounts: [account],
  };
  const { server, imapService, smtpService, draftStore } = createServer(config, { startBackgroundSync: false });
  imapService.getEmailById = async () => ({ ...detail });
  const sent = [];
  smtpService.sendEmail = async (payload) => { sent.push(payload); return { messageId: "<sent@example.com>", accepted: payload.to, rejected: [] }; };
  const client = new Client({ name: "test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    return { result, data: JSON.parse(result.content[0].text) };
  };
  try {
    await fn({ call, sent, draftStore });
  } finally {
    await client.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// (b) end-to-end: each handler now correctly ALLOWS a self-send to a "+tag" alias
// when restrictOutboundToSelf is on. Before the fix, all six threw
// "RESTRICT_OUTBOUND_TO_SELF is enabled" for this exact case.

test("send_email allows sending to owner+tag@example.com when RESTRICT_OUTBOUND_TO_SELF is on", async () => {
  await withServer(async ({ call }) => {
    const { data } = await call("send_email", {
      to: "owner+tag@example.com", subject: "hi", body: "hi", dryRun: true,
    });
    assert.equal(data.dryRun, true);
  });
});

test("reply_to_email allows replying to owner+tag@example.com when RESTRICT_OUTBOUND_TO_SELF is on", async () => {
  await withServer(async ({ call }) => {
    const { data } = await call("reply_to_email", { emailId: detail.id, body: "thanks", dryRun: true });
    assert.deepEqual(data.wouldSendTo.to, ["owner+tag@example.com"]);
  });
});

test("reply_all_email allows replying to owner+tag@example.com when RESTRICT_OUTBOUND_TO_SELF is on", async () => {
  await withServer(async ({ call }) => {
    const { data } = await call("reply_all_email", { emailId: detail.id, body: "thanks", dryRun: true });
    assert.deepEqual(data.wouldSendTo.to, ["owner+tag@example.com"]);
  });
});

test("forward_email allows forwarding to owner+tag@example.com when RESTRICT_OUTBOUND_TO_SELF is on", async () => {
  await withServer(async ({ call }) => {
    const { data } = await call("forward_email", { emailId: detail.id, to: "owner+tag@example.com", dryRun: true });
    assert.deepEqual(data.wouldSendTo.to, ["owner+tag@example.com"]);
  });
});

test("send_draft allows sending a draft addressed to owner+tag@example.com when RESTRICT_OUTBOUND_TO_SELF is on", async () => {
  await withServer(async ({ call, draftStore }) => {
    const draft = await draftStore.createDraft({
      mode: "compose", to: ["owner+tag@example.com"], cc: [], bcc: [], subject: "hi", body: "hi", isHtml: false,
    });
    const { data } = await call("send_draft", { draftId: draft.id, dryRun: true });
    assert.equal(data.dryRun, true);
    assert.deepEqual(data.wouldSendTo.to, ["owner+tag@example.com"]);
  });
});

test("schedule_draft allows scheduling a draft addressed to owner+tag@example.com when RESTRICT_OUTBOUND_TO_SELF is on", async () => {
  await withServer(async ({ call, draftStore }) => {
    const draft = await draftStore.createDraft({
      mode: "compose", to: ["owner+tag@example.com"], cc: [], bcc: [], subject: "hi", body: "hi", isHtml: false,
    });
    const sendAt = new Date(Date.now() + 60_000).toISOString();
    const { data } = await call("schedule_draft", { draftId: draft.id, sendAt });
    assert.equal(data.queued, true, JSON.stringify(data));
  });
});
