import type { EmailAction, ProtonRuntimeConfig } from "../types/index.js";
import { isSelfAddress } from "./helpers.js";

export function sanitizeRuntimeConfig(runtime: ProtonRuntimeConfig): Record<string, unknown> {
  return {
    readOnly: runtime.readOnly,
    allowSend: runtime.allowSend,
    allowRemoteDraftSync: runtime.allowRemoteDraftSync,
    allowedActions: [...runtime.allowedActions],
    startupSync: runtime.startupSync,
    autoSyncFolder: runtime.autoSyncFolder,
    autoSyncFull: runtime.autoSyncFull,
    autoSyncLimitPerFolder: runtime.autoSyncLimitPerFolder,
    idleWatchEnabled: runtime.idleWatchEnabled,
    idleMaxSeconds: runtime.idleMaxSeconds,
    confirmDestructive: runtime.confirmDestructive,
    allowEmptyFolder: runtime.allowEmptyFolder,
    restrictOutboundToSelf: runtime.restrictOutboundToSelf,
    allowFileDownloadDir: runtime.allowFileDownloadDir ?? null,
    maxInlineBytes: runtime.maxInlineBytes,
    opDelayMs: runtime.opDelayMs,
    sendDelaySeconds: runtime.sendDelaySeconds,
  };
}

export function ensureSendAllowed(runtime: ProtonRuntimeConfig): void {
  if (!runtime.allowSend || runtime.readOnly) {
    throw new Error("Send operations are disabled by the current runtime policy.");
  }
}

export function ensureEmailActionAllowed(
  runtime: ProtonRuntimeConfig,
  action: EmailAction,
): void {
  ensureMailboxWriteAllowed(runtime);

  if (!runtime.allowedActions.includes(action)) {
    throw new Error(`Mailbox action ${action} is disabled by the current runtime policy.`);
  }
}

export function resolveRemoteDraftSync(
  runtime: ProtonRuntimeConfig,
  requested: boolean,
): {
  enabled: boolean;
  reason?: string;
} {
  if (!requested) {
    return { enabled: false };
  }

  if (runtime.readOnly) {
    return {
      enabled: false,
      reason: "Remote draft sync is disabled because the server is running in read-only mode.",
    };
  }

  if (!runtime.allowRemoteDraftSync) {
    return {
      enabled: false,
      reason: "Remote draft sync is disabled by the current runtime policy.",
    };
  }

  return { enabled: true };
}

export function ensureRemoteDraftSyncAllowed(runtime: ProtonRuntimeConfig): void {
  const decision = resolveRemoteDraftSync(runtime, true);
  if (!decision.enabled) {
    throw new Error(decision.reason || "Remote draft sync is disabled by the current runtime policy.");
  }
}

export function ensureMailboxWriteAllowed(runtime: ProtonRuntimeConfig): void {
  if (runtime.readOnly) {
    throw new Error("Mailbox write operations are disabled because the server is running in read-only mode.");
  }
}

// Shared by every outbound-send path (send_email, reply/reply-all/forward,
// send_draft, schedule_draft, unsubscribe_sender, send_test_email, and the
// delivery queue's fire-time re-check) so RESTRICT_OUTBOUND_TO_SELF can't be
// bypassed by adding a new send path and forgetting the inline check.
export function ensureOutboundRecipientsAllowed(
  runtime: ProtonRuntimeConfig,
  selfAddress: string,
  recipients: string[],
): void {
  if (!runtime.restrictOutboundToSelf) return;
  // isSelfAddress normalizes Proton's "+tag" plus-addressing, so a send to
  // the user's own "you+tag@..." alias isn't wrongly treated as external.
  const external = recipients.filter((r) => !isSelfAddress(r, selfAddress));
  if (external.length > 0) {
    throw new Error(`RESTRICT_OUTBOUND_TO_SELF is enabled. Cannot send to: ${external.join(", ")}`);
  }
}

// update_message_flags/bulk_update_flags/flag_thread mutate the same
// \Seen/\Flagged/\Deleted state as mark_email_read/star_email/delete_email,
// but as raw IMAP flags rather than a named action — so, unlike those named
// tools, they never passed through ensureEmailActionAllowed or
// ensureDestructiveConfirmed. That let PROTONMAIL_ALLOWED_ACTIONS (e.g.
// excluding "delete") and PROTONMAIL_CONFIRM_DESTRUCTIVE be bypassed simply
// by setting the equivalent flag instead of calling the named tool. Every
// flag-mutating tool must call this before touching the mailbox.
export function ensureFlagChangeAllowed(
  runtime: ProtonRuntimeConfig,
  flagsToAdd: string[],
  flagsToRemove: string[],
  confirmed: boolean | undefined,
): void {
  ensureMailboxWriteAllowed(runtime);
  const adding: Record<string, EmailAction> = {
    "\\seen": "mark_read",
    "\\flagged": "star",
    "\\deleted": "delete",
  };
  const removing: Record<string, EmailAction> = {
    "\\seen": "mark_unread",
    "\\flagged": "unstar",
    "\\deleted": "restore",
  };
  for (const [flags, map] of [[flagsToAdd, adding], [flagsToRemove, removing]] as const) {
    for (const flag of flags) {
      const action = map[flag.toLowerCase()];
      if (!action) continue;
      ensureEmailActionAllowed(runtime, action);
      if (action === "delete") {
        ensureDestructiveConfirmed(runtime, confirmed, "Mark message(s) \\Deleted");
      }
    }
  }
}

export function ensureDestructiveConfirmed(
  runtime: ProtonRuntimeConfig,
  confirmed: boolean | undefined,
  description: string,
): void {
  if (!runtime.confirmDestructive) return;
  if (confirmed === true) return;
  throw new Error(
    `Confirmation required: ${description}\n\nThis action is irreversible. Call this tool again with confirmed: true after asking the user to confirm.`,
  );
}
