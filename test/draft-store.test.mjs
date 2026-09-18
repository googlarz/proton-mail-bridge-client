import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DraftStoreService, draftSyncFingerprint } from "../dist/services/draft-store-service.js";

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

// Found by external review of 2.1.16: a local edit made with syncToRemote:false
// left remoteSyncState:"synced", so a later identical update_draft (a no-op
// against the local record) was wrongly treated as "remote already in sync".
test("updateDraft drops synced state on a local edit but keeps the remote ref", async () => {
  const dir = await mkdtemp(join(tmpdir(), "draft-sync-state-"));
  try {
    const store = new DraftStoreService(createConfig(dir));
    const draft = await store.createDraft({ to: ["a@example.com"], subject: "Before", body: "b" });
    await store.markRemoteSynced(draft.id, { folder: "Drafts", emailId: "Drafts::1", syncedAt: new Date().toISOString() });
    assert.equal((await store.getDraft(draft.id)).remoteSyncState, "synced");

    const edited = await store.updateDraft(draft.id, { subject: "After" });
    assert.equal(edited.remoteSyncState, "local_only");
    assert.equal(edited.remoteDraft?.emailId, "Drafts::1", "remote ref must survive so the next sync updates the existing copy");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("updateDraft leaves a sync_failed state as sync_failed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "draft-sync-state-"));
  try {
    const store = new DraftStoreService(createConfig(dir));
    const draft = await store.createDraft({ to: ["a@example.com"], subject: "S", body: "b" });
    await store.markRemoteSyncError(draft.id, "boom");
    const edited = await store.updateDraft(draft.id, { subject: "S2" });
    assert.equal(edited.remoteSyncState, "sync_failed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Found by external review of 2.1.17: sync_draft_to_remote uploads version A; while
// that is in flight update_draft(syncToRemote:false) stores version B; when the
// older upload finishes, markRemoteSynced used to mark the CURRENT record (B) synced.
test("markRemoteSynced does not mark a newer local edit as synced", async () => {
  const dir = await mkdtemp(join(tmpdir(), "draft-sync-race-"));
  try {
    const store = new DraftStoreService(createConfig(dir));
    const draft = await store.createDraft({ to: ["a@example.com"], subject: "Version A", body: "b" });
    const fingerprintA = draftSyncFingerprint(await store.getDraft(draft.id));

    await store.updateDraft(draft.id, { subject: "Version B" });
    const ref = { folder: "Drafts", emailId: "Drafts::1", syncedAt: new Date().toISOString() };
    const result = await store.markRemoteSynced(draft.id, ref, fingerprintA);

    assert.equal(result.subject, "Version B", "local content is untouched");
    assert.equal(result.remoteSyncState, "local_only");
    assert.equal(result.remoteDraft?.emailId, "Drafts::1", "remote ref kept so the next sync updates that copy");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("markRemoteSynced marks synced when the uploaded version is still current, and downgrades on a stale late finish", async () => {
  const dir = await mkdtemp(join(tmpdir(), "draft-sync-race-"));
  try {
    const store = new DraftStoreService(createConfig(dir));
    const draft = await store.createDraft({ to: ["a@example.com"], subject: "A", body: "b" });
    const fpA = draftSyncFingerprint(await store.getDraft(draft.id));
    await store.updateDraft(draft.id, { subject: "B" });
    const fpB = draftSyncFingerprint(await store.getDraft(draft.id));
    const ref = { folder: "Drafts", emailId: "Drafts::1", syncedAt: new Date().toISOString() };

    assert.equal((await store.markRemoteSynced(draft.id, ref, fpB)).remoteSyncState, "synced");
    // the older upload (A) finishing last: remote now holds A, local is B
    assert.equal((await store.markRemoteSynced(draft.id, ref, fpA)).remoteSyncState, "local_only");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
