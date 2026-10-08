import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditService } from "../dist/services/audit-service.js";

function createConfig(dataDir) {
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
      allowedActions: ["mark_read", "mark_unread", "star", "unstar", "archive", "trash", "restore"],
      startupSync: false,
      autoSyncFolder: "INBOX",
      autoSyncFull: false,
      autoSyncLimitPerFolder: 100,
      idleWatchEnabled: true,
      idleMaxSeconds: 30,
    },
  };
}

test("audit service persists and tails recent entries", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-audit-test-"));
  const service = new AuditService(createConfig(dataDir));

  try {
    await service.record({
      timestamp: "2026-03-24T12:00:00.000Z",
      tool: "send_email",
      status: "success",
      durationMs: 12,
      input: { to: ["user@example.com"] },
      result: { messageId: "<a@example.com>" },
    });
    await service.record({
      timestamp: "2026-03-24T12:00:01.000Z",
      tool: "trash_email",
      status: "error",
      durationMs: 7,
      error: "blocked",
    });

    const entries = await service.list(10);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].tool, "send_email");
    assert.equal(entries[1].status, "error");

    const latest = await service.list(1);
    assert.equal(latest.length, 1);
    assert.equal(latest[0].tool, "trash_email");
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
