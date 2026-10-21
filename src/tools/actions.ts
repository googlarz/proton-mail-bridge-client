// What the mailbox-changing tools do once they have an account and an id: run one action or a batch, preview it, check the sent copy, move guard, and keep a draft in step with the Drafts folder.

import { LocalIndexService } from "../services/local-index-service.js";
import { buildEmailResourceUri } from "./resources.js";
import { parseEmailId, isOutgoingMessage } from "../utils/helpers.js";
import { logger } from "../utils/logger.js";
import { SimpleIMAPService, BULK_ITEM_TIMEOUT_MS } from "../services/simple-imap-service.js";
import { SMTPService } from "../services/smtp-service.js";
import { DraftStoreService, draftSyncFingerprint } from "../services/draft-store-service.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ensureEmailActionAllowed } from "../utils/runtime-policy.js";
import { type ProtonRuntimeConfig, type DraftRecord, type EmailAction, type CitationSource, type BatchActionEntry, type BatchActionResult } from "../types/index.js";
// Moving a message into the Trash folder is trashing it: trash_email is literally a move there. The move tools
// therefore need the "trash" permission as well as "move" when the destination is the Trash folder, or an
// ALLOWED_ACTIONS list that leaves out "trash" could be sidestepped by moving to Trash instead.
export async function ensureMoveTargetAllowed(
  runtime: ProtonRuntimeConfig,
  imap: { isTrashFolder(path: string): Promise<boolean | undefined> } | Array<{ isTrashFolder(path: string): Promise<boolean | undefined> }>,
  targetFolder: string | undefined,
): Promise<void> {
  if (!targetFolder) return;
  // A call that can span accounts is checked against every account's own Trash folder: their names may differ.
  let unknown = false;
  for (const candidate of Array.isArray(imap) ? imap : [imap]) {
    const isTrash = await candidate.isTrashFolder(targetFolder);
    if (isTrash) {
      ensureEmailActionAllowed(runtime, "trash");
      return;
    }
    if (isTrash === undefined) unknown = true;
  }
  // Not being able to tell must not open a way round the permission: with "trash" not allowed, refuse.
  if (unknown && !runtime.allowedActions.includes("trash")) {
    throw new McpError(
      ErrorCode.InternalError,
      `Cannot tell whether ${targetFolder} is the Trash folder (the folder list could not be read), and the trash action is not allowed. Try again when Bridge answers.`,
    );
  }
}

// Syncs run one at a time per draft, and re-read the draft once they hold the lock: a
// sync that queued behind another sees the remoteDraft the first one recorded (so it
// updates that copy instead of APPENDing a second) and uploads the latest content.
export async function syncDraftToRemote(
  draftStore: DraftStoreService,
  smtpService: SMTPService,
  imapService: SimpleIMAPService,
  draft: DraftRecord,
): Promise<{
  draft: DraftRecord;
  remoteSync: { ok: boolean; emailId?: string; message?: string };
}> {
  try {
    return await draftStore.withDraftSyncLock(draft.id, async () =>
      syncDraftToRemoteLocked(draftStore, smtpService, imapService, await draftStore.getDraft(draft.id).catch(() => draft)),
    );
  } catch (error) {
    // Only reachable when the sync lock itself could not be taken — the upload's own
    // failures are handled (and recorded) inside syncDraftToRemoteLocked.
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Draft remote sync could not start", "MCPServer", { draftId: draft.id, error });
    return { draft: await draftStore.markRemoteSyncError(draft.id, message), remoteSync: { ok: false, message } };
  }
}

