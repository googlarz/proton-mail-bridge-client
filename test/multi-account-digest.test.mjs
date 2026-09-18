import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountManager } from "../dist/services/account-manager.js";
import { tagAccountIds } from "../dist/index.js";
import { withAccountPrefix } from "../dist/utils/helpers.js";

// Exercises the exact merge/tagging building blocks the fanned-out digest/
// follow-up tools in index.ts's CallToolRequestSchema switch statement use
// (AccountManager.all(), tagAccountIds, and a score-then-date merge sort) —
// this repo has no MCP-dispatch-level test harness (see
// test/send-test-email-guards.test.mjs), so coverage lives at this layer,
// same as every other handler-adjacent test here.

function connectionFor(address, port) {
  return { host: "127.0.0.1", port, secure: false, username: address, password: "secret" };
}

function baseRuntime() {
  return {
    readOnly: false,
    allowSend: true,
    allowRemoteDraftSync: true,
    allowedActions: ["mark_read", "mark_unread", "star", "unstar", "archive", "trash", "restore"],
    startupSync: false,
    autoSyncFolder: "INBOX",
    autoSyncFull: false,
    autoSyncLimitPerFolder: 100,
    idleWatchEnabled: false,
    idleMaxSeconds: 30,
  };
}

async function buildTwoAccountManager() {
  const primaryDataDir = await mkdtemp(join(tmpdir(), "protonmail-multiacct-primary-"));
  const secondaryDataDir = await mkdtemp(join(tmpdir(), "protonmail-multiacct-secondary-"));
  const config = {
    smtp: connectionFor("owner@example.com", 1025),
    imap: connectionFor("owner@example.com", 1143),
    dataDir: primaryDataDir,
    debug: false,
    cacheEnabled: true,
    analyticsEnabled: true,
    autoSync: false,
    syncInterval: 5,
    runtime: baseRuntime(),
    accounts: [
      {
        address: "owner@example.com",
        slug: "primary",
        imap: connectionFor("owner@example.com", 1143),
        smtp: connectionFor("owner@example.com", 1025),
        dataDir: primaryDataDir,
      },
      {
        address: "second@example.com",
        slug: "second-example-com",
        imap: connectionFor("second@example.com", 1143),
        smtp: connectionFor("second@example.com", 1025),
        dataDir: secondaryDataDir,
      },
    ],
  };
  const manager = new AccountManager(config);
  return { manager, primaryDataDir, secondaryDataDir };
}

function makeEmail(overrides) {
  return {
    folder: "INBOX",
    uid: 1,
    seq: 1,
    to: [{ address: "owner@example.com" }],
    cc: [],
    bcc: [],
    replyTo: [],
    isRead: false,
    isStarred: false,
    flags: [],
    hasAttachments: false,
    attachments: [],
    labels: [],
    ...overrides,
  };
}

async function seedAccount(bundle, ownerAddress, subject, minutesAgo) {
  const date = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  await bundle.localIndexService.recordSnapshot({
    syncedAt: new Date().toISOString(),
    folders: [
      {
        path: "INBOX",
        name: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        listed: true,
        subscribed: true,
        flags: [],
        messages: 1,
        unseen: 1,
      },
    ],
    folderStats: [{ folder: "INBOX", fetched: 1, total: 1 }],
    emails: [
      makeEmail({
        id: `INBOX::${subject}`,
        uid: 1,
        seq: 1,
        messageId: `<${subject}@example.com>`,
        subject,
        from: [{ address: "someone-else@example.com" }],
        to: [{ address: ownerAddress }],
        date,
        internalDate: date,
        isRead: false,
        preview: `Body of ${subject}`,
      }),
    ],
  });
}

