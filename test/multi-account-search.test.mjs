import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountManager } from "../dist/services/account-manager.js";
import { withAccountPrefix } from "../dist/utils/helpers.js";

// These tests exercise the exact merge logic used by src/index.ts's
// search_indexed_emails and get_labels handlers (fanning out across
// accountManager.all() and merging), without going through the MCP
// dispatcher — see the "Merge strategy" comments in src/index.ts for the
// handler code this mirrors.

function baseRuntime() {
  return {
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
  };
}

function accountFor(address, dataDir) {
  return {
    slug: address.split("@")[0],
    address,
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: address, password: "secret" },
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: address, password: "secret" },
    dataDir,
  };
}

async function buildConfig(accounts) {
  return {
    smtp: accounts[0].smtp,
    imap: accounts[0].imap,
    dataDir: accounts[0].dataDir,
    debug: false,
    cacheEnabled: true,
    analyticsEnabled: true,
    autoSync: false,
    syncInterval: 5,
    runtime: baseRuntime(),
    accounts,
  };
}

function fixtureEmail(id, subject, dateIso) {
  return {
    id,
    folder: "INBOX",
    uid: 1,
    seq: 1,
    messageId: `<${id}@example.com>`,
    subject,
    from: [{ address: "sender@example.com" }],
    to: [{ address: "owner@example.com" }],
    cc: [],
    bcc: [],
    replyTo: [],
    date: dateIso,
    internalDate: dateIso,
    isRead: false,
    isStarred: false,
    flags: [],
    preview: subject,
    hasAttachments: false,
    attachments: [],
    labels: [],
  };
}

async function seedAccount(bundle, subject, id, dateIso) {
  await bundle.localIndexService.recordSnapshot({
    syncedAt: dateIso,
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
    emails: [fixtureEmail(id, subject, dateIso)],
  });
}

// Mirrors search_indexed_emails' fan-out branch in src/index.ts.
async function fanOutSearch(accountManager, filters) {
  const primarySlug = accountManager.primary().account.slug;
  const perAccount = await Promise.all(
    accountManager.all().map(async (bundle) => ({ bundle, result: await bundle.localIndexService.search(filters) })),
  );
  const tagged = perAccount.flatMap(({ bundle, result }) =>
    result.emails.map((email) => ({
      ...email,
      id: withAccountPrefix(bundle.account.slug === primarySlug ? undefined : bundle.account.slug, email.id),
    })),
  );
  const total = perAccount.reduce((sum, { result }) => sum + result.total, 0);
  return { total, emails: tagged };
}

// Mirrors get_labels' fan-out branch in src/index.ts.
async function fanOutLabels(accountManager, limit) {
  const perAccountLabels = await Promise.all(accountManager.all().map((bundle) => bundle.localIndexService.getLabels(limit)));
  const merged = new Map();
  for (const labels of perAccountLabels) {
    for (const label of labels) {
      const key = `${label.type}:${label.name}`;
      const existing = merged.get(key);
      if (existing) {
        existing.messageCount += label.messageCount;
        existing.unreadCount += label.unreadCount;
        existing.threadCount += label.threadCount;
      } else {
        merged.set(key, { ...label });
      }
    }
  }
  return [...merged.values()];
}

test("search_indexed_emails fan-out: results from both accounts appear, correctly tagged", async () => {
  const dataDirA = await mkdtemp(join(tmpdir(), "protonmail-multi-a-"));
  const dataDirB = await mkdtemp(join(tmpdir(), "protonmail-multi-b-"));
  try {
    const accounts = [accountFor("owner@example.com", dataDirA), accountFor("second@example.com", dataDirB)];
    const config = await buildConfig(accounts);
    const accountManager = new AccountManager(config);

    await seedAccount(accountManager.primary(), "Primary invoice", "INBOX::1", "2026-03-24T11:00:00.000Z");
    const secondBundle = accountManager.bySlugOrPrimary("second");
    await seedAccount(secondBundle, "Second invoice", "INBOX::1", "2026-03-25T11:00:00.000Z");

    const merged = await fanOutSearch(accountManager, { query: "invoice", limit: 10 });

    assert.equal(merged.total, 2);
    const ids = merged.emails.map((email) => email.id).sort();
    assert.deepEqual(ids, ["INBOX::1", "second::INBOX::1"]);

    const primaryEmail = merged.emails.find((email) => email.id === "INBOX::1");
    const secondEmail = merged.emails.find((email) => email.id === "second::INBOX::1");
    assert.equal(primaryEmail.subject, "Primary invoice");
    assert.equal(secondEmail.subject, "Second invoice");
  } finally {
    await rm(dataDirA, { recursive: true, force: true });
    await rm(dataDirB, { recursive: true, force: true });
  }
});

test("get_labels fan-out: same-named labels from both accounts are summed into one row", async () => {
  const dataDirA = await mkdtemp(join(tmpdir(), "protonmail-multi-labels-a-"));
  const dataDirB = await mkdtemp(join(tmpdir(), "protonmail-multi-labels-b-"));
  try {
    const accounts = [accountFor("owner@example.com", dataDirA), accountFor("second@example.com", dataDirB)];
    const config = await buildConfig(accounts);
    const accountManager = new AccountManager(config);

    await seedAccount(accountManager.primary(), "A1", "INBOX::1", "2026-03-24T11:00:00.000Z");
    const secondBundle = accountManager.bySlugOrPrimary("second");
    await seedAccount(secondBundle, "B1", "INBOX::1", "2026-03-25T11:00:00.000Z");

    const merged = await fanOutLabels(accountManager, 250);
    const inbox = merged.find((label) => label.type === "folder" && label.name === "Inbox");
    assert.ok(inbox, "expected a merged INBOX label");
    assert.equal(inbox.messageCount, 2);
    assert.equal(inbox.unreadCount, 2);
  } finally {
    await rm(dataDirA, { recursive: true, force: true });
    await rm(dataDirB, { recursive: true, force: true });
  }
});

test("single-account AccountManager produces identical search results to calling LocalIndexService directly", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-single-"));
  try {
    const accounts = [accountFor("owner@example.com", dataDir)];
    const config = await buildConfig(accounts);
    const accountManager = new AccountManager(config);
    assert.equal(accountManager.all().length, 1);

    await seedAccount(accountManager.primary(), "Solo invoice", "INBOX::1", "2026-03-24T11:00:00.000Z");

    const direct = await accountManager.primary().localIndexService.search({ query: "invoice", limit: 10 });
    const merged = await fanOutSearch(accountManager, { query: "invoice", limit: 10 });

    // Single-account fan-out must be byte-for-byte identical to the direct
    // single-bundle call: no account prefix appears anywhere, and every
    // field matches exactly.
    assert.deepEqual(
      merged.emails.map(({ id, subject }) => ({ id, subject })),
      direct.emails.map(({ id, subject }) => ({ id, subject })),
    );
    assert.equal(merged.total, direct.total);
    assert.ok(merged.emails.every((email) => !email.id.includes("::") || email.id === "INBOX::1"));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
