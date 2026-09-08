import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SnoozeService } from "../dist/services/snooze-service.js";

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
      sendDelaySeconds: 0,
    },
  };
}

// Simulates IMAP UID reassignment on every move, matching real moveEmail
// behavior — the composite id changes each time a message moves folders.
function fakeImap() {
  let nextUid = 100;
  return {
    moves: [],
    async createFolder() {
      return { path: "Folders/MCP-Snoozed", created: true };
    },
    // Real SimpleIMAPService.withTimeout is a public passthrough-with-a-race;
    // this fake only needs the passthrough half since it never actually hangs.
    async withTimeout(promise) {
      return promise;
    },
    async moveEmail(emailId, targetFolder) {
      this.moves.push({ from: emailId, to: targetFolder });
      const targetUid = nextUid++;
      return {
        emailId,
        sourceEmailId: emailId,
        fromFolder: emailId.split("::")[0],
        targetFolder,
        uid: targetUid,
        targetUid,
        targetEmailId: `${targetFolder}::${targetUid}`,
      };
    },
  };
}

async function withTempDir(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-snooze-test-"));
  try {
    await fn(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("snooze moves the email into Folders/MCP-Snoozed and persists a pending record", async () => {
  await withTempDir(async (dataDir) => {
    const imap = fakeImap();
    const service = new SnoozeService(createConfig(dataDir), imap);

    const record = await service.snooze("INBOX::42", new Date(Date.now() + 60_000).toISOString());

    assert.equal(record.status, "pending");
    assert.equal(record.originalFolder, "INBOX");
    assert.ok(record.currentEmailId.startsWith("Folders/MCP-Snoozed::"));
    assert.equal(imap.moves.length, 1);
    assert.equal(imap.moves[0].to, "Folders/MCP-Snoozed");
  });
});

test("checkDue wakes a due snooze by moving it back to the original folder, only once", async () => {
  await withTempDir(async (dataDir) => {
    const imap = fakeImap();
    const service = new SnoozeService(createConfig(dataDir), imap);
    const record = await service.snooze("INBOX::42", new Date(Date.now() - 1_000).toISOString());

    const result = await service.checkDue();
    assert.equal(result.woken, 1);

    const after = await service.get(record.id);
    assert.equal(after.status, "woken");
    assert.ok(after.currentEmailId.startsWith("INBOX::"), "must move back to the original folder");
    assert.equal(imap.moves.length, 2, "one move out, one move back");

    // Second call must not re-wake an already-woken snooze.
    await service.checkDue();
    assert.equal(imap.moves.length, 2);
  });
});

test("checkDue leaves future snoozes alone", async () => {
  await withTempDir(async (dataDir) => {
    const imap = fakeImap();
    const service = new SnoozeService(createConfig(dataDir), imap);
    await service.snooze("INBOX::42", new Date(Date.now() + 3_600_000).toISOString());

    const result = await service.checkDue();
    assert.equal(result.woken, 0);
    assert.equal(imap.moves.length, 1, "only the initial snooze-out move");
  });
});

test("cancel wakes a snooze immediately and checkDue then skips it", async () => {
  await withTempDir(async (dataDir) => {
    const imap = fakeImap();
    const service = new SnoozeService(createConfig(dataDir), imap);
    const record = await service.snooze("INBOX::42", new Date(Date.now() + 3_600_000).toISOString());

    const canceled = await service.cancel(record.id);
    assert.equal(canceled.status, "canceled");
    assert.ok(canceled.currentEmailId.startsWith("INBOX::"));

    await service.checkDue();
    assert.equal(imap.moves.length, 2, "snooze-out + cancel-restore, nothing more");
  });
});

test("a snooze service reopened against the same dataDir sees items persisted by a prior instance", async () => {
  await withTempDir(async (dataDir) => {
    const config = createConfig(dataDir);
    const imap1 = fakeImap();
    const service1 = new SnoozeService(config, imap1);
    const record = await service1.snooze("INBOX::42", new Date(Date.now() - 1_000).toISOString());

    const imap2 = fakeImap();
    const service2 = new SnoozeService(config, imap2);
    const result = await service2.checkDue();

    assert.equal(result.woken, 1);
    const after = await service2.get(record.id);
    assert.equal(after.status, "woken");
  });
});

test("checkDue prunes woken/canceled/failed records past the 30-day retention window, but keeps recent ones", async () => {
  await withTempDir(async (dataDir) => {
    const imap = fakeImap();
    const service = new SnoozeService(createConfig(dataDir), imap);
    const { mkdir, writeFile } = await import("node:fs/promises");
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();

    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, "snoozed.json"),
      JSON.stringify(
        {
          version: 1,
          items: {
            "old-woken-1": {
              id: "old-woken-1",
              createdAt: thirtyOneDaysAgo,
              wakeAt: thirtyOneDaysAgo,
              status: "woken",
              originalFolder: "INBOX",
              currentEmailId: "INBOX::1",
              wokenAt: thirtyOneDaysAgo,
            },
            "old-failed-1": {
              id: "old-failed-1",
              createdAt: thirtyOneDaysAgo,
              wakeAt: thirtyOneDaysAgo,
              status: "failed",
              originalFolder: "INBOX",
              currentEmailId: "Folders/MCP-Snoozed::2",
              failureCount: 5,
            },
            "recent-woken-1": {
              id: "recent-woken-1",
              createdAt: new Date().toISOString(),
              wakeAt: new Date().toISOString(),
              status: "woken",
              originalFolder: "INBOX",
              currentEmailId: "INBOX::3",
              wokenAt: new Date().toISOString(),
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await service.checkDue();

    const items = await service.list();
    const ids = items.map((item) => item.id);
    assert.ok(!ids.includes("old-woken-1"), "old woken record must be pruned");
    assert.ok(!ids.includes("old-failed-1"), "old failed record must be pruned");
    assert.ok(ids.includes("recent-woken-1"), "recent woken record must be kept");
  });
});

// Regression: if a record was already resolved (e.g. by a concurrent
// process's recoverInterruptedWakes() reverting "waking" back to "pending"),
// wake()'s finalize must not blindly overwrite it.
test("wake() finalize skips writing when the record is no longer 'waking' (concurrent resolution)", async () => {
  await withTempDir(async (dataDir) => {
    const imap = fakeImap();
    const service = new SnoozeService(createConfig(dataDir), imap);
    const { mkdir, writeFile, readFile } = await import("node:fs/promises");

    const record = {
      id: "concurrent-1",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      wakeAt: new Date(Date.now() - 1_000).toISOString(),
      status: "pending",
      originalFolder: "INBOX",
      currentEmailId: "Folders/MCP-Snoozed::42",
    };
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, "snoozed.json"),
      JSON.stringify({ version: 1, items: { [record.id]: record } }, null, 2),
      "utf8",
    );

    // Race: call cancel() (which drives wake()) but rewrite the on-disk
    // record back to "pending" behind its back before it finalizes, as if a
    // concurrent process's recoverInterruptedWakes() had reverted it after a
    // crash mid-move. Simulated by monkey-patching moveEmail to mutate the
    // store before returning.
    const originalMoveEmail = imap.moveEmail.bind(imap);
    imap.moveEmail = async (emailId, targetFolder) => {
      const result = await originalMoveEmail(emailId, targetFolder);
      const raw = JSON.parse(await readFile(join(dataDir, "snoozed.json"), "utf8"));
      raw.items[record.id].status = "pending";
      await writeFile(join(dataDir, "snoozed.json"), JSON.stringify(raw, null, 2), "utf8");
      return result;
    };

    await service.cancel(record.id);

    const after = await service.get(record.id);
    assert.equal(after.status, "pending", "finalize must not clobber the concurrently-reverted status");
  });
});

test("checkDue stops retrying a permanently-failing wake and marks it terminally failed", async () => {
  await withTempDir(async (dataDir) => {
    // moveEmail always throws — simulates the snoozed email having been
    // moved or deleted before wakeAt, so the wake can never succeed.
    const imap = {
      async createFolder() { return { path: "Folders/MCP-Snoozed", created: true }; },
      async moveEmail() { throw new Error("message not found"); },
      async withTimeout(promise) { return promise; },
    };
    const service = new SnoozeService(createConfig(dataDir), imap);

    // snooze() itself calls moveEmail (to move it INTO Folders/MCP-Snoozed), so
    // build the record directly on disk instead, already in the snoozed
    // location, to isolate the wake-retry behavior from the snooze-out call.
    const record = {
      id: "retry-test-1",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      wakeAt: new Date(Date.now() - 1_000).toISOString(),
      status: "pending",
      originalFolder: "INBOX",
      currentEmailId: "Folders/MCP-Snoozed::999",
    };
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, "snoozed.json"),
      JSON.stringify({ version: 1, items: { [record.id]: record } }, null, 2),
      "utf8",
    );

    // Retry 5 times (MAX_WAKE_FAILURES) — each checkDue call is one attempt.
    for (let i = 0; i < 5; i += 1) {
      await service.checkDue();
    }

    const after = await service.get(record.id);
    assert.equal(after.status, "failed", "must stop retrying after the failure cap and go terminal");
    assert.equal(after.failureCount, 5);

    // One more pass must not attempt another wake — status stays "failed".
    const result = await service.checkDue();
    assert.equal(result.woken, 0);
    assert.equal(result.failed, 0, "a terminally-failed item is no longer 'due' for retry");
  });
});

test("startup recovery leaves a 'waking' record alone when its owner PID is still alive (second instance, same dataDir)", async () => {
  // Regression for: a second server process starting against a shared
  // dataDir must not stomp on a first process's live, in-flight wake just
  // because it finds a "waking" record — that record's owner (this test
  // process itself, via process.pid) is demonstrably alive.
  await withTempDir(async (dataDir) => {
    const imap = fakeImap();
    const { mkdir, writeFile } = await import("node:fs/promises");
    const liveId = "live-owner-snooze-1";
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, "snoozed.json"),
      JSON.stringify({
        version: 1,
        items: {
          [liveId]: {
            id: liveId,
            createdAt: new Date(Date.now() - 5_000).toISOString(),
            wakeAt: new Date(Date.now() - 1_000).toISOString(),
            status: "waking",
            originalFolder: "INBOX",
            currentEmailId: "Folders/MCP-Snoozed::7",
            ownerPid: process.pid,
            claimedAt: new Date(Date.now() - 5_000).toISOString(),
          },
        },
      }, null, 2),
      "utf8",
    );

    const service = new SnoozeService(createConfig(dataDir), imap);
    service.start();
    service.stop();
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(imap.moves.length, 0, "a second instance must never move an email owned by a live process's wake");
    const after = await service.get(liveId);
    assert.equal(after.status, "waking", "recovery must leave a live owner's record untouched");
  });
});

