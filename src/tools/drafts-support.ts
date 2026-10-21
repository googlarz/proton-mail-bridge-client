// Draft and attachment helpers a handler needs: what a listing hides, what counts as no change, and writing an attachment under the download directory.

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { isPathInside } from "../utils/helpers.js";
import { type DraftRecord, type SendEmailInput } from "../types/index.js";
// list_drafts has no filter and returns every draft unconditionally — unlike get_draft/create_draft,
// which each touch exactly one draft the caller already knows the content of. DraftRecord.attachments
// carries full base64 `content`, and createTextResult() serializes the whole payload TWICE (once into
// content[0].text, again into structuredContent). A single draft with a few-MB attachment already
// roughly doubles in response size; list_drafts sums every draft's attachments into one response with
// no cap, so one large attachment on any draft makes list_drafts exceed the MCP stdio client's read
// buffer on every call — including the very next session's startup listing — permanently bricking the
// tool until that draft is deleted out-of-band. Redact attachment content here the same way emails
// already do (EmailAttachmentSummary carries no content; see get_attachment_content for the real bytes).
// No explicit return-type annotation: the `size` field isn't part of EmailAttachmentInput, and this
// value is only ever handed to createTextResult() (which takes `unknown`), so nothing needs the exact
// DraftRecord shape here.
export function redactDraftAttachmentsForListing(draft: DraftRecord) {
  return {
    ...draft,
    attachments: draft.attachments.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      cid: attachment.cid,
      contentDisposition: attachment.contentDisposition,
      content: "",
      size: Buffer.byteLength(attachment.content, "base64"),
    })),
  };
}

// How much of a draft's body survives into a mutation/listing response before
// it's truncated — long enough to recognize the draft at a glance, short
// enough that a large body (a long thread quoted into a reply, a big pasted
// table) doesn't dominate the response the way redactDraftAttachmentsForListing
// already stops a base64 attachment from doing.
export const DRAFT_BODY_PREVIEW_LENGTH = 500;

// Found live (external review, repeated across three rounds): create_draft,
// update_draft, create_reply_draft, create_forward_draft,
// create_thread_reply_draft, sync_draft_to_remote, and list_drafts all echoed
// the draft's COMPLETE body back — confirmed live at ~40k tokens for a single
// update_draft call that only changed the subject of a ~202 KB draft, and
// ~261k tokens for list_drafts with 107 drafts. The caller supplied the body
// itself (create/update) or already has it from a prior call (list) — same
// "caller already knows what it sent" reasoning as attachment redaction, just
// for the text body instead of base64. get_draft deliberately keeps the full
// body — it's the "let me look at this one draft" call, not a repeated-edit
// or bulk-listing one.
// True when applying `patch` would leave the draft exactly as it is — used to skip
// the store write and the remote (IMAP) resync for an update that changes nothing.
export function isNoopDraftPatch(existing: DraftRecord, patch: Record<string, unknown>): boolean {
  return Object.entries(patch).every(([key, value]) => {
    if (value === undefined) {
      return true;
    }
    const current = (existing as unknown as Record<string, unknown>)[key];
    return JSON.stringify(current ?? (typeof value === "string" ? "" : undefined)) === JSON.stringify(value);
  });
}

export function truncateDraftBodyForResponse<T extends { body: string }>(draft: T) {
  if (draft.body.length <= DRAFT_BODY_PREVIEW_LENGTH) {
    return draft;
  }
  return {
    ...draft,
    body: `${draft.body.slice(0, DRAFT_BODY_PREVIEW_LENGTH)}…`,
    bodyLength: draft.body.length,
    bodyTruncated: true,
  };
}

