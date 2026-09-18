import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountManager } from "../dist/services/account-manager.js";
import { createEmailId } from "../dist/utils/helpers.js";
import {
  groupEmailIdsByAccount,
  prefixBulkResult,
  prefixNotFound,
  mergeBulkResults,
} from "../dist/index.js";

// Proves the routing logic added to index.ts's bulk_* handlers: a mixed
// emailIds array (some prefixed for a non-primary account, some plain for
// the primary) is grouped by resolveAccountForEmailId's "<slug>::" prefix
// convention (groupEmailIdsByAccount, the same helper the handlers use),
// each group is run against its OWN account's SimpleIMAPService instance
// (never the other account's), and the merged response correctly
// re-attributes every result entry to its original (possibly prefixed)
// emailId — matching the shape the bulk_delete handler actually returns.

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

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

function createConfig(primaryDataDir, accounts) {
  return {
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: accounts[0].address, password: "secret" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: accounts[0].address, password: "secret" },
    dataDir: primaryDataDir,
    debug: false,
    cacheEnabled: true,
    analyticsEnabled: true,
    autoSync: false,
    syncInterval: 5,
    runtime: baseRuntime(),
    accounts,
  };
}

// A minimal fake ImapFlow client backing a single folder's message set —
// mirrors test/uid-validity.test.mjs's createFakeClient, extended with the
// `search`+`messageDelete` pair bulkDelete's permanent branch needs.
function createFakeClient(state) {
  return {
    usable: true,
    capabilities: new Set(["UIDPLUS"]),
    mailbox: false,
    async getMailboxLock(folder) {
      this.mailbox = { uidValidity: state.uidValidity, exists: state.messages.size, uidNext: state.uidNext };
      return { release: () => {} };
    },
    async status() {
      return { uidValidity: state.uidValidity, uidNext: state.uidNext, messages: state.messages.size };
    },
    async fetchOne(range) {
      const uid = Number(range);
      if (!state.messages.has(uid)) return false;
      return { uid, envelope: {} };
    },
    async search(query) {
      if (query && typeof query.uid === "string") {
        return query.uid.split(",").map(Number).filter((uid) => state.messages.has(uid));
      }
      return [];
    },
    async messageDelete(range) {
      for (const uid of String(range).split(",").map(Number)) {
        state.messages.delete(uid);
      }
      return true;
    },
  };
}

async function withTempDirs(n, fn) {
  const dirs = [];
  for (let i = 0; i < n; i++) {
    dirs.push(await mkdtemp(join(tmpdir(), `protonmail-multi-account-bulk-test-${i}-`)));
  }
  try {
    await fn(...dirs);
  } finally {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  }
}

test("groupEmailIdsByAccount splits a mixed emailIds array by each id's account prefix", async () => {
  await withTempDirs(2, async (dirA, dirB) => {
    const accounts = [
      { slug: "primary", address: "primary@example.com", dataDir: dirA, imap: { host: "h", port: 1, secure: false, username: "u", password: "p" }, smtp: { host: "h", port: 1, secure: false, username: "u", password: "p" } },
      { slug: "work", address: "work@example.com", dataDir: dirB, imap: { host: "h", port: 1, secure: false, username: "u", password: "p" }, smtp: { host: "h", port: 1, secure: false, username: "u", password: "p" } },
    ];
    const accountManager = new AccountManager(createConfig(dirA, accounts), quietLogger);

    const primaryId1 = createEmailId("INBOX", 1, "1000000001");
    const primaryId2 = createEmailId("INBOX", 2, "1000000001");
    const workRest1 = createEmailId("INBOX", 10, "2000000002");
    const workRest2 = createEmailId("INBOX", 11, "2000000002");
    const workId1 = `work::${workRest1}`;
    const workId2 = `work::${workRest2}`;

    const groups = groupEmailIdsByAccount(accountManager, [primaryId1, workId1, primaryId2, workId2]);

    assert.equal(groups.size, 2);
    const primaryGroup = groups.get(undefined);
    const workGroup = groups.get("work");
    assert.ok(primaryGroup, "an unprefixed id must resolve to the primary account (key undefined)");
    assert.ok(workGroup, "a work::-prefixed id must resolve to the work account");
    assert.deepEqual(primaryGroup.restIds, [primaryId1, primaryId2]);
    assert.deepEqual(workGroup.restIds, [workRest1, workRest2]);
    assert.equal(primaryGroup.bundle.account.slug, "primary");
    assert.equal(workGroup.bundle.account.slug, "work");
    // Each group's bundle owns its OWN SimpleIMAPService instance, never the
    // other account's.
    assert.notEqual(primaryGroup.bundle.imapService, workGroup.bundle.imapService);
  });
});

