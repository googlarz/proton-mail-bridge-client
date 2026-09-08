import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureDestructiveConfirmed,
  ensureOutboundRecipientsAllowed,
  ensureSendAllowed,
} from "../dist/utils/runtime-policy.js";

// Mirrors the exact guard order in index.ts's `case "send_test_email"` handler
// after the P1 fix: ensureDestructiveConfirmed -> ensureSendAllowed ->
// ensureOutboundRecipientsAllowed -> SMTP. Exercised directly against the
// same runtime-policy functions the handler calls, since this repo has no
// MCP-dispatch-level test harness (confirmed: no test imports createServer or
// invokes tool `case` handlers directly — coverage lives at this layer).
function createRuntime(overrides = {}) {
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
    ...overrides,
  };
}

function sendTestEmailHandler(runtime, selfAddress, to, confirmed, sendTestEmail) {
  ensureDestructiveConfirmed(runtime, confirmed, `Send test email to ${to}`);
  ensureSendAllowed(runtime);
  ensureOutboundRecipientsAllowed(runtime, selfAddress, [to]);
  return sendTestEmail(to);
}

test("send_test_email: external recipient with no confirmed throws before SMTP when confirmDestructive+restrictOutboundToSelf are on", () => {
  const runtime = createRuntime({ confirmDestructive: true, restrictOutboundToSelf: true });
  let smtpCalls = 0;
  const sendTestEmail = () => {
    smtpCalls += 1;
    return { messageId: "<x@example.com>", accepted: [], rejected: [] };
  };

  assert.throws(
    () => sendTestEmailHandler(runtime, "owner@example.com", "external@evil.example", undefined, sendTestEmail),
    /Confirmation required/i,
  );
  assert.equal(smtpCalls, 0, "SMTP must not be reached when confirmation is missing");
});

test("send_test_email: confirmed:true still throws for an external recipient when restrictOutboundToSelf is on", () => {
  const runtime = createRuntime({ confirmDestructive: true, restrictOutboundToSelf: true });
  let smtpCalls = 0;
  const sendTestEmail = () => {
    smtpCalls += 1;
    return { messageId: "<x@example.com>", accepted: [], rejected: [] };
  };

  assert.throws(
    () => sendTestEmailHandler(runtime, "owner@example.com", "external@evil.example", true, sendTestEmail),
    /RESTRICT_OUTBOUND_TO_SELF/i,
  );
  assert.equal(smtpCalls, 0, "SMTP must not be reached when the recipient is not self");
});

test("send_test_email: confirmed:true to self succeeds under both guards", () => {
  const runtime = createRuntime({ confirmDestructive: true, restrictOutboundToSelf: true });
  let smtpCalls = 0;
  const sendTestEmail = () => {
    smtpCalls += 1;
    return { messageId: "<x@example.com>", accepted: ["owner@example.com"], rejected: [] };
  };

  const result = sendTestEmailHandler(runtime, "owner@example.com", "owner@example.com", true, sendTestEmail);
  assert.equal(smtpCalls, 1);
  assert.equal(result.messageId, "<x@example.com>");
});