// Same fix as redactDraftAttachmentsForListing, for list_scheduled_sends — a
// queued send's payload carries the same full base64 EmailAttachmentInput
// content (found live: ~955k tokens for a single 1 MiB attachment on ONE
// record, canceled records included, and list_scheduled_sends has no filter
// or cap any more than list_drafts did). No explicit return-type annotation
// for the same reason as the function above.
export function redactQueueRecordAttachments<T extends { payload: SendEmailInput }>(record: T) {
  const attachments = record.payload.attachments;
  const body = record.payload.body;
  const bodyTooLong = typeof body === "string" && body.length > DRAFT_BODY_PREVIEW_LENGTH;
  // send_email(markdownBody) also stores the full rendered HTML in payload.htmlBody —
  // a parallel copy of the whole message that the body preview alone doesn't cover.
  const hasHtmlBody = typeof record.payload.htmlBody === "string" && record.payload.htmlBody.length > 0;
  if ((!attachments || attachments.length === 0) && !bodyTooLong && !hasHtmlBody) {
    return record;
  }
  return {
    ...record,
    payload: {
      ...record.payload,
      ...(bodyTooLong ? truncateDraftBodyForResponse({ body }) : {}),
      ...(hasHtmlBody ? { htmlBody: undefined, htmlBodyOmitted: true } : {}),
      ...(attachments && attachments.length > 0
        ? {
            attachments: attachments.map((attachment) => ({
              filename: attachment.filename,
              contentType: attachment.contentType,
              cid: attachment.cid,
              contentDisposition: attachment.contentDisposition,
              content: "",
              size: Buffer.byteLength(attachment.content, "base64"),
            })),
          }
        : {}),
    },
  };
}

// Writes attachment bytes to <downloadDir>/<saveTo>, refusing any path that escapes the
// download dir (lexically or through a symlink). The containment check canonicalizes
// BOTH sides — comparing a canonical target with a merely-resolved allowed dir rejected
// every save when the allowed dir is or sits under a symlink (macOS /var/folders is
// really /private/var/folders). Attachments are private mail content, so directories
// created here are owner-only (0700) and the file is 0600, existing files included.
export async function writeAttachmentToDownloadDir(downloadDir: string, saveTo: string, data: Buffer): Promise<string> {
  const { resolve: pathResolve, join: pathJoin, dirname, basename, sep } = await import("node:path");
  const { realpathSync, existsSync } = await import("node:fs");
  const { writeFile: wf, mkdir: mkd, chmod: chm } = await import("node:fs/promises");
  const absDir = pathResolve(downloadDir);
  const absTarget = pathJoin(absDir, saveTo);
  // A hardcoded "/" never matched on win32 (path.resolve/join produce
  // backslash-separated paths there), hence `sep`.
  if (!isPathInside(absDir, absTarget, sep)) {
    throw new McpError(ErrorCode.InvalidParams, "saveTo path escapes the allowed directory.");
  }
  // The allowed directory itself may be created. Then check, BEFORE creating anything below it, that the
  // deepest directory that already exists on the way to the target really is inside it: otherwise a
  // symlink in the allowed dir could make mkdir create new directories outside it before the final
  // containment check below refuses the save.
  await mkd(absDir, { recursive: true, mode: 0o700 });
  const realDir = realpathSync(absDir);
  let probe = pathResolve(absTarget, "..");
  while (!existsSync(probe)) probe = dirname(probe);
  let realProbe: string;
  try {
    realProbe = realpathSync(probe);
  } catch {
    throw new McpError(ErrorCode.InvalidParams, "saveTo path escapes the allowed directory.");
  }
  if (!isPathInside(realDir, realProbe, sep)) {
    throw new McpError(ErrorCode.InvalidParams, "saveTo path escapes the allowed directory.");
  }
  await mkd(pathResolve(absTarget, ".."), { recursive: true, mode: 0o700 });
  let realTarget: string;
  try {
    realTarget = realpathSync(absTarget);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
      realTarget = realpathSync(dirname(absTarget)) + sep + basename(absTarget);
    } else {
      throw error;
    }
  }
  if (!isPathInside(realDir, realTarget, sep)) {
    throw new McpError(ErrorCode.InvalidParams, "saveTo path escapes the allowed directory.");
  }
  await wf(absTarget, data, { mode: 0o600 });
  // writeFile's mode only applies to a newly created file; tighten an existing one too.
  await chm(absTarget, 0o600);
  return absTarget;
}