test("bulk_delete-shaped call: a mixed emailIds array deletes each id against its OWN account's imapService, and the merged response attributes every result back to its original (prefixed) emailId", async () => {
  await withTempDirs(2, async (dirA, dirB) => {
    const accounts = [
      { slug: "primary", address: "primary@example.com", dataDir: dirA, imap: { host: "h", port: 1, secure: false, username: "u", password: "p" }, smtp: { host: "h", port: 1, secure: false, username: "u", password: "p" } },
      { slug: "work", address: "work@example.com", dataDir: dirB, imap: { host: "h", port: 1, secure: false, username: "u", password: "p" }, smtp: { host: "h", port: 1, secure: false, username: "u", password: "p" } },
    ];
    const accountManager = new AccountManager(createConfig(dirA, accounts), quietLogger);
    const primaryBundle = accountManager.bySlugOrPrimary(undefined);
    const workBundle = accountManager.bySlugOrPrimary("work");

    // Two entirely separate mailbox states — account isolation means a
    // fake client is wired up per account, and the two must never see each
    // other's messages.
    const primaryState = { uidValidity: "1000000001", uidNext: 100, messages: new Map([[1, {}], [2, {}]]) };
    const workState = { uidValidity: "2000000002", uidNext: 100, messages: new Map([[10, {}], [11, {}]]) };
    primaryBundle.imapService.client = createFakeClient(primaryState);
    workBundle.imapService.client = createFakeClient(workState);

    const primaryId1 = createEmailId("INBOX", 1, "1000000001");
    const primaryId2 = createEmailId("INBOX", 2, "1000000001");
    const workRest1 = createEmailId("INBOX", 10, "2000000002");
    const workRest2 = createEmailId("INBOX", 11, "2000000002");
    const workId1 = `work::${workRest1}`;
    const workId2 = `work::${workRest2}`;
    const originalEmailIds = [primaryId1, workId1, primaryId2, workId2];

    // Mirrors index.ts's bulk_delete handler: group -> resolve uids per
    // group against that group's OWN imapService -> run bulkDelete per
    // group -> prefix + merge.
    const groups = groupEmailIdsByAccount(accountManager, originalEmailIds);
    const outputs = [];
    for (const [slug, group] of groups) {
      const uids = await group.bundle.imapService.resolveUidsForBulkOp("INBOX", group.restIds, undefined);
      const raw = await group.bundle.imapService.bulkDelete({
        emailIds: group.restIds,
        folder: "INBOX",
        permanent: true,
        resolvedUids: uids,
      });
      const outputSlug = slug === primaryBundle.account.slug ? undefined : slug;
      outputs.push(prefixBulkResult(raw, outputSlug));
    }
    const merged = mergeBulkResults(outputs);

    assert.equal(merged.succeeded, 4);
    assert.equal(merged.failed, 0);
    assert.equal(merged.total, 4);

    // The work account's fake client actually received the delete calls for
    // its own two messages...
    assert.equal(workState.messages.has(10), false);
    assert.equal(workState.messages.has(11), false);
    // ...and the primary account's messages were deleted via ITS OWN
    // imapService, not the work account's.
    assert.equal(primaryState.messages.has(1), false);
    assert.equal(primaryState.messages.has(2), false);

    // Every entry in the merged response is attributed back to its
    // ORIGINAL, possibly-prefixed emailId — not a bare/rest id.
    const resultIds = merged.results.map((r) => r.emailId).sort();
    assert.deepEqual(resultIds, [...originalEmailIds].sort());
    for (const entry of merged.results) {
      assert.equal(entry.ok, true, `expected ${entry.emailId} to succeed`);
    }
  });
});

test("prefixNotFound and withBulkNotFound-equivalent merging: a notFound id from a non-primary account group is re-prefixed before merging", () => {
  const excluded = [{ emailId: "INBOX::99::2000000002", error: "Email not found for uid 99" }];
  const prefixed = prefixNotFound(excluded, "work");
  assert.deepEqual(prefixed, [{ emailId: "work::INBOX::99::2000000002", error: "Email not found for uid 99" }]);

  // An id resolved to the PRIMARY account (slug undefined) is left
  // unprefixed, preserving the pre-multi-account id format exactly.
  const unprefixed = prefixNotFound(excluded, undefined);
  assert.deepEqual(unprefixed, excluded);
});

test("mergeBulkResults combines totals/succeeded/failed/notFound across account groups and concatenates results in group order", () => {
  const a = { dryRun: false, total: 2, succeeded: 2, failed: 0, notFound: 0, results: [{ uid: 1, emailId: "a1", ok: true }, { uid: 2, emailId: "a2", ok: true }] };
  const b = { dryRun: false, total: 1, succeeded: 0, failed: 1, notFound: 0, results: [{ uid: 3, emailId: "work::b1", ok: false, error: "boom" }] };

  const merged = mergeBulkResults([a, b]);
  assert.equal(merged.total, 3);
  assert.equal(merged.succeeded, 2);
  assert.equal(merged.failed, 1);
  assert.deepEqual(merged.results.map((r) => r.emailId), ["a1", "a2", "work::b1"]);
});