export async function syncDraftToRemoteLocked(
  draftStore: DraftStoreService,
  smtpService: SMTPService,
  imapService: SimpleIMAPService,
  draft: DraftRecord,
): Promise<{
  draft: DraftRecord;
  remoteSync: { ok: boolean; emailId?: string; message?: string };
}> {
  try {
    const raw = await smtpService.buildRawMessage({
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      body: draft.body,
      isHtml: draft.isHtml,
      priority: draft.priority,
      replyTo: draft.replyTo,
      // Found live (external review): this never passed draft.from, so a draft
      // saved under an alias (e.g. alias@example.com) previewed in the remote
      // Drafts mailbox under the primary address instead — the remote preview
      // and the eventual send_draft/schedule_draft sender didn't match.
      from: draft.from,
      inReplyTo: draft.inReplyTo,
      references: draft.references,
      messageId: draft.draftMessageId,
      attachments: draft.attachments,
      // Same reasoning as send_draft's identical appendSignature: false — draft
      // content is already finalized and reviewed by the time it's synced here.
      // Found live (external review): this used to omit appendSignature, so the
      // remote preview auto-added PROTONMAIL_SIGNATURE while send_draft/
      // schedule_draft never did — the actually-sent message either lacked the
      // signature the remote preview showed, or, if the caller had also typed a
      // signature into the draft body themselves, got it appended a second time
      // on every remote sync.
      appendSignature: false,
    }, /* preserveBcc */ true);

    const remoteDraft = await imapService.upsertRemoteDraft({
      raw,
      messageId: draft.draftMessageId,
      existingEmailId: draft.remoteDraft?.emailId,
    });

    return {
      draft: await draftStore.markRemoteSynced(draft.id, remoteDraft, draftSyncFingerprint(draft)),
      remoteSync: {
        ok: true,
        emailId: remoteDraft.emailId,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Draft remote sync failed", "MCPServer", { draftId: draft.id, error });
    return {
      draft: await draftStore.markRemoteSyncError(draft.id, message),
      remoteSync: {
        ok: false,
        message,
      },
    };
  }
}

export async function clearRemoteDraft(
  draftStore: DraftStoreService,
  imapService: SimpleIMAPService,
  draft: DraftRecord,
): Promise<{
  draft: DraftRecord;
  remoteDelete?: { ok: boolean; message?: string };
}> {
  if (!draft.remoteDraft?.emailId) {
    return {
      draft,
    };
  }

  try {
    await imapService.deleteRemoteDraft(draft.remoteDraft.emailId);
    return {
      draft: await draftStore.clearRemoteSync(draft.id),
      remoteDelete: {
        ok: true,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Remote draft cleanup failed", "MCPServer", { draftId: draft.id, error });
    return {
      draft,
      remoteDelete: {
        ok: false,
        message,
      },
    };
  }
}

export async function runEmailAction(
  imapService: SimpleIMAPService,
  emailId: string,
  action: EmailAction,
  targetFolder?: string,
): Promise<unknown> {
  // undefined for an old-format id (no embedded UIDVALIDITY) — every method
  // below's own assertMailboxUidValidity guard already treats that as
  // "unverifiable, don't block on it", same as every direct single-message
  // tool handler.
  const uidValidity = parseEmailId(emailId).uidValidity;
  switch (action) {
    case "mark_read":
      return imapService.markEmailRead(emailId, true, uidValidity);
    case "mark_unread":
      return imapService.markEmailRead(emailId, false, uidValidity);
    case "star":
      return imapService.starEmail(emailId, true, uidValidity);
    case "unstar":
      return imapService.starEmail(emailId, false, uidValidity);
    case "archive":
      return imapService.archiveEmail(emailId, uidValidity);
    case "trash":
      return imapService.trashEmail(emailId, uidValidity);
    case "restore":
      return imapService.restoreEmail(emailId, targetFolder, uidValidity);
    case "move":
      if (!targetFolder) throw new McpError(ErrorCode.InvalidParams, "targetFolder is required for action 'move'.");
      return imapService.moveEmail(emailId, targetFolder, uidValidity);
    case "delete":
      return imapService.deleteEmail(emailId, uidValidity);
  }
}

export function emailSourceFromActionResult(result: unknown): CitationSource[] {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return [];
  }

  const candidateKeys = ["targetEmailId", "emailId"] as const;
  const emailIds = new Set<string>();

  for (const key of candidateKeys) {
    const value = (result as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) {
      emailIds.add(value.trim());
    }
  }

  return [...emailIds].map((emailId) => ({
    uri: buildEmailResourceUri(emailId),
    name: emailId,
    title: `Email ${emailId}`,
    mimeType: "message/rfc822",
  }));
}

export async function applyBatchEmailAction(
  imapService: SimpleIMAPService,
  entries: BatchActionEntry[],
  input: {
    emailIds: string[];
    action: EmailAction;
    targetFolder?: string;
    continueOnError: boolean;
    dryRun?: boolean;
  },
): Promise<BatchActionResult> {
  for (const emailId of input.emailIds) {
    try {
      // Unlike SimpleIMAPService's own bulk*/thread* loops, this one had no
      // per-item bound — a single wedged IMAP call (same shared connection,
      // same churn from the perpetual IDLE watcher) hung the *entire*
      // tools/call response forever, with no timeout to degrade it to a
      // per-item failure. Reused verbatim rather than duplicated, since it
      // also forces the same reconnect-on-timeout SimpleIMAPService's other
      // callers rely on to keep the item after it from wedging too.
      const action = input.dryRun
        ? previewEmailAction(imapService, emailId, input.action, input.targetFolder)
        : runEmailAction(imapService, emailId, input.action, input.targetFolder);
      const result = await imapService.withTimeout(
        action,
        BULK_ITEM_TIMEOUT_MS,
        `Timed out after ${BULK_ITEM_TIMEOUT_MS}ms running ${input.action} on ${emailId}`,
      );
      entries.push({
        emailId,
        ok: true,
        action: input.action,
        result,
      });
    } catch (error) {
      entries.push({
        emailId,
        ok: false,
        action: input.action,
        error: error instanceof Error ? error.message : String(error),
      });

      if (!input.continueOnError) {
        break;
      }
    }
  }

  const succeeded = entries.filter((entry) => entry.ok).length;
  const notAttempted = input.emailIds.slice(entries.length);
  return {
    action: input.action,
    total: input.emailIds.length,
    succeeded,
    failed: entries.length - succeeded,
    results: entries,
    ...(notAttempted.length > 0 ? { notAttempted } : {}),
  };
}

export async function previewEmailAction(
  imapService: SimpleIMAPService,
  emailId: string,
  action: EmailAction,
  targetFolder?: string,
): Promise<Record<string, unknown>> {
  const detail = await imapService.getEmailById(emailId);
  const target =
    action === "archive"
      ? "Archive"
      : action === "trash"
        ? "Trash"
        : action === "restore"
          ? targetFolder || "INBOX"
          : action === "move"
            ? targetFolder || detail.folder
            : action === "delete"
              ? "(expunged)"
              : detail.folder;

  return {
    emailId,
    previewOnly: true,
    action,
    currentFolder: detail.folder,
    targetFolder: target,
    subject: detail.subject,
    from: detail.from,
    date: detail.internalDate || detail.date,
    hasAttachments: detail.hasAttachments,
    isRead: detail.isRead,
    isStarred: detail.isStarred,
  };
}

// Best-effort: confirms the sent copy landed in the Sent folder, purely for
// the sentCopy:"[sent-copy:verified]" hint in the response. sentCopyVerify
// already does its own robust folder resolution internally (by specialUse,
// then by name) on every call — retrying it with different guessed folder
// names here was redundant and, worse, sequential (up to 3 x 30s = 90s),
// which blocked the send_email response long enough to trip the MCP
// client's own request timeout on an email that had already sent
// successfully. One bounded call; failing to verify quickly just means the
// hint stays "unverified", never a false failure.
export async function verifySentCopy(
  imapService: SimpleIMAPService,
  messageId: string,
): Promise<{ found: boolean; uid?: number }> {
  return imapService.sentCopyVerify(messageId, "Sent", 8_000);
}

export function pickReplyTargetFromThread(
  thread: Awaited<ReturnType<LocalIndexService["getThreadById"]>>,
  ownerEmail: string,
  preferLatestInbound: boolean,
) {
  const messages = [...thread.messages];
  if (preferLatestInbound) {
    const inbound = [...messages]
      .reverse()
      .find((message) => !isOutgoingMessage(message, ownerEmail));
    if (inbound) {
      return inbound;
    }
  }

  return messages[messages.length - 1];
}

export function buildThreadBrief(
  thread: Awaited<ReturnType<LocalIndexService["getThreadById"]>>,
  ownerEmail: string,
): Record<string, unknown> {
  const messages = [...thread.messages];
  const latestMessage = messages[messages.length - 1];
  const latestInbound = [...messages]
    .reverse()
    .find((message) => !isOutgoingMessage(message, ownerEmail));
  const latestOutbound = [...messages]
    .reverse()
    .find((message) => isOutgoingMessage(message, ownerEmail));
  const pendingOn = latestMessage
    ? isOutgoingMessage(latestMessage, ownerEmail)
      ? "them"
      : "you"
    : "unknown";

  return {
    threadId: thread.id,
    subject: thread.subject,
    messageCount: thread.messageCount,
    unreadCount: thread.unreadCount,
    latestDate: thread.latestDate,
    normalizedLabels: thread.normalizedLabels,
    participants: thread.participants,
    pendingOn,
    likelyNextAction: pendingOn === "you" ? "reply" : pendingOn === "them" ? "wait_or_follow_up" : "review",
    latestInbound: latestInbound
      ? {
          emailId: latestInbound.primaryEmailId,
          from: latestInbound.from,
          date: latestInbound.internalDate || latestInbound.date,
          preview: latestInbound.preview,
        }
      : undefined,
    latestOutbound: latestOutbound
      ? {
          emailId: latestOutbound.primaryEmailId,
          to: latestOutbound.to,
          date: latestOutbound.internalDate || latestOutbound.date,
          preview: latestOutbound.preview,
        }
      : undefined,
    attachments: messages.flatMap((message) =>
      message.attachments.map((attachment) => ({
        emailId: message.primaryEmailId,
        filename: attachment.filename,
        kind: attachment.kind,
        contentType: attachment.contentType,
      })),
    ),
  };
}

export function isMissingTargetFolderError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /TRYCREATE|NONEXISTENT/i.test(message);
}