test("startup recovery still reverts a 'waking' record to pending when its owner PID is dead or absent", async () => {
  await withTempDir(async (dataDir) => {
    const imap = fakeImap();
    const { mkdir, writeFile } = await import("node:fs/promises");
    const deadPidId = "dead-owner-snooze-1";
    const noOwnerId = "no-owner-snooze-1";
    // A PID this large is extremely unlikely to correspond to a running
    // process on any real system.
    const fakeDeadPid = 999_999;
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, "snoozed.json"),
      JSON.stringify({
        version: 1,
        items: {
          [deadPidId]: {
            id: deadPidId,
            createdAt: new Date(Date.now() - 5_000).toISOString(),
            wakeAt: new Date(Date.now() - 1_000).toISOString(),
            status: "waking",
            originalFolder: "INBOX",
            currentEmailId: "Folders/MCP-Snoozed::8",
            ownerPid: fakeDeadPid,
            claimedAt: new Date(Date.now() - 5_000).toISOString(),
          },
          // No ownerPid at all — a record written before this fix existed.
          [noOwnerId]: {
            id: noOwnerId,
            createdAt: new Date(Date.now() - 5_000).toISOString(),
            wakeAt: new Date(Date.now() - 1_000).toISOString(),
            status: "waking",
            originalFolder: "INBOX",
            currentEmailId: "Folders/MCP-Snoozed::9",
          },
        },
      }, null, 2),
      "utf8",
    );

    const service = new SnoozeService(createConfig(dataDir), imap);
    // Call recoverInterruptedWakes directly (TypeScript `private` is
    // compile-time only; the compiled method is a normal, callable method)
    // so this test isolates recovery's own status flip from the
    // fired-and-forgotten checkDue() catch-up pass that start() also kicks
    // off, which would otherwise race to move the now-"pending" email.
    await service.recoverInterruptedWakes();

    assert.equal((await service.get(deadPidId)).status, "pending");
    assert.equal((await service.get(noOwnerId)).status, "pending");
  });
});
