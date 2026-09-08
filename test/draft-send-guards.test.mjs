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

// SMTP mock whose sendEmail() call blocks on a controllable barrier — lets a
// test hold a send "in flight" for as long as it wants, so a concurrent
// caller can be attempted while it's still pending.
function barrierSmtp() {
  let calls = 0;
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  return {
    get calls() {
      return calls;
    },
    release,
    async sendEmail(payload) {
      calls += 1;
      await barrier;
      return { messageId: `<sent-${calls}@example.com>`, accepted: payload.to, rejected: [] };
    },
  };
}

// Mirrors index.ts's `case "send_draft"` handler after the P1 audit-coupling
// fix: SMTP is called directly (not through withAudit), and the success-path
// audit write is attempted separately, AFTER SMTP has already succeeded — a
// failure there is swallowed (logged) rather than reverting the draft.
async function sendDraftWithAudit(draftStore, auditService, smtp, draftId) {
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
  try {
    await auditService.record({
      timestamp: new Date().toISOString(),
      tool: "send_draft",
      status: "success",
      durationMs: 0,
      input: {},
      result,
    });
  } catch {
    // Audit-write failure after a successful send must not revert the draft
    // or be reported as a send failure — see the fix comment in index.ts.
  }
  return draftStore.markSent(draft.id, {
    messageId: result.messageId,
    accepted: result.accepted,
    rejected: result.rejected,
    response: "OK",
  });
}

test("Finding 1: a scheduled send holding SMTP mid-flight blocks a concurrent manual send_draft, not the other way round", async () => {
  await withTempDir(async (dataDir) => {
    const config = createConfig(dataDir);
    const draftStore = new DraftStoreService(config);
    const scheduledSmtp = barrierSmtp();
    const manualSmtp = barrierSmtp();
    manualSmtp.release(); // manual path's own SMTP is never expected to be reached

    const queue = new DeliveryQueueService(config, scheduledSmtp);
    queue.setDraftStore(draftStore);

    const draft = await draftStore.createDraft({ to: ["someone@example.com"], subject: "Hi", body: "body" });
    await queue.enqueue(
      { to: draft.to, subject: draft.subject, body: draft.body },
      new Date(Date.now() - 1000).toISOString(),
      "scheduled_send",
      draft.id,
    );

    // Start the scheduled send; it claims the queue item AND (post-fix) the
    // draft itself before ever reaching the barriered SMTP call below.
    const checkDuePromise = queue.checkDue();

    // Give checkDue's claim step a moment to run before the manual attempt,
    // without depending on exact timing beyond "the claim happens first".
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Concurrent manual send_draft while the scheduled send's SMTP call is
    // still held on the barrier — this is the exact race from the report.
    const manualAttempt = sendDraftWithAudit(draftStore, { record: async () => {} }, manualSmtp, draft.id).catch(
      (error) => ({ rejected: true, error }),
    );

    const manualResult = await manualAttempt;
    assert.ok(manualResult && manualResult.rejected, "the manual send_draft must be rejected, not silently queued or duplicated");
    assert.match(manualResult.error.message, /not sendable|already sent/i);

    scheduledSmtp.release();
    const outcome = await checkDuePromise;

    assert.equal(outcome.sent, 1);
    assert.equal(scheduledSmtp.calls, 1, "the scheduled send's SMTP must be called exactly once");
    assert.equal(manualSmtp.calls, 0, "the losing manual attempt must never reach SMTP");

    const finalDraft = await draftStore.getDraft(draft.id);
    assert.equal(finalDraft.status, "sent", "the draft must end up sent exactly once, via the winning path");
  });
});

