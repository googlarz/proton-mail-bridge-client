import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureDestructiveConfirmed,
  ensureEmailActionAllowed,
  ensureFlagChangeAllowed,
  ensureSendAllowed,
  resolveRemoteDraftSync,
  sanitizeRuntimeConfig,
} from "../dist/utils/runtime-policy.js";

function createRuntime(overrides = {}) {
  return {
    readOnly: false,
    allowSend: true,
    allowRemoteDraftSync: true,
    allowedActions: ["mark_read", "mark_unread", "star", "unstar", "archive", "trash", "restore"],
    startupSync: true,
    autoSyncFolder: "INBOX",
    autoSyncFull: false,
    autoSyncLimitPerFolder: 100,
    idleWatchEnabled: true,
    idleMaxSeconds: 30,
    confirmDestructive: false,
    allowEmptyFolder: false,
    restrictOutboundToSelf: false,
    allowFileDownloadDir: undefined,
    maxInlineBytes: 40960,
    opDelayMs: 0,
    sendDelaySeconds: 0,
    ...overrides,
  };
}

test("read-only runtime blocks send and remote mailbox actions", () => {
  const runtime = createRuntime({ readOnly: true, allowSend: false, allowRemoteDraftSync: false });

  assert.throws(() => ensureSendAllowed(runtime), /disabled/i);
  assert.throws(() => ensureEmailActionAllowed(runtime, "archive"), /read-only mode/i);
  assert.deepEqual(resolveRemoteDraftSync(runtime, true), {
    enabled: false,
    reason: "Remote draft sync is disabled because the server is running in read-only mode.",
  });
});

test("allowed actions are enforced explicitly", () => {
  const runtime = createRuntime({ allowedActions: ["mark_read", "mark_unread"] });

  assert.doesNotThrow(() => ensureEmailActionAllowed(runtime, "mark_read"));
  assert.throws(
    () => ensureEmailActionAllowed(runtime, "trash"),
    /disabled by the current runtime policy/i,
  );
});

test("sanitized runtime config excludes secrets and preserves policy flags", () => {
  const runtime = createRuntime({ allowSend: false, autoSyncFolder: "Archive" });
  assert.deepEqual(sanitizeRuntimeConfig(runtime), {
    readOnly: false,
    allowSend: false,
    allowRemoteDraftSync: true,
    allowedActions: ["mark_read", "mark_unread", "star", "unstar", "archive", "trash", "restore"],
    startupSync: true,
    autoSyncFolder: "Archive",
    autoSyncFull: false,
    autoSyncLimitPerFolder: 100,
    idleWatchEnabled: true,
    idleMaxSeconds: 30,
    confirmDestructive: false,
    allowEmptyFolder: false,
    restrictOutboundToSelf: false,
    allowFileDownloadDir: null,
    maxInlineBytes: 40960,
    opDelayMs: 0,
    sendDelaySeconds: 0,
  });
});

test("confirmDestructive: passes when flag is off regardless of confirmed arg", () => {
  const runtime = createRuntime({ confirmDestructive: false });
  assert.doesNotThrow(() => ensureDestructiveConfirmed(runtime, undefined, "send email"));
  assert.doesNotThrow(() => ensureDestructiveConfirmed(runtime, false, "send email"));
  assert.doesNotThrow(() => ensureDestructiveConfirmed(runtime, true, "send email"));
});

test("confirmDestructive: throws when flag is on and confirmed is not true", () => {
  const runtime = createRuntime({ confirmDestructive: true });
  assert.throws(
    () => ensureDestructiveConfirmed(runtime, undefined, "send email to bob@example.com"),
    /Confirmation required/i,
  );
  assert.throws(
    () => ensureDestructiveConfirmed(runtime, false, "delete INBOX::42"),
    /Confirmation required/i,
  );
});

test("confirmDestructive: passes when flag is on and confirmed is true", () => {
  const runtime = createRuntime({ confirmDestructive: true });
  assert.doesNotThrow(() => ensureDestructiveConfirmed(runtime, true, "send email to bob@example.com"));
});

// Found live: update_message_flags/bulk_update_flags/flag_thread set the same
// \Seen/\Flagged/\Deleted state as mark_email_read/star_email/delete_email but
// went straight to ensureMailboxWriteAllowed, skipping both
// PROTONMAIL_ALLOWED_ACTIONS and PROTONMAIL_CONFIRM_DESTRUCTIVE entirely — a
// policy that excluded "delete" from allowedActions, or required
// confirmation, could be bypassed just by setting \Deleted via a flags tool
// instead of calling delete_email.
test("ensureFlagChangeAllowed blocks a disallowed action even when only requested as a raw flag", () => {
  const runtime = createRuntime({ allowedActions: ["mark_read"] });
  assert.doesNotThrow(() => ensureFlagChangeAllowed(runtime, ["\\Seen"], [], undefined));
  assert.throws(
    () => ensureFlagChangeAllowed(runtime, ["\\Flagged"], [], undefined),
    /star.*disabled by the current runtime policy/i,
  );
  assert.throws(
    () => ensureFlagChangeAllowed(runtime, ["\\Deleted"], [], undefined),
    /delete.*disabled by the current runtime policy/i,
  );
  assert.throws(
    () => ensureFlagChangeAllowed(runtime, [], ["\\Seen"], undefined),
    /mark_unread.*disabled by the current runtime policy/i,
  );
});

test("ensureFlagChangeAllowed requires confirmation to set \\Deleted when confirmDestructive is on", () => {
  const runtime = createRuntime({ allowedActions: ["delete"], confirmDestructive: true });
  assert.throws(
    () => ensureFlagChangeAllowed(runtime, ["\\Deleted"], [], undefined),
    /Confirmation required/i,
  );
  assert.doesNotThrow(() => ensureFlagChangeAllowed(runtime, ["\\Deleted"], [], true));
});

test("ensureFlagChangeAllowed clearing \\Deleted (undelete) needs the restore action, not delete", () => {
  const runtime = createRuntime({ allowedActions: ["restore"], confirmDestructive: true });
  assert.doesNotThrow(() => ensureFlagChangeAllowed(runtime, [], ["\\Deleted"], undefined));
});

test("ensureFlagChangeAllowed ignores flags with no named-action equivalent (e.g. \\Answered)", () => {
  const runtime = createRuntime({ allowedActions: [] });
  assert.doesNotThrow(() => ensureFlagChangeAllowed(runtime, ["\\Answered"], [], undefined));
});

test("ensureFlagChangeAllowed still enforces read-only mode", () => {
  const runtime = createRuntime({ readOnly: true, allowedActions: ["mark_read"] });
  assert.throws(() => ensureFlagChangeAllowed(runtime, ["\\Seen"], [], undefined), /read-only mode/i);
});
