import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

function fakeSmtp(behavior = "succeed") {
  return {
    sent: [],
    async sendEmail(payload) {
      this.sent.push(payload);
      if (behavior === "fail") {
        throw new Error("SMTP send failed");
      }
      return { messageId: `<sent-${this.sent.length}@example.com>`, accepted: payload.to, rejected: [] };
    },
  };
}

async function withTempDir(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-delivery-queue-test-"));
  try {
    await fn(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

const payload = { to: ["victim@example.com"], subject: "Hello", body: "test body" };

test("enqueue persists a pending item and list() returns it", async () => {
  await withTempDir(async (dataDir) => {
    const smtp = fakeSmtp();
    const queue = new DeliveryQueueService(createConfig(dataDir), smtp);
    const record = await queue.enqueue(payload, new Date(Date.now() + 60_000).toISOString(), "scheduled_send");

    assert.equal(record.status, "pending");
    const items = await queue.list();
    assert.equal(items.length, 1);
    assert.equal(items[0].id, record.id);
    assert.equal(smtp.sent.length, 0, "not due yet, must not have sent");
  });
});

test("checkDue sends items whose sendAt has already passed, and only once", async () => {
  await withTempDir(async (dataDir) => {
    const smtp = fakeSmtp();
    const queue = new DeliveryQueueService(createConfig(dataDir), smtp);
    const record = await queue.enqueue(payload, new Date(Date.now() - 1_000).toISOString(), "undo_send");

    const result = await queue.checkDue();
    assert.equal(result.sent, 1);
    assert.equal(smtp.sent.length, 1);

    const after = await queue.get(record.id);
    assert.equal(after.status, "sent");
    assert.ok(after.sentAt);
    assert.ok(after.sentMessageId);

    // Second call must not re-send an already-sent item.
    await queue.checkDue();
    assert.equal(smtp.sent.length, 1);
  });
});

test("checkDue leaves future items alone", async () => {
  await withTempDir(async (dataDir) => {
    const smtp = fakeSmtp();
    const queue = new DeliveryQueueService(createConfig(dataDir), smtp);
    await queue.enqueue(payload, new Date(Date.now() + 3_600_000).toISOString(), "scheduled_send");

    const result = await queue.checkDue();
    assert.equal(result.sent, 0);
    assert.equal(smtp.sent.length, 0);
  });
});

test("cancel marks a pending item canceled and checkDue skips it", async () => {
  await withTempDir(async (dataDir) => {
    const smtp = fakeSmtp();
    const queue = new DeliveryQueueService(createConfig(dataDir), smtp);
    const record = await queue.enqueue(payload, new Date(Date.now() - 1_000).toISOString(), "undo_send");

    const cancelResult = await queue.cancel(record.id);
    assert.equal(cancelResult.canceled, true);

    await queue.checkDue();
    assert.equal(smtp.sent.length, 0, "canceled item must never be sent");

    const after = await queue.get(record.id);
    assert.equal(after.status, "canceled");
  });
});

test("cancel on an already-sent item reports canceled: false without changing status", async () => {
  await withTempDir(async (dataDir) => {
    const smtp = fakeSmtp();
    const queue = new DeliveryQueueService(createConfig(dataDir), smtp);
    const record = await queue.enqueue(payload, new Date(Date.now() - 1_000).toISOString(), "undo_send");
    await queue.checkDue();

    const cancelResult = await queue.cancel(record.id);
    assert.equal(cancelResult.canceled, false);
    assert.equal(cancelResult.status, "sent");
  });
});

test("checkDue marks an item failed (not stuck pending) when the send throws", async () => {
  await withTempDir(async (dataDir) => {
    const smtp = fakeSmtp("fail");
    const queue = new DeliveryQueueService(createConfig(dataDir), smtp);
    const record = await queue.enqueue(payload, new Date(Date.now() - 1_000).toISOString(), "undo_send");

    const result = await queue.checkDue();
    assert.equal(result.failed, 1);

    const after = await queue.get(record.id);
    assert.equal(after.status, "failed");
    assert.ok(after.failureReason);
  });
});

test("a queue reopened against the same dataDir sees items persisted by a prior instance", async () => {
  await withTempDir(async (dataDir) => {
    const config = createConfig(dataDir);
    const smtp1 = fakeSmtp();
    const queue1 = new DeliveryQueueService(config, smtp1);
    const record = await queue1.enqueue(payload, new Date(Date.now() - 1_000).toISOString(), "scheduled_send");

    // New instance, same dataDir — simulates catch-up on server restart.
    const smtp2 = fakeSmtp();
    const queue2 = new DeliveryQueueService(config, smtp2);
    const result = await queue2.checkDue();

    assert.equal(result.sent, 1);
    assert.equal(smtp2.sent.length, 1);
    const after = await queue2.get(record.id);
    assert.equal(after.status, "sent");
  });
});

// Regression: cancel() racing an in-flight send must never report
// canceled:true for an email that actually goes out, and the item must never
// be sent twice by an overlapping checkDue() pass.
test("cancel() called while checkDue() is mid-send does not report canceled:true and does not stop the send", async () => {
  await withTempDir(async (dataDir) => {
    const config = createConfig(dataDir);
    let releaseSend;
    const smtp = {
      sent: [],
      async sendEmail(p) {
        // Block until the test explicitly lets the send proceed, giving
        // cancel() a real window to race against the in-flight send.
        await new Promise((resolve) => { releaseSend = resolve; });
        this.sent.push(p);
        return { messageId: "<race@example.com>", accepted: p.to, rejected: [] };
      },
    };
    const queue = new DeliveryQueueService(config, smtp);
    const record = await queue.enqueue(payload, new Date(Date.now() - 1_000).toISOString(), "undo_send");

    const checkDuePromise = queue.checkDue();
    // Wait for checkDue to reach the blocking sendEmail call (item is
    // claimed as "sending" by then).
    while (!releaseSend) await new Promise((r) => setTimeout(r, 5));

    const cancelResult = await queue.cancel(record.id);
    assert.equal(cancelResult.canceled, false, "must not claim to cancel a send already in flight");
    assert.equal(cancelResult.status, "sending");

    releaseSend();
    await checkDuePromise;

    assert.equal(smtp.sent.length, 1, "the email must actually have been sent");
    const after = await queue.get(record.id);
    assert.equal(after.status, "sent", "final status must reflect reality, not a stale cancel");
  });
});

test("checkDue marks an item failed instead of sending when runtime policy forbids sending", async () => {
  await withTempDir(async (dataDir) => {
    const config = createConfig(dataDir);
    config.runtime.allowSend = false;
    const smtp = fakeSmtp();
    const queue = new DeliveryQueueService(config, smtp);
    const record = await queue.enqueue(payload, new Date(Date.now() - 1_000).toISOString(), "scheduled_send");

    const result = await queue.checkDue();
    assert.equal(result.failed, 1);
    assert.equal(smtp.sent.length, 0, "must not send when allowSend is false, even though it was true at enqueue time");

    const after = await queue.get(record.id);
    assert.equal(after.status, "failed");
    assert.match(after.failureReason, /policy/i);
  });
});

test("checkDue marks an item failed instead of sending when restrictOutboundToSelf blocks the recipient", async () => {
  await withTempDir(async (dataDir) => {
    const config = createConfig(dataDir);
    config.runtime.restrictOutboundToSelf = true;
    const smtp = fakeSmtp();
    const queue = new DeliveryQueueService(config, smtp);
    const record = await queue.enqueue(payload, new Date(Date.now() - 1_000).toISOString(), "scheduled_send");

    const result = await queue.checkDue();
    assert.equal(result.failed, 1);
    assert.equal(smtp.sent.length, 0);

    const after = await queue.get(record.id);
    assert.equal(after.status, "failed");
    assert.match(after.failureReason, /RESTRICT_OUTBOUND_TO_SELF/);
  });
});

test("a 'sending' record left over from a crashed process is never auto-resent on the next start", async () => {
  await withTempDir(async (dataDir) => {
    const config = createConfig(dataDir);
    await mkdir(dataDir, { recursive: true });
    const stuckId = "stuck-item-1";
    await writeFile(
      join(dataDir, "delivery-queue.json"),
      JSON.stringify({
        version: 1,
        items: {
          [stuckId]: {
            id: stuckId,
            kind: "undo_send",
            createdAt: new Date(Date.now() - 60_000).toISOString(),
            sendAt: new Date(Date.now() - 1_000).toISOString(),
            status: "sending",
            payload,
          },
        },
      }, null, 2),
      "utf8",
    );

    const smtp = fakeSmtp();
    const queue = new DeliveryQueueService(config, smtp);
    await queue.start();
    queue.stop();
    // start() awaits recoverInterruptedSends before its catch-up checkDue,
    // but checkDue itself is fired-and-forgotten (`void`) — give it a tick.
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(smtp.sent.length, 0, "must never resend an item whose outcome is unknown");
    const after = await queue.get(stuckId);
    assert.equal(after.status, "failed");
    assert.match(after.failureReason, /restart|interrupted/i);
  });
});

test("enqueue stores an optional sourceDraftId, used by send_draft to detect a still-pending scheduled send", async () => {
  // schedule_draft passes the draft's id here so send_draft can refuse to
  // fire a second, independent send for the same draft — found live: a
  // draft scheduled then immediately sent produced two separate successful
  // SMTP transactions.
  await withTempDir(async (dataDir) => {
    const queue = new DeliveryQueueService(createConfig(dataDir), fakeSmtp());
    const record = await queue.enqueue(
      payload,
      new Date(Date.now() + 60_000).toISOString(),
      "scheduled_send",
      "draft-abc-123",
    );

    assert.equal(record.sourceDraftId, "draft-abc-123");
    const items = await queue.list();
    assert.equal(items[0].sourceDraftId, "draft-abc-123");
  });
});

test("enqueue omits sourceDraftId when not given (undo_send has no source draft)", async () => {
  await withTempDir(async (dataDir) => {
    const queue = new DeliveryQueueService(createConfig(dataDir), fakeSmtp());
    const record = await queue.enqueue(payload, new Date(Date.now() + 60_000).toISOString(), "undo_send");
    assert.equal(record.sourceDraftId, undefined);
  });
});

test("a second process writing the same dataDir is visible without restarting this instance (no forever-cache)", async () => {
  await withTempDir(async (dataDir) => {
    const config = createConfig(dataDir);
    const queueA = new DeliveryQueueService(config, fakeSmtp());
    const record = await queueA.enqueue(payload, new Date(Date.now() + 60_000).toISOString(), "scheduled_send");

    // Simulate a second process (e.g. the CLI) cancelling it directly on disk.
    const queueB = new DeliveryQueueService(config, fakeSmtp());
    await queueB.cancel(record.id);

    // queueA must see the cancellation on its next read, not a stale cache.
    const seenByA = await queueA.get(record.id);
    assert.equal(seenByA.status, "canceled");
  });
});