test("tagAccountIds prefixes thread/message ids for a non-primary account and is a no-op for the primary", async () => {
  const { manager, primaryDataDir, secondaryDataDir } = await buildTwoAccountManager();
  try {
    await seedAccount(manager.primary(), "owner@example.com", "Primary thread", 10);
    await seedAccount(manager.bySlugOrPrimary("second-example-com"), "second@example.com", "Secondary thread", 5);

    const primaryResult = await manager.primary().localIndexService.getActionableThreads({ unreadOnly: true });
    const secondaryResult = await manager
      .bySlugOrPrimary("second-example-com")
      .localIndexService.getActionableThreads({ unreadOnly: true });

    // Primary: tagAccountIds(undefined, ...) must be a byte-for-byte no-op —
    // this is what keeps single-account output unchanged.
    const taggedPrimary = tagAccountIds(undefined, primaryResult.threads);
    assert.deepEqual(taggedPrimary, primaryResult.threads);
    assert.equal(taggedPrimary[0].id, primaryResult.threads[0].id);
    assert.ok(!taggedPrimary[0].id.startsWith("second-example-com::"));

    // Secondary: every id-bearing field must gain the "<slug>::" prefix.
    const taggedSecondary = tagAccountIds("second-example-com", secondaryResult.threads);
    assert.equal(taggedSecondary[0].id, withAccountPrefix("second-example-com", secondaryResult.threads[0].id));
    assert.equal(
      taggedSecondary[0].latestEmailId,
      withAccountPrefix("second-example-com", secondaryResult.threads[0].latestEmailId),
    );
    assert.ok(taggedSecondary[0].id.startsWith("second-example-com::"));
    // Original (untagged) result must be untouched (tagAccountIds clones).
    assert.ok(!secondaryResult.threads[0].id.startsWith("second-example-com::"));
  } finally {
    await rm(primaryDataDir, { recursive: true, force: true });
    await rm(secondaryDataDir, { recursive: true, force: true });
  }
});

test("merging two accounts' actionable threads by (score, then latestDate) surfaces both accounts, correctly tagged and ordered", async () => {
  const { manager, primaryDataDir, secondaryDataDir } = await buildTwoAccountManager();
  try {
    // Secondary account's thread is older (lower urgency by recency) than the
    // primary's, but both are otherwise equivalent (same pendingOn/score
    // inputs) — a correct age-tiebreak merge must therefore rank the primary's
    // thread first.
    await seedAccount(manager.primary(), "owner@example.com", "Primary thread", 5);
    await seedAccount(manager.bySlugOrPrimary("second-example-com"), "second@example.com", "Secondary thread", 60);

    const limit = 10;
    const perAccount = await Promise.all(
      manager.all().map(async (bundle) => {
        const result = await bundle.localIndexService.getActionableThreads({ unreadOnly: true, limit });
        const slug = bundle.account.slug === manager.primary().account.slug ? undefined : bundle.account.slug;
        return tagAccountIds(slug, result.threads);
      }),
    );
    const merged = perAccount
      .flat()
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return new Date(right.latestDate || 0).getTime() - new Date(left.latestDate || 0).getTime();
      })
      .slice(0, limit);

    assert.equal(merged.length, 2);
    // Both accounts' threads are present.
    assert.ok(merged.some((thread) => thread.id === "Primary thread" || thread.subject === "Primary thread"));
    assert.ok(merged.some((thread) => thread.id.startsWith("second-example-com::")));
    // Primary thread (more recent) ranks ahead of the secondary account's older thread.
    assert.equal(merged[0].subject, "Primary thread");
    assert.equal(merged[1].subject, "Secondary thread");
    assert.ok(merged[1].id.startsWith("second-example-com::"));
    // The primary's own id is never given the account prefix.
    assert.ok(!merged[0].id.startsWith("second-example-com::"));
  } finally {
    await rm(primaryDataDir, { recursive: true, force: true });
    await rm(secondaryDataDir, { recursive: true, force: true });
  }
});

test("a single-account AccountManager produces the exact same getActionableThreads output as calling LocalIndexService directly (no fan-out regression)", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-multiacct-solo-"));
  try {
    const config = {
      smtp: connectionFor("owner@example.com", 1025),
      imap: connectionFor("owner@example.com", 1143),
      dataDir,
      debug: false,
      cacheEnabled: true,
      analyticsEnabled: true,
      autoSync: false,
      syncInterval: 5,
      runtime: baseRuntime(),
      accounts: [
        {
          address: "owner@example.com",
          slug: "primary",
          imap: connectionFor("owner@example.com", 1143),
          smtp: connectionFor("owner@example.com", 1025),
          dataDir,
        },
      ],
    };
    const manager = new AccountManager(config);
    await seedAccount(manager.primary(), "owner@example.com", "Solo thread", 5);

    const direct = await manager.primary().localIndexService.getActionableThreads({ unreadOnly: true, limit: 50 });

    // Simulate the fan-out path from index.ts's get_actionable_threads handler
    // with only one account configured.
    const perAccount = await Promise.all(
      manager.all().map(async (bundle) => {
        const result = await bundle.localIndexService.getActionableThreads({ unreadOnly: true, limit: 50 });
        const slug = bundle.account.slug === manager.primary().account.slug ? undefined : bundle.account.slug;
        return tagAccountIds(slug, result.threads);
      }),
    );
    const merged = perAccount
      .flat()
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return new Date(right.latestDate || 0).getTime() - new Date(left.latestDate || 0).getTime();
      })
      .slice(0, 50);

    assert.deepEqual(merged, direct.threads);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
