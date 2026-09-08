import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DraftStoreService } from "../dist/services/draft-store-service.js";
import { DeliveryQueueService } from "../dist/services/delivery-queue-service.js";

function createConfig(dataDir) {
  return {
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "secret" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "secret" },
    dataDir,
    debug: false,
    cacheEnabled: true,
    analyticsEnabled: true,
    autoSync: false,
    syncInterval: 5,
    runtime: {
      readOnly: false,
      allowSend: true,
      allowRemoteDraftSync: true,
      allowedActions: [],
      startupSync: false,
      autoSyncFolder: "INBOX",
      autoSyncFull: false,
      autoSyncLimitPerFolder: 25,
      idleWatchEnabled: false,
      idleMaxSeconds: 30,
      confirmDestructive: false,
      allowEmptyFolder: false,
      restrictOutboundToSelf: false,
      allowFileDownloadDir: undefined,
      maxInlineBytes: 40960,
      opDelayMs: 0,
    },
  };
}

async function withTempDir(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-draft-send-guard-test-"));
  try {
    await fn(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

function slowSmtp(delayMs, behavior = "succeed") {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async sendEmail(payload) {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (behavior === "fail") {
        throw new Error("SMTP send failed");
      }
      return { messageId: `<sent-${calls}@example.com>`, accepted: payload.to, rejected: [] };
    },
  };
}

// Mirrors index.ts's `case "send_draft"` handler after the P1 fix: claim the
// draft atomically (draft -> sending) BEFORE calling SMTP, revert on failure,
// markSent on success.
async function sendDraft(draftStore, smtp, draftId) {
  const draft = await draftStore.getDraft(draftId);
  if (draft.status === "sent") {
    throw new Error(`Draft ${draft.id} was already sent`);
  }
  await draftStore.claimForSending(draft.id);
  let result;
  try {
    result = await smtp.sendEmail({ to: draft.to, subject: draft.subject, body: draft.body });
  } catch (error) {
    await draftStore.revertSending(draft.id);
    throw error;
  }
  return draftStore.markSent(draft.id, {
    messageId: result.messageId,
    accepted: result.accepted,
    rejected: result.rejected,
    response: "OK",
  });
}

test("send_draft: two concurrent sends of the same draft only reach SMTP once", async () => {
  await withTempDir(async (dataDir) => {
    const config = createConfig(dataDir);
    const draftStore = new DraftStoreService(config);
    const smtp = slowSmtp(50);

    const draft = await draftStore.createDraft({ to: ["someone@example.com"], subject: "Hi", body: "body" });

    const [resultA, resultB] = await Promise.allSettled([
      sendDraft(draftStore, smtp, draft.id),
      sendDraft(draftStore, smtp, draft.id),
    ]);

    const fulfilled = [resultA, resultB].filter((r) => r.status === "fulfilled");
    const rejected = [resultA, resultB].filter((r) => r.status === "rejected");

    assert.equal(smtp.calls, 1, "SMTP must be called exactly once");
    assert.equal(fulfilled.length, 1, "exactly one call must succeed");
    assert.equal(rejected.length, 1, "exactly one call must be rejected, not silently ignored or queued");
    assert.match(rejected[0].reason.message, /not sendable|already sent/i);

    const finalDraft = await draftStore.getDraft(draft.id);
    assert.equal(finalDraft.status, "sent");
  });
});

test("send_draft: a failed SMTP send reverts the draft back to draft (retryable), not stuck in sending", async () => {
  await withTempDir(async (dataDir) => {
    const config = createConfig(dataDir);
    const draftStore = new DraftStoreService(config);
    const smtp = slowSmtp(5, "fail");

    const draft = await draftStore.createDraft({ to: ["someone@example.com"], subject: "Hi", body: "body" });

    await assert.rejects(() => sendDraft(draftStore, smtp, draft.id), /SMTP send failed/);

    const afterFailure = await draftStore.getDraft(draft.id);
    assert.equal(afterFailure.status, "draft", "must be reverted to draft, not left stuck in sending");
  });
});

test("scheduled send that fires marks the source draft sent, and a later manual send_draft on it then throws", async () => {
  await withTempDir(async (dataDir) => {
    const config = createConfig(dataDir);
    const draftStore = new DraftStoreService(config);
    const smtp = slowSmtp(5);
    const queue = new DeliveryQueueService(config, smtp);
    queue.setDraftStore(draftStore);

    const draft = await draftStore.createDraft({ to: ["someone@example.com"], subject: "Hi", body: "body" });

    // schedule_draft: enqueue a scheduled_send tied to this draft, due in the past
    // so checkDue() fires it immediately.
    await queue.enqueue(
      { to: draft.to, subject: draft.subject, body: draft.body },
      new Date(Date.now() - 1000).toISOString(),
      "scheduled_send",
      draft.id,
    );

    const outcome = await queue.checkDue();
    assert.equal(outcome.sent, 1);
    assert.equal(smtp.calls, 1);

    const firedDraft = await draftStore.getDraft(draft.id);
    assert.equal(firedDraft.status, "sent", "the source draft must be marked sent once the scheduled send fires");

    await assert.rejects(() => sendDraft(draftStore, smtp, draft.id), /already sent/i);
    assert.equal(smtp.calls, 1, "the manual send_draft attempt must not reach SMTP a second time");
  });
});
