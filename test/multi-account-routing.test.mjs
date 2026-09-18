import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AccountManager } from "../dist/services/account-manager.js";
import { splitAccountPrefix, slugifyAccountAddress, withAccountPrefix } from "../dist/utils/helpers.js";

function accountConfig(dataDir, address) {
  const slug = slugifyAccountAddress(address);
  return {
    address,
    slug,
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: address, password: "secret" },
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: address, password: "secret" },
    dataDir,
  };
}

function buildConfig(primaryDataDir, secondaryDataDir) {
  const primaryAccount = accountConfig(primaryDataDir, "primary@example.com");
  const secondaryAccount = accountConfig(secondaryDataDir, "workaddress@example.com");
  return {
    smtp: primaryAccount.smtp,
    imap: primaryAccount.imap,
    dataDir: primaryDataDir,
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
    },
    accounts: [primaryAccount, secondaryAccount],
  };
}

// Mirrors index.ts's own resolveAccountForEmailId, which the single-message tool
// handlers (get_email_by_id, mark_email_read, move_email, etc.) all go through —
// see createServer() in src/index.ts.
function resolveAccountForEmailId(accountManager, emailId) {
  const { accountSlug, rest } = splitAccountPrefix(emailId, accountManager.additionalSlugs());
  return { bundle: accountManager.bySlugOrPrimary(accountSlug), rest };
}

async function withTwoTempDirs(fn) {
  const primaryDataDir = await mkdtemp(join(tmpdir(), "protonmail-multi-account-primary-"));
  const secondaryDataDir = await mkdtemp(join(tmpdir(), "protonmail-multi-account-secondary-"));
  try {
    await fn(primaryDataDir, secondaryDataDir);
  } finally {
    await rm(primaryDataDir, { recursive: true, force: true });
    await rm(secondaryDataDir, { recursive: true, force: true });
  }
}

test("a prefixed emailId resolves to the second account's own bundle/imapService, not the primary's", async () => {
  await withTwoTempDirs(async (primaryDataDir, secondaryDataDir) => {
    const config = buildConfig(primaryDataDir, secondaryDataDir);
    const accountManager = new AccountManager(config);

    const secondarySlug = config.accounts[1].slug;
    assert.equal(secondarySlug, "workaddress-example-com");

    const prefixedId = withAccountPrefix(secondarySlug, "INBOX::123::456::abcd");
    const { bundle, rest } = resolveAccountForEmailId(accountManager, prefixedId);

    // Distinguishing behavior: the resolved bundle is a genuinely different
    // object from the primary's, wired to account B's own IMAP/SMTP credentials
    // and its own dataDir — not merely the same bundle returned twice.
    assert.notEqual(bundle, accountManager.primary());
    assert.notEqual(bundle.imapService, accountManager.primary().imapService);
    assert.equal(bundle.account.slug, secondarySlug);
    assert.equal(bundle.account.address, "workaddress@example.com");
    assert.equal(bundle.config.imap.username, "workaddress@example.com");
    assert.equal(bundle.config.dataDir, secondaryDataDir);
    assert.equal(rest, "INBOX::123::456::abcd");
  });
});

test("an unprefixed emailId always resolves to the primary account's bundle", async () => {
  await withTwoTempDirs(async (primaryDataDir, secondaryDataDir) => {
    const config = buildConfig(primaryDataDir, secondaryDataDir);
    const accountManager = new AccountManager(config);

    const { bundle, rest } = resolveAccountForEmailId(accountManager, "INBOX::123::456::abcd");

    assert.equal(bundle, accountManager.primary());
    assert.equal(bundle.account.address, "primary@example.com");
    assert.equal(bundle.config.dataDir, primaryDataDir);
    assert.equal(rest, "INBOX::123::456::abcd");
  });
});

test("bySlugOrPrimary throws for a genuinely unknown slug, rather than silently returning the primary", async () => {
  await withTwoTempDirs(async (primaryDataDir, secondaryDataDir) => {
    const config = buildConfig(primaryDataDir, secondaryDataDir);
    const accountManager = new AccountManager(config);

    assert.throws(() => accountManager.bySlugOrPrimary("not-a-real-slug"), /Unknown account/);
  });
});

test("an id whose prefix doesn't match any known account slug is treated as unprefixed (resolves to primary)", async () => {
  await withTwoTempDirs(async (primaryDataDir, secondaryDataDir) => {
    const config = buildConfig(primaryDataDir, secondaryDataDir);
    const accountManager = new AccountManager(config);

    const { bundle, rest } = resolveAccountForEmailId(accountManager, "not-a-real-slug::INBOX::123::456::abcd");

    assert.equal(bundle, accountManager.primary());
    assert.equal(rest, "not-a-real-slug::INBOX::123::456::abcd");
  });
});
