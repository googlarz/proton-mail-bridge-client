import test from "node:test";
import assert from "node:assert/strict";
import { BackgroundSyncService } from "../dist/services/background-sync-service.js";

function createConfig() {
  return {
    smtp: {
      host: "127.0.0.1",
      port: 1025,
      secure: false,
      username: "owner@example.com",
      password: "secret",
    },
    imap: {
      host: "127.0.0.1",
      port: 1143,
      secure: false,
      username: "owner@example.com",
      password: "secret",
    },
    dataDir: "/tmp/protonmail-pro-mcp-test",
    debug: false,
    cacheEnabled: true,
    analyticsEnabled: true,
    autoSync: true,
    syncInterval: 5,
    runtime: {
      readOnly: false,
      allowSend: true,
      allowRemoteDraftSync: true,
      allowedActions: ["mark_read", "mark_unread", "star", "unstar", "archive", "trash", "restore"],
      startupSync: false,
      autoSyncFolder: "INBOX",
      autoSyncFull: false,
      autoSyncLimitPerFolder: 25,
      idleWatchEnabled: false,
      idleMaxSeconds: 30,
    },
  };
}

test("background sync records success and schedules the next run", async () => {
  const imapService = {
    calls: [],
    async collectEmailsForIndex(input) {
      this.calls.push(input);
      return {
        syncedAt: "2026-03-24T12:00:00.000Z",
        full: false,
        folders: [],
        folderStats: [{ folder: "INBOX", fetched: 0, total: 0 }],
        emails: [],
      };
    },
    async waitForMailboxChanges() {
      return {
        folder: "INBOX",
        timeoutMs: 1000,
        checkedAt: "2026-03-24T12:00:01.000Z",
        changed: false,
        events: [],
      };
    },
  };
  const localIndexService = {
    snapshots: [],
    async getSyncCheckpointMap() {
      return {};
    },
    async recordSnapshot(snapshot) {
      this.snapshots.push(snapshot);
      return {
        path: "/tmp/mail-index.json",
        staleThresholdMinutes: 60,
        isStale: false,
        folderCount: 0,
        labelCount: 0,
        threadCount: 0,
        storedMessageCount: 0,
        dedupedMessageCount: 0,
        syncCheckpoints: [],
        folders: [],
        updatedAt: snapshot.syncedAt,
      };
    },
  };

  const service = new BackgroundSyncService(createConfig(), imapService, localIndexService);
  service.start();

  try {
    const status = await service.runNow("unit-test");
    assert.equal(imapService.calls.length, 1);
    assert.equal(localIndexService.snapshots.length, 1);
    assert.equal(status.lastSuccessAt, "2026-03-24T12:00:00.000Z");
    assert.equal(status.folder, "INBOX");
    assert.equal(status.limitPerFolder, 25);
    assert.equal(status.idleEnabled, false);
    assert.ok(status.nextRunAt);
  } finally {
    service.stop();
  }
});

test("background sync passes the full folder list to indexing but only the first folder to IDLE", async () => {
  const imapService = {
    indexCalls: [],
    idleCalls: [],
    async collectEmailsForIndex(input) {
      this.indexCalls.push(input.folder);
      return { syncedAt: "2026-03-24T12:00:00.000Z", full: false, folders: [], folderStats: [], emails: [] };
    },
    async waitForMailboxChanges(input) {
      this.idleCalls.push(input.folder);
      return { folder: input.folder, timeoutMs: 1000, checkedAt: "2026-03-24T12:00:01.000Z", changed: false, events: [] };
    },
  };
  const localIndexService = {
    async getSyncCheckpointMap() {
      return {};
    },
    async recordSnapshot(snapshot) {
      return { updatedAt: snapshot.syncedAt };
    },
  };

  const config = createConfig();
  config.runtime.autoSyncFolder = "INBOX,Sent";
  config.runtime.idleWatchEnabled = true;

  const service = new BackgroundSyncService(config, imapService, localIndexService);
  service.start();

  try {
    await service.runNow("unit-test");
    assert.deepEqual(imapService.indexCalls, ["INBOX,Sent"]);

    // Give the IDLE loop's first iteration a tick to run.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(imapService.idleCalls.length > 0);
    assert.ok(imapService.idleCalls.every((folder) => folder === "INBOX"));
  } finally {
    service.stop();
  }
});