test("Finding 2: an audit-log write failure after a successful send does not revert the draft or enable a duplicate resend", async () => {
  await withTempDir(async (dataDir) => {
    const config = createConfig(dataDir);
    const draftStore = new DraftStoreService(config);
    const smtp = slowSmtp(5);

    let recordCalls = 0;
    const flakyAuditService = {
      async record() {
        recordCalls += 1;
        if (recordCalls === 1) {
          throw new Error("ENOSPC: no space left on device");
        }
      },
    };

    const draft = await draftStore.createDraft({ to: ["someone@example.com"], subject: "Hi", body: "body" });

    // First call: SMTP succeeds, but the success-path audit write throws.
    const sent = await sendDraftWithAudit(draftStore, flakyAuditService, smtp, draft.id);
    assert.equal(sent.status, "sent", "the draft must be marked sent — the email was actually delivered");

    const afterFirstCall = await draftStore.getDraft(draft.id);
    assert.equal(afterFirstCall.status, "sent", "the draft must not be reverted to draft by the audit-write failure");

    // Second call on the same draft must be rejected as already sent, not
    // silently deliver a duplicate.
    await assert.rejects(
      () => sendDraftWithAudit(draftStore, flakyAuditService, smtp, draft.id),
      /already sent/i,
    );

    assert.equal(smtp.calls, 1, "SMTP must have been called exactly once across both attempts");
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

// P1 (4th review): a draft-store markSent() failure AFTER SMTP and the queue
// record already succeeded used to fall into checkDue()'s SMTP-failure catch
// block, which unconditionally reverted the draft claim and double-counted
// the item as both sent and failed — re-enabling a genuine duplicate
// delivery via a later send_draft. These tests exercise the fixed
// checkDue() directly (not the sendDraft()/sendDraftWithAudit() test
// helpers above, which model index.ts's separate send_draft handler).

test("checkDue: a markSent() failure that recovers on retry still counts as sent, does not revert the draft, and does not enable a duplicate send", async () => {
  await withTempDir(async (dataDir) => {
    const config = createConfig(dataDir);
    const draftStore = new DraftStoreService(config);
    const smtp = slowSmtp(5);
    const queue = new DeliveryQueueService(config, smtp);
    queue.setDraftStore(draftStore);

    const draft = await draftStore.createDraft({ to: ["someone@example.com"], subject: "Hi", body: "body" });
    await queue.enqueue(
      { to: draft.to, subject: draft.subject, body: draft.body },
      new Date(Date.now() - 1000).toISOString(),
      "scheduled_send",
      draft.id,
    );

    const originalMarkSent = draftStore.markSent.bind(draftStore);
    let markSentCalls = 0;
    let revertCalls = 0;
    const originalRevertSending = draftStore.revertSending.bind(draftStore);
    draftStore.revertSending = async (...args) => {
      revertCalls += 1;
      return originalRevertSending(...args);
    };
    draftStore.markSent = async (...args) => {
      markSentCalls += 1;
      if (markSentCalls === 1) {
        throw new Error("ENOSPC: no space left on device");
      }
      return originalMarkSent(...args);
    };

    const outcome = await queue.checkDue();

    assert.equal(outcome.sent, 1, "the queue item's own send succeeded and must be counted as sent");
    assert.equal(outcome.failed, 0, "a draft-finalization failure is not a delivery failure and must not be counted as failed");
    assert.equal(revertCalls, 0, "revertSending must never be called once SMTP and the queue write already succeeded");
    assert.ok(markSentCalls > 1, "markSent must have been retried");

    const finalDraft = await draftStore.getDraft(draft.id);
    assert.notEqual(finalDraft.status, "draft", "the draft must never end up back in resendable draft status");

    await assert.rejects(
      () => sendDraft(draftStore, smtp, draft.id),
      /not sendable|already sent/i,
      "a subsequent send_draft on the same draft must be rejected, not allowed to send again",
    );
    assert.equal(smtp.calls, 1, "SMTP must have been called exactly once total — no duplicate delivery");
  });
});

test("checkDue: markSent() failing on every retry leaves the draft stuck in sending (not reverted to draft), still counted as sent", async () => {
  await withTempDir(async (dataDir) => {
    const config = createConfig(dataDir);
    const draftStore = new DraftStoreService(config);
    const smtp = slowSmtp(5);
    const queue = new DeliveryQueueService(config, smtp);
    queue.setDraftStore(draftStore);

    const draft = await draftStore.createDraft({ to: ["someone@example.com"], subject: "Hi", body: "body" });
    await queue.enqueue(
      { to: draft.to, subject: draft.subject, body: draft.body },
      new Date(Date.now() - 1000).toISOString(),
      "scheduled_send",
      draft.id,
    );

    let revertCalls = 0;
    const originalRevertSending = draftStore.revertSending.bind(draftStore);
    draftStore.revertSending = async (...args) => {
      revertCalls += 1;
      return originalRevertSending(...args);
    };
    draftStore.markSent = async () => {
      throw new Error("ENOSPC: no space left on device");
    };

    const outcome = await queue.checkDue();

    assert.equal(outcome.sent, 1, "SMTP and the queue write both succeeded, so this still counts as sent");
    assert.equal(outcome.failed, 0, "a draft-finalization failure is not a delivery failure and must not be counted as failed");
    assert.equal(revertCalls, 0, "revertSending must never be called once SMTP and the queue write already succeeded");

    const finalDraft = await draftStore.getDraft(draft.id);
    assert.equal(finalDraft.status, "sending", "the draft is left stuck in sending rather than reverted to a resendable state");

    await assert.rejects(
      () => sendDraft(draftStore, smtp, draft.id),
      /not sendable/i,
      "a subsequent send_draft on the same draft must be rejected, not allowed to send again",
    );
    assert.equal(smtp.calls, 1, "SMTP must have been called exactly once total — no duplicate delivery");
  });
});

test("checkDue: SMTP failure still reverts the draft and is counted as failed (no regression)", async () => {
  await withTempDir(async (dataDir) => {
    const config = createConfig(dataDir);
    const draftStore = new DraftStoreService(config);
    const smtp = slowSmtp(5, "fail");
    const queue = new DeliveryQueueService(config, smtp);
    queue.setDraftStore(draftStore);

    const draft = await draftStore.createDraft({ to: ["someone@example.com"], subject: "Hi", body: "body" });
    await queue.enqueue(
      { to: draft.to, subject: draft.subject, body: draft.body },
      new Date(Date.now() - 1000).toISOString(),
      "scheduled_send",
      draft.id,
    );

    const outcome = await queue.checkDue();

    assert.equal(outcome.sent, 0);
    assert.equal(outcome.failed, 1);

    const finalDraft = await draftStore.getDraft(draft.id);
    assert.equal(finalDraft.status, "draft", "an actual SMTP failure must still revert the draft to a resendable state");
  });
});

test("checkDue: SMTP and markSent both succeeding produces sent:1, failed:0 and a fully finalized draft (no regression)", async () => {
  await withTempDir(async (dataDir) => {
    const config = createConfig(dataDir);
    const draftStore = new DraftStoreService(config);
    const smtp = slowSmtp(5);
    const queue = new DeliveryQueueService(config, smtp);
    queue.setDraftStore(draftStore);

    const draft = await draftStore.createDraft({ to: ["someone@example.com"], subject: "Hi", body: "body" });
    await queue.enqueue(
      { to: draft.to, subject: draft.subject, body: draft.body },
      new Date(Date.now() - 1000).toISOString(),
      "scheduled_send",
      draft.id,
    );

    const outcome = await queue.checkDue();

    assert.equal(outcome.sent, 1);
    assert.equal(outcome.failed, 0);

    const finalDraft = await draftStore.getDraft(draft.id);
    assert.equal(finalDraft.status, "sent");
    assert.equal(smtp.calls, 1);
  });
});
