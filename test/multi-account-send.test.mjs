import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AccountManager } from "../dist/services/account-manager.js";
import { slugifyAccountAddress } from "../dist/utils/helpers.js";

// AccountManager builds one full, isolated service stack per configured account
// (see src/services/account-manager.ts). These tests verify the piece the
// send/reply/forward/draft tool handlers in src/index.ts depend on: that
// `accountManager.byAddress(from)` returns the bundle whose OWN SMTPService is
// wired to that address' connection config — not the primary's — which is what
// lets `from` actually route through the correct account under Bridge's Split
// Addresses feature (each address is its own separate IMAP/SMTP login), rather
// than just overriding the From header on one shared connection.

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), "protonmail-multi-account-test-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function connectionFor(address, port) {
  return { host: "127.0.0.1", port, secure: false, username: address, password: "secret" };
}

function buildConfig(root) {
  const primaryAddress = "owner@example.com";
  const secondaryAddress = "alias@example.com";
  const primarySlug = slugifyAccountAddress(primaryAddress);
  const secondarySlug = slugifyAccountAddress(secondaryAddress);

  const primaryAccount = {
    address: primaryAddress,
    slug: primarySlug,
    imap: connectionFor(primaryAddress, 1143),
    smtp: connectionFor(primaryAddress, 1025),
    dataDir: join(root, primarySlug),
  };
  const secondaryAccount = {
    address: secondaryAddress,
    slug: secondarySlug,
    imap: connectionFor(secondaryAddress, 2143),
    smtp: connectionFor(secondaryAddress, 2025),
    dataDir: join(root, secondarySlug),
  };

  return {
    smtp: primaryAccount.smtp,
    imap: primaryAccount.imap,
    dataDir: primaryAccount.dataDir,
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
      sendDelaySeconds: 0,
    },
    accounts: [primaryAccount, secondaryAccount],
  };
}

test("accountManager.byAddress(from) resolves the bundle whose own SMTPService is configured for that address, not the primary's", async () => {
  await withTempDir(async (root) => {
    const config = buildConfig(root);
    const manager = new AccountManager(config);

    const primary = manager.primary();
    assert.equal(primary.account.address, "owner@example.com");
    assert.equal(primary.smtpService.config.smtp.username, "owner@example.com");

    const resolved = manager.byAddress("alias@example.com");
    assert.ok(resolved, "byAddress should resolve the configured additional account");
    assert.notEqual(resolved, primary, "resolved bundle must not be the primary bundle");
    assert.equal(resolved.smtpService.config.smtp.username, "alias@example.com");
    assert.equal(resolved.smtpService.config.smtp.port, 2025);

    // Case-insensitive, matching isValidEmail's own case-insensitive address handling.
    const resolvedUpper = manager.byAddress("ALIAS@EXAMPLE.COM");
    assert.equal(resolvedUpper, resolved);
  });
});

test("accountManager.byAddress(from) returns undefined for a `from` that isn't a configured account (header-override-on-primary fallback stays valid)", async () => {
  await withTempDir(async (root) => {
    const config = buildConfig(root);
    const manager = new AccountManager(config);

    const resolved = manager.byAddress("not-configured@example.com");
    assert.equal(resolved, undefined);

    // This is exactly the fallback path send_email/reply_to_email/reply_all_email/
    // forward_email/send_test_email take when byAddress returns undefined: send via
    // the primary's own SMTPService with `from` passed through as a header override
    // (already covered end-to-end by buildRawMessage's "sends as the caller's from
    // address instead of the Bridge login when provided" test in smtp.test.mjs).
    const primary = manager.primary();
    assert.equal(primary.smtpService.config.smtp.username, "owner@example.com");
  });
});

test("draftId/emailId account-slug prefixing round-trips through withAccountPrefix/splitAccountPrefix", async () => {
  const { withAccountPrefix, splitAccountPrefix } = await import("../dist/utils/helpers.js");

  const additionalSlugs = ["alias-example-com"];
  const prefixed = withAccountPrefix("alias-example-com", "draft-123");
  assert.equal(prefixed, "alias-example-com::draft-123");

  const { accountSlug, rest } = splitAccountPrefix(prefixed, additionalSlugs);
  assert.equal(accountSlug, "alias-example-com");
  assert.equal(rest, "draft-123");

  // A primary (unprefixed) id keeps resolving to no slug at all — this is what
  // lets get_draft/send_draft/etc. keep working unchanged for every id that
  // existed before multi-account support.
  const unprefixed = splitAccountPrefix("draft-456", additionalSlugs);
  assert.equal(unprefixed.accountSlug, undefined);
  assert.equal(unprefixed.rest, "draft-456");
});
