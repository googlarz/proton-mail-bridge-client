import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DraftStoreService } from "../dist/services/draft-store-service.js";

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

test("two separate DraftStoreService instances against the same dataDir don't lose each other's writes", async () => {
  // Found live: Claude Desktop can and does run more than one MCP server
  // process against the same account (confirmed live: two server processes,
  // both children of one Claude.app, running concurrently). This service
  // additionally cached its store in memory (this.loadedStore) — even with
  // a cross-process lock, a second process's write was invisible to a
  // process still holding a stale cached copy from before the lock was
  // ever taken, and the next save() from the stale side would have
  // silently clobbered it. Removed the cache (matching the other three
  // JSON stores' "always read from disk" pattern) alongside adding the
  // lock — this test uses two separate instances (standing in for two
  // separate processes) so it would have caught either gap on its own.
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-drafts-race-"));
  try {
    const a = new DraftStoreService(createConfig(dataDir));
    const b = new DraftStoreService(createConfig(dataDir));

    await Promise.all([
      a.createDraft({ subject: "from-a", body: "ba", to: ["a@example.com"] }),
      b.createDraft({ subject: "from-b", body: "bb", to: ["b@example.com"] }),
    ]);

    const drafts = await a.listDrafts();
    assert.deepEqual(
      drafts.map((d) => d.subject).sort(),
      ["from-a", "from-b"],
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DraftStoreService serializes concurrent draft creation", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-drafts-"));
  const store = new DraftStoreService(createConfig(dataDir));

  try {
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.createDraft({
          subject: `Draft ${index}`,
          body: `Body ${index}`,
          to: [`recipient-${index}@example.com`],
        }),
      ),
    );

    const drafts = await store.listDrafts();
    assert.equal(drafts.length, 10);
    assert.equal(new Set(drafts.map((draft) => draft.id)).size, 10);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
