import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncLeader } from "../dist/services/sync-leader.js";
import { BackgroundSyncService } from "../dist/services/background-sync-service.js";

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "sync-leader-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

test("only one instance per data directory holds the lease, and the next takes over on release", async () => {
  await withDir(async (dir) => {
    const first = new SyncLeader(dir);
    const second = new SyncLeader(dir);
    assert.equal(first.tryAcquire(), true);
    assert.equal(second.tryAcquire(), false);
    assert.equal(first.tryAcquire(), true, "the holder keeps it");
    first.release();
    assert.equal(second.tryAcquire(), true);
    second.release();
    assert.equal(existsSync(join(dir, "background-sync.lock")), false);
  });
});

test("a lease from a dead process or without a recent heartbeat is taken over", async () => {
  await withDir(async (dir) => {
    const lock = join(dir, "background-sync.lock");
    await writeFile(lock, JSON.stringify({ token: "x", pid: 2_147_000_000, heartbeatAt: Date.now() }));
    const a = new SyncLeader(dir);
    assert.equal(a.tryAcquire(), true, "its process does not exist");
    a.release();
    await writeFile(lock, JSON.stringify({ token: "y", pid: process.pid, heartbeatAt: Date.now() - 10 * 60_000 }));
    const b = new SyncLeader(dir);
    assert.equal(b.tryAcquire(), true, "no heartbeat for minutes");
    b.release();
    await writeFile(lock, "not json");
    const c = new SyncLeader(dir);
    assert.equal(c.tryAcquire(), true, "an unreadable lease counts as none");
    c.release();
  });
});

test("a lock that cannot be created never blocks the instance", async () => {
  await withDir(async (dir) => {
    const blocker = join(dir, "file");
    await writeFile(blocker, "x");
    assert.equal(new SyncLeader(join(blocker, "inside")).tryAcquire(), true);
  });
});

function syncConfig(dataDir) {
  return {
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "o@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "o@example.com", password: "x" },
    dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: true, syncInterval: 5,
    runtime: { startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30 },
  };
}

test("an instance without the lease skips scheduled syncs but still runs a manual one", async () => {
  await withDir(async (dir) => {
    let collected = 0;
    const imap = { async collectEmailsForIndex() { collected += 1; return { syncedAt: "2026-01-01T00:00:00.000Z", full: false, folders: [], folderStats: [], emails: [] }; } };
    const index = { async getSyncCheckpointMap() { return {}; }, async recordSnapshot() { return { path: "p", staleThresholdMinutes: 1, isStale: false }; } };
    const holder = new SyncLeader(dir);
    assert.equal(holder.tryAcquire(), true);
    const service = new BackgroundSyncService(syncConfig(dir), imap, index);
    const skipped = await service.runNow("interval");
    assert.equal(collected, 0);
    assert.equal(skipped.leader, false);
    await service.runNow("manual");
    assert.equal(collected, 1);
    holder.release();
    const taken = await service.runNow("interval");
    assert.equal(collected, 2);
    assert.equal(taken.leader, true);
    service.stop();
  });
});