test("a later successful sync clears lastError/lastFailureKind left by an earlier failed sync attempt", async () => {
  let shouldFail = true;
  const imapService = {
    async collectEmailsForIndex() {
      if (shouldFail) {
        throw new Error("Temporary network hiccup");
      }
      return { syncedAt: "2026-03-24T12:00:00.000Z", full: false, folders: [], folderStats: [], emails: [] };
    },
    async waitForMailboxChanges() {
      return { folder: "INBOX", timeoutMs: 1000, checkedAt: "2026-03-24T12:00:01.000Z", changed: false, events: [] };
    },
  };
  const localIndexService = {
    async getSyncCheckpointMap() {
      return {};
    },
    async recordSnapshot(snapshot) {
      return { updatedAt: snapshot.syncedAt };
    },
  };

  const service = new BackgroundSyncService(createConfig(), imapService, localIndexService);
  service.start();

  try {
    // First attempt fails: error fields get set.
    const failedStatus = await service.runNow("unit-test-fail");
    assert.equal(failedStatus.lastFailureKind, "transient");
    assert.match(failedStatus.lastError, /temporary network hiccup/i);

    // Second attempt succeeds: every stale error field must be cleared, not left
    // over from the earlier failed attempt, even though lastSuccessAt moves
    // forward.
    shouldFail = false;
    const successStatus = await service.runNow("unit-test-success");
    assert.equal(successStatus.lastSuccessAt, "2026-03-24T12:00:00.000Z");
    assert.equal(successStatus.lastError, undefined);
    assert.equal(successStatus.lastFailureKind, undefined);
    assert.equal(successStatus.lastFailureMessage, undefined);
  } finally {
    service.stop();
  }
});

test("a later successful sync clears a stale lastIdleError left by an earlier failed IDLE watch", async () => {
  const imapService = {
    async collectEmailsForIndex() {
      return { syncedAt: "2026-03-24T12:00:00.000Z", full: false, folders: [], folderStats: [], emails: [] };
    },
    // Always fails (transient — not an auth error, so the IDLE loop keeps
    // retrying instead of breaking out) — lastIdleError can only be cleared by
    // a real, successful sync attempt (runNow) below, never by the IDLE loop's
    // own next iteration succeeding, isolating the exact bug being tested.
    async waitForMailboxChanges() {
      throw new Error("IDLE connection reset");
    },
  };
  const localIndexService = {
    async getSyncCheckpointMap() {
      return {};
    },
    async recordSnapshot(snapshot) {
      return { updatedAt: snapshot.syncedAt };
    },
  };

  const config = createConfig();
  config.runtime.idleWatchEnabled = true;

  const service = new BackgroundSyncService(config, imapService, localIndexService);
  service.start();

  try {
    // A successful sync starts the IDLE loop; its first iteration throws
    // (simulated transient IDLE failure) and records lastIdleError.
    await service.runNow("unit-test-start");
    let status = service.getStatus();
    for (let attempt = 0; attempt < 50 && !status.lastIdleError; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = service.getStatus();
    }
    assert.match(status.lastIdleError, /idle connection reset/i);

    // A later successful sync attempt must clear that stale lastIdleError too —
    // previously only a further successful IDLE iteration cleared it, so
    // lastIdleError stayed visible forever even after lastSuccessAt moved
    // forward via a real, successful sync.
    status = await service.runNow("unit-test-success");
    assert.equal(status.lastIdleError, undefined);
  } finally {
    service.stop();
  }
});

test("background sync backs off cleanly on auth failures", async () => {
  const imapService = {
    attempts: 0,
    async collectEmailsForIndex() {
      this.attempts += 1;
      throw new Error("Incorrect login credentials.");
    },
    async waitForMailboxChanges() {
      throw new Error("Incorrect login credentials.");
    },
  };
  const localIndexService = {
    async getSyncCheckpointMap() {
      return {};
    },
    async recordSnapshot() {
      throw new Error("should not be called");
    },
  };

  const service = new BackgroundSyncService(createConfig(), imapService, localIndexService);
  service.start();

  try {
    const status = await service.runNow("unit-test-auth");
    assert.equal(imapService.attempts, 1);
    assert.equal(status.lastFailureKind, "auth");
    assert.match(status.lastError, /incorrect login credentials/i);
    assert.ok(status.backoffUntil);
    assert.ok(status.nextRunAt);
    assert.equal(status.idleWatching, false);
  } finally {
    service.stop();
  }
});
