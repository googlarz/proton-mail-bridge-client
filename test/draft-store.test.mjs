import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
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

test("a sent draft older than the retention window is pruned on the next write, but a recent one and an active draft are kept", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-drafts-prune-"));
  const draftPath = join(dataDir, "drafts.json");
  try {
    const store = new DraftStoreService(createConfig(dataDir));

    const oldSent = await store.createDraft({ subject: "old-sent", body: "b", to: ["a@example.com"] });
    await store.markSent(oldSent.id, { messageId: "<old@example.com>" });

    const recentSent = await store.createDraft({ subject: "recent-sent", body: "b", to: ["a@example.com"] });
    await store.markSent(recentSent.id, { messageId: "<recent@example.com>" });

    const active = await store.createDraft({ subject: "active", body: "b", to: ["a@example.com"] });

    // Backdate the old sent draft's sentAt directly in the file — markSent
    // always stamps "now", so the only way to get a genuinely old record is
    // to rewrite the persisted timestamp, same as it would arrive after 30
    // real days of use.
    const raw = JSON.parse(await readFile(draftPath, "utf8"));
    raw.drafts[oldSent.id].sentAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(draftPath, JSON.stringify(raw, null, 2), "utf8");

    // Any write path triggers pruning; updating the still-active draft is enough.
    await store.updateDraft(active.id, { subject: "active-updated" });

    const remaining = await store.listDrafts(true);
    const ids = remaining.map((draft) => draft.id).sort();
    assert.deepEqual(ids, [active.id, recentSent.id].sort());
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
