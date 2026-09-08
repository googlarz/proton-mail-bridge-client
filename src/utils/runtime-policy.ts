import type { EmailAction, ProtonRuntimeConfig } from "../types/index.js";
import { isSelfAddress, normalizeBoolean } from "./helpers.js";

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
// unsubscribe_sender, and the delivery queue's fire-time re-check) so
// RESTRICT_OUTBOUND_TO_SELF can't be bypassed by adding a new send path and
// forgetting the inline check.
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

// All alternate tool routes pass through this boundary before doing any I/O.
// Individual handlers may impose additional restrictions (send, remote drafts).
const TOOL_ACTIONS: Partial<Record<string, EmailAction>> = {
  move_email: "move", bulk_move: "move", move_thread: "move",
  archive_email: "archive", trash_email: "trash", restore_email: "restore",
  snooze_email: "archive", cancel_snooze: "archive",
  delete_email: "delete", empty_folder: "delete",
  delete_folder: "delete", delete_label: "delete",
};

export function ensureToolActionAllowed(
  runtime: ProtonRuntimeConfig,
  tool: string,
  args: Record<string, unknown>,
): void {
  const actions = new Set<EmailAction>();
  const fixed = TOOL_ACTIONS[tool];
  if (fixed) actions.add(fixed);
  if (tool === "batch_email_action" || tool === "apply_thread_action") {
    const action = String(args.action) as EmailAction;
    if (!["mark_read", "mark_unread", "star", "unstar", "archive", "trash", "restore", "move", "delete"].includes(action)) {
      throw new Error("Unsupported email action.");
    }
    actions.add(action);
  }
  if (tool === "bulk_delete" || tool === "delete_thread") {
    actions.add(normalizeBoolean(args.permanent, false) ? "delete" : "trash");
  }
  if (tool === "mark_email_read") actions.add(!normalizeBoolean(args.isRead, true) ? "mark_unread" : "mark_read");
  if (tool === "star_email") actions.add(!normalizeBoolean(args.isStarred, true) ? "unstar" : "star");
  if (["update_message_flags", "bulk_update_flags", "flag_thread", "import_email"].includes(tool)) {
    ensureMailboxWriteAllowed(runtime);
    const mapping: Record<string, [EmailAction, EmailAction]> = {
      "\\seen": ["mark_read", "mark_unread"],
      "\\flagged": ["star", "unstar"],
      "\\deleted": ["delete", "restore"],
    };
    for (const [key, removing] of [[tool === "import_email" ? "flags" : "flagsToAdd", false], ["flagsToRemove", true]] as const) {
      for (const flag of Array.isArray(args[key]) ? args[key] as unknown[] : []) {
        const pair = mapping[String(flag).toLowerCase()];
        if (pair) actions.add(pair[removing ? 1 : 0]);
      }
    }
  }
  for (const action of actions) ensureEmailActionAllowed(runtime, action);
  const supportsDryRun = ["batch_email_action", "apply_thread_action", "bulk_delete", "delete_thread", "bulk_update_flags", "flag_thread"].includes(tool);
  if (actions.has("delete") && !(supportsDryRun && normalizeBoolean(args.dryRun, false))) {
    ensureDestructiveConfirmed(runtime, normalizeBoolean(args.confirmed, false), `Permanently delete via ${tool}`);
  }
}
