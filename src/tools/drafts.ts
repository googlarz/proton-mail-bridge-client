import { logger } from "../utils/logger.js";
import { maybeRefreshLocalIndex } from "./index-refresh.js";
import { applyBodyEdits } from "../services/draft-store-service.js";
import { getReplyRecipients, uniqueAddresses, prefixedSubject, buildReplyHtml, buildReplyText, replyReferences, buildForwardHtml, buildForwardText } from "./compose.js";
import { draftSource, emailSource, threadSource } from "./resources.js";
import { truncateDraftBodyForResponse, redactDraftAttachmentsForListing, isNoopDraftPatch } from "./drafts-support.js";
import { createTextResult } from "./results.js";
import { syncDraftToRemote, clearRemoteDraft, pickReplyTargetFromThread, verifySentCopy } from "./actions.js";
import { withAudit, sanitizeAuditValue } from "./audit.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { optionalAddressList, optionalAttachmentList, optionalClearableString, optionalString, parseBodyEdits, requireAddressList, requireString } from "./args.js";
import { parseEmails, ensureValidEmails, isValidEmail, normalizeBoolean, normalizeLimit, withAccountPrefix, projectFields, optionalBoolean } from "../utils/helpers.js";
import { ensureMailboxWriteAllowed, resolveRemoteDraftSync, ensureRemoteDraftSyncAllowed, ensureDestructiveConfirmed, ensureSendAllowed, ensureOutboundRecipientsAllowed } from "../utils/runtime-policy.js";
import type { ToolContext } from "./context.js";
import type { ToolResult } from "./results.js";
import { sendOutcomeIsUnknown } from "../services/smtp-service.js";

// Drafts: create (new, reply, forward, thread reply), list, read, edit, sync to the Drafts folder, send and schedule.

export async function handleDraftTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { config, accountManager, primaryBundle, smtpService, auditService, draftStore, resolveAccountArg, selectedBundles, allAccountAddresses, resolveAccountForEmailId, resolveAccountForDraftId, responseSlug, presentDraft } = ctx;
  switch (name) {
    case "create_draft": {
      // Local draft write — was only gated on the remote-sync side, so
      // PROTONMAIL_READ_ONLY never actually stopped a local draft being created.
      ensureMailboxWriteAllowed(config.runtime);
      const to = parseEmails(optionalAddressList(args, "to"));
      const cc = parseEmails(optionalAddressList(args, "cc"));
      const bcc = parseEmails(optionalAddressList(args, "bcc"));
      const subject = requireString(args, "subject");
      const body = requireString(args, "body");
      const replyTo = optionalString(args, "replyTo");
      const from = optionalString(args, "from");
      const attachments = optionalAttachmentList(args.attachments);
      const priority = optionalString(args, "priority");

      ensureValidEmails(to, "to");
      ensureValidEmails(cc, "cc");
      ensureValidEmails(bcc, "bcc");
      if (replyTo && !isValidEmail(replyTo)) {
        throw new McpError(ErrorCode.InvalidParams, "replyTo must be a valid email address.");
      }
      if (from && !isValidEmail(from)) {
        throw new McpError(ErrorCode.InvalidParams, "from must be a valid email address.");
      }

      // A `from` matching a configured additional account stores the draft in
      // THAT account's own draftStore (own dataDir/drafts.json) instead of the
      // primary's — the draft's id is prefixed with that account's slug in the
      // response so get_draft/update_draft/send_draft/... can find it again.
      const createDraftBundle = from ? accountManager.byAddress(from) ?? primaryBundle : primaryBundle;

      const result = await withAudit(auditService, name, args, async () => {
        const draft = await createDraftBundle.draftStore.createDraft({
          mode: "compose",
          to,
          cc,
          bcc,
          subject,
          body,
          isHtml: normalizeBoolean(args.isHtml, false),
          priority:
            priority === "high" || priority === "low" || priority === "normal"
              ? priority
              : undefined,
          replyTo,
          from,
          notes: optionalString(args, "notes"),
          attachments,
        });

        const remoteSyncDecision = resolveRemoteDraftSync(
          config.runtime,
          normalizeBoolean(args.syncToRemote, true),
        );
        const synced = remoteSyncDecision.enabled
          ? await syncDraftToRemote(
              createDraftBundle.draftStore,
              createDraftBundle.smtpService,
              createDraftBundle.imapService,
              draft,
            )
          : { draft, remoteSync: undefined };
        const remoteSync =
          synced.remoteSync ??
          (remoteSyncDecision.reason
            ? {
                ok: false,
                skipped: true,
                message: remoteSyncDecision.reason,
              }
            : undefined);

        return presentDraft(
          createDraftBundle,
          remoteSync ? { ...synced.draft, remoteSync } : synced.draft,
        );
      });

      // Same fix as update_draft's identical bloat — see its comment. The
      // caller already knows what it attached (and what body it just sent);
      // get_draft is the "let me see the full content" call, not this one.
      return createTextResult(
        truncateDraftBodyForResponse(redactDraftAttachmentsForListing(result)),
        false,
        [
          draftSource(result),
          ...(result.remoteDraft?.emailId
            ? [
                emailSource({
                  id: result.remoteDraft.emailId,
                  subject: result.subject,
                  folder: result.remoteDraft.folder,
                })
              ]
            : []),
        ],
      );
    }

    case "create_reply_draft": {
      // Local draft write — same gap as create_draft, see its comment.
      ensureMailboxWriteAllowed(config.runtime);
      // emailId carries the same "<slug>::" account prefix as everywhere else —
      // this previously always read via the PRIMARY account's imapService
      // regardless of that prefix, so replying to a non-primary account's email
      // either resolved the wrong message or threw not-found.
      const { bundle: createReplyReadBundle, rest: createReplyEmailIdRest } = resolveAccountForEmailId(
        requireString(args, "emailId"),
      );
      const detail = await createReplyReadBundle.imapService.getEmailById(createReplyEmailIdRest);
      const body = requireString(args, "body");
      const isHtml = normalizeBoolean(args.isHtml, false);
      const replyAll = normalizeBoolean(args.replyAll, false);
      const attachments = optionalAttachmentList(args.attachments);
      const extraCc = parseEmails(optionalAddressList(args, "cc"));
      const extraBcc = parseEmails(optionalAddressList(args, "bcc"));
      const recipients = getReplyRecipients(detail, createReplyReadBundle.config.smtp.username, replyAll, allAccountAddresses());
      const cc = uniqueAddresses([...recipients.cc, ...extraCc]);
      const to = uniqueAddresses(recipients.to);

      ensureValidEmails(to, "to");
      ensureValidEmails(cc, "cc");
      ensureValidEmails(extraBcc, "bcc");

      if (to.length === 0) {
        throw new McpError(ErrorCode.InvalidParams, "Unable to infer reply recipient.");
      }

      // Same from-based draftStore routing as create_draft — see its comment —
      // except the no-`from` default is the ACCOUNT THE ORIGINAL MESSAGE BELONGS
      // TO, not always the primary: a reply drafted against a non-primary
      // account's email with no explicit `from` should default to replying as
      // that same account, not silently switch to primary. `from` still wins
      // when it names a different configured account.
      const createReplyDraftBundle =
        optionalString(args, "from") !== undefined
          ? accountManager.byAddress(optionalString(args, "from") as string) ?? createReplyReadBundle
          : createReplyReadBundle;

      const result = await withAudit(auditService, name, args, async () => {
        const draft = await createReplyDraftBundle.draftStore.createDraft({
          mode: "reply",
          to,
          cc,
          bcc: extraBcc,
          subject: prefixedSubject(detail.subject, "Re:"),
          // An HTML draft needs an HTML quote: a plain-text "> ..." quote appended to an HTML
          // body collapses its newlines (HTML whitespace) into one run-on blob.
          body: isHtml ? buildReplyHtml(detail, body) : buildReplyText(detail, body),
          isHtml,
          // Found live (external review): a `from` naming a real alias NOT
          // itself a separately-configured account (e.g. a genuine alias
          // reachable only via header override, same as send_email's own
          // fallback) picked the right draftStore bundle above but never
          // actually stored the address on the draft — draft.from came back
          // undefined, so a later send_draft used the account's default
          // sender instead of the alias the caller asked for.
          from: optionalString(args, "from"),
          inReplyTo: detail.messageId,
          references: replyReferences(detail),
          attachments,
          sourceEmailId: detail.id,
          sourceMessageId: detail.messageId,
          notes: optionalString(args, "notes"),
        });

        const remoteSyncDecision = resolveRemoteDraftSync(
          config.runtime,
          normalizeBoolean(args.syncToRemote, true),
        );
        const synced = remoteSyncDecision.enabled
          ? await syncDraftToRemote(
              createReplyDraftBundle.draftStore,
              createReplyDraftBundle.smtpService,
              createReplyDraftBundle.imapService,
              draft,
            )
          : { draft, remoteSync: undefined };
        const remoteSync =
          synced.remoteSync ??
          (remoteSyncDecision.reason
            ? {
                ok: false,
                skipped: true,
                message: remoteSyncDecision.reason,
              }
            : undefined);

        return presentDraft(
          createReplyDraftBundle,
          remoteSync ? { ...synced.draft, remoteSync } : synced.draft,
        );
      });

      // Same fix as create_draft/update_draft's identical bloat — see their comments.
      return createTextResult(
        truncateDraftBodyForResponse(redactDraftAttachmentsForListing(result)),
        false,
        [
          draftSource(result),
          emailSource(detail),
          ...(result.remoteDraft?.emailId
            ? [
                emailSource({
                  id: result.remoteDraft.emailId,
                  subject: result.subject,
                  folder: result.remoteDraft.folder,
                })
              ]
            : []),
        ],
      );
    }

    case "create_forward_draft": {
      // Local draft write — same gap as create_draft, see its comment.
      ensureMailboxWriteAllowed(config.runtime);
      // Same emailId account resolution as create_reply_draft — see its comment.
      const { bundle: createForwardReadBundle, rest: createForwardEmailIdRest } = resolveAccountForEmailId(
        requireString(args, "emailId"),
      );
      const detail = await createForwardReadBundle.imapService.getEmailById(createForwardEmailIdRest);
      const to = parseEmails(requireAddressList(args, "to"));
      const cc = parseEmails(optionalAddressList(args, "cc"));
      const bcc = parseEmails(optionalAddressList(args, "bcc"));
      const callerAttachments = optionalAttachmentList(args.attachments) ?? [];

      ensureValidEmails(to, "to");
      ensureValidEmails(cc, "cc");
      ensureValidEmails(bcc, "bcc");

      // Same bug fixed earlier this session in forward_email: only the
      // caller-supplied `attachments` (new attachments to add) were ever
      // used — the original email's own attachments were never fetched,
      // regardless of the tool's "preserving attachments" description.
      // Found live: forwarding a fixture with one attachment produced a
      // draft with zero attachments.
      const includeAttachments = normalizeBoolean(args.includeAttachments, true);
      const originalAttachments = includeAttachments
        ? await Promise.all(
            detail.attachments
              .filter((a) => a.id)
              .map((a) => createForwardReadBundle.imapService.getAttachmentForForward(detail.id, a.id as string)),
          )
        : [];
      const attachments = [...originalAttachments, ...callerAttachments];

      // Same from-based draftStore routing as create_reply_draft — defaults to
      // the ORIGINAL MESSAGE's own account, not always primary, when `from`
      // isn't given.
      const createForwardDraftBundle =
        optionalString(args, "from") !== undefined
          ? accountManager.byAddress(optionalString(args, "from") as string) ?? createForwardReadBundle
          : createForwardReadBundle;

      const result = await withAudit(auditService, name, args, async () => {
        const draft = await createForwardDraftBundle.draftStore.createDraft({
          mode: "forward",
          to,
          cc,
          bcc,
          subject: prefixedSubject(detail.subject, "Fwd:"),
          body: normalizeBoolean(args.isHtml, false)
            ? buildForwardHtml(detail, optionalString(args, "body"))
            : buildForwardText(detail, optionalString(args, "body")),
          isHtml: normalizeBoolean(args.isHtml, false),
          // Same fix as create_reply_draft — see its comment.
          from: optionalString(args, "from"),
          attachments,
          sourceEmailId: detail.id,
          sourceMessageId: detail.messageId,
          notes: optionalString(args, "notes"),
        });

        const remoteSyncDecision = resolveRemoteDraftSync(
          config.runtime,
          normalizeBoolean(args.syncToRemote, true),
        );
        const synced = remoteSyncDecision.enabled
          ? await syncDraftToRemote(
              createForwardDraftBundle.draftStore,
              createForwardDraftBundle.smtpService,
              createForwardDraftBundle.imapService,
              draft,
            )
          : { draft, remoteSync: undefined };
        const remoteSync =
          synced.remoteSync ??
          (remoteSyncDecision.reason
            ? {
                ok: false,
                skipped: true,
                message: remoteSyncDecision.reason,
              }
            : undefined);

        return presentDraft(
          createForwardDraftBundle,
          remoteSync ? { ...synced.draft, remoteSync } : synced.draft,
        );
      });

      // Same fix as create_draft/update_draft's identical bloat — see their comments.
      return createTextResult(
        truncateDraftBodyForResponse(redactDraftAttachmentsForListing(result)),
        false,
        [
          draftSource(result),
          emailSource(detail),
          ...(result.remoteDraft?.emailId
            ? [
                emailSource({
                  id: result.remoteDraft.emailId,
                  subject: result.subject,
                  folder: result.remoteDraft.folder,
                })
              ]
            : []),
        ],
      );
    }

    case "list_drafts": {
      // Found live (external review): this stayed scoped to the primary
      // account's own drafts only — a draft created via create_draft(from:
      // secondary@example.com) is real and gettable by its prefixed draftId,
      // but never showed up here, so day-to-day draft discovery silently
      // missed every non-primary account's drafts. Now fans out across every
      // configured account, same pattern as list_scheduled_sends/
      // list_snoozed, and re-sorts the merged set by updatedAt (each
      // account's own list already arrives that way). Single-account guard
      // keeps byte-identical output for the common case.
      const includeSent = normalizeBoolean(args.includeSent, false);
      resolveAccountArg(args);
      const allDrafts = accountManager.all().length === 1
        ? (await draftStore.listDrafts(includeSent)).map((draft) => ({ bundle: primaryBundle, draft }))
        : (
            await Promise.all(
              selectedBundles(args).map(async (bundle) => {
                const drafts = await bundle.draftStore.listDrafts(includeSent);
                return drafts.map((draft) => ({ bundle, draft: presentDraft(bundle, draft) }));
              }),
            )
          )
            .flat()
            .sort((left, right) => right.draft.updatedAt.localeCompare(left.draft.updatedAt));
      // Found live (external review): every draft's full body was returned
      // alongside the already-redacted attachments — confirmed live at ~261k
      // tokens for 107 drafts. Bodies are now truncated the same way a
      // mutation response's body is (see truncateDraftBodyForResponse). limit/
      // offset are optional and additive — omitting them still returns every
      // draft (just with truncated bodies/attachments), so this doesn't change
      // behavior for a caller not using the new params.
      const offset = normalizeLimit(args.offset, 0, 0, 10_000);
      const limit = normalizeLimit(args.limit, 20, 1, 10_000);
      const page = allDrafts.slice(offset, offset + limit);
      return createTextResult(
        {
          total: allDrafts.length,
          offset,
          returned: page.length,
          hasMore: offset + page.length < allDrafts.length,
          drafts: page.map(({ draft }) => truncateDraftBodyForResponse(redactDraftAttachmentsForListing(draft))),
        },
        false,
        page.map(({ draft }) => draftSource(draft)),
      );
    }

    case "list_remote_drafts": {
      // Scope limitation (follow-up round): stays scoped to the primary account's
      // remote Drafts mailbox only — see list_drafts' identical note.
      // `account` picks another account's Drafts mailbox; its ids carry that account's prefix like everywhere else.
      const draftsBundle = resolveAccountArg(args) ?? primaryBundle;
      const draftsSlug = responseSlug(draftsBundle);
      const rawResult = await draftsBundle.imapService.listRemoteDrafts(
        normalizeLimit(args.limit, 50),
        normalizeLimit(args.offset, 0, 0, 10_000),
      );
      const result = { ...rawResult, emails: rawResult.emails.map((email) => ({ ...email, id: withAccountPrefix(draftsSlug, email.id) })) };
      // projectFields (called with no fields arg) still trims each email's
      // attachments to the essentials — same fix as every other list-style
      // tool, this one just didn't route through projectFields at all before.
      return createTextResult({ ...result, emails: projectFields(result.emails) }, false, result.emails.map(emailSource));
    }

    case "get_draft": {
      const { bundle: getDraftBundle, rest: getDraftIdRest } = resolveAccountForDraftId(
        requireString(args, "draftId"),
      );
      const draft = presentDraft(getDraftBundle, await getDraftBundle.draftStore.getDraft(getDraftIdRest));
      // Found live (external review): this always echoed every attachment's
      // full base64 content — ~955k tokens for a single 1 MiB attachment,
      // serialized twice by createTextResult on top of that. Metadata only by
      // default now (same redaction as list_drafts/update_draft/create_draft),
      // with an explicit opt-in for the rare case the caller actually needs
      // the raw bytes back.
      const draftResponse = normalizeBoolean(args.includeAttachmentContent, false)
        ? draft
        : redactDraftAttachmentsForListing(draft);
      return createTextResult(
        draftResponse,
        false,
        [
          draftSource(draft),
          ...(draft.remoteDraft?.emailId
            ? [
                emailSource({
                  id: draft.remoteDraft.emailId,
                  subject: draft.subject,
                  folder: draft.remoteDraft.folder,
                })
              ]
            : []),
        ],
      );
    }

    case "update_draft": {
      // Local draft write — same gap as create_draft, see its comment.
      ensureMailboxWriteAllowed(config.runtime);
      const { bundle: updateDraftBundle, rest: updateDraftIdRest } = resolveAccountForDraftId(
        requireString(args, "draftId"),
      );
      const to = args.to === undefined ? undefined : parseEmails(optionalAddressList(args, "to"));
      const cc = args.cc === undefined ? undefined : parseEmails(optionalAddressList(args, "cc"));
      const bcc = args.bcc === undefined ? undefined : parseEmails(optionalAddressList(args, "bcc"));
      // body/replyTo use optionalClearableString, not optionalString — see its
      // comment — so an explicit body:'' or replyTo:'' actually clears the
      // field instead of being silently treated as "field not provided".
      const body = optionalClearableString(args, "body");
      const bodyEdits = args.bodyEdits === undefined ? undefined : parseBodyEdits(args.bodyEdits);
      if (bodyEdits && body !== undefined) {
        throw new McpError(ErrorCode.InvalidParams, "Pass either body (replace the whole body) or bodyEdits (change fragments), not both.");
      }
      const replyTo = optionalClearableString(args, "replyTo");
      const from = optionalString(args, "from");
      const priority = optionalString(args, "priority");
      const attachments = args.attachments === undefined ? undefined : optionalAttachmentList(args.attachments);

      if (to) {
        ensureValidEmails(to, "to");
      }
      if (cc) {
        ensureValidEmails(cc, "cc");
      }
      if (bcc) {
        ensureValidEmails(bcc, "bcc");
      }
      if (replyTo && !isValidEmail(replyTo)) {
        throw new McpError(ErrorCode.InvalidParams, "replyTo must be a valid email address.");
      }
      if (from && !isValidEmail(from)) {
        throw new McpError(ErrorCode.InvalidParams, "from must be a valid email address.");
      }

      const draftPatch = {
        to,
        cc,
        bcc,
        subject: optionalString(args, "subject"),
        body,
        bodyEdits,
        isHtml: optionalBoolean(args.isHtml),
        priority:
          priority === "high" || priority === "low" || priority === "normal"
            ? priority
            : undefined,
        replyTo,
        from,
        attachments,
        notes: optionalString(args, "notes"),
      } satisfies Parameters<typeof updateDraftBundle.draftStore.updateDraft>[1];

      let bodyEditsApplied: number | undefined;
      const result = await withAudit(auditService, name, args, async () => {
        const existingDraft = await updateDraftBundle.draftStore.getDraft(updateDraftIdRest);
        // For the no-op check only: what the body would become. The store re-applies
        // the edits to the stored body under its own lock, so a concurrent edit of
        // another fragment is never overwritten.
        let notedBody: string | undefined;
        if (bodyEdits) {
          try {
            const preview = applyBodyEdits(existingDraft.body, bodyEdits);
            notedBody = preview.body;
            bodyEditsApplied = preview.replacements;
          } catch (error) {
            throw new McpError(ErrorCode.InvalidParams, error instanceof Error ? error.message : String(error));
          }
        }
        const noop = isNoopDraftPatch(existingDraft, bodyEdits ? { ...draftPatch, bodyEdits: undefined, body: notedBody } : draftPatch);
        // Only skip the resync when the remote copy is known to be current. A
        // draft whose last sync failed (or never ran) must still retry it, even
        // if this particular call changes nothing locally.
        if (noop && existingDraft.remoteSyncState === "synced") {
          return presentDraft(updateDraftBundle, {
            ...existingDraft,
            remoteSync: { ok: true, skipped: true, message: "No changes — draft left as is, remote copy already in sync." },
          });
        }
        const draft = noop ? existingDraft : await updateDraftBundle.draftStore.updateDraft(updateDraftIdRest, draftPatch);

        const remoteSyncDecision = resolveRemoteDraftSync(
          config.runtime,
          normalizeBoolean(args.syncToRemote, true),
        );
        const synced = remoteSyncDecision.enabled
          ? await syncDraftToRemote(
              updateDraftBundle.draftStore,
              updateDraftBundle.smtpService,
              updateDraftBundle.imapService,
              draft,
            )
          : { draft, remoteSync: undefined };
        const remoteSync =
          synced.remoteSync ??
          (remoteSyncDecision.reason
            ? {
                ok: false,
                skipped: true,
                message: remoteSyncDecision.reason,
              }
            : undefined);

        return presentDraft(
          updateDraftBundle,
          remoteSync ? { ...synced.draft, remoteSync } : synced.draft,
        );
      });

      // update_draft is typically called repeatedly against the same draft to tweak
      // subject/body — the attachments usually aren't touched by this call at all, so
      // re-echoing their full base64 `content` (serialized twice by createTextResult,
      // same issue redactDraftAttachmentsForListing already fixed for list_drafts)
      // burns tokens on every single edit for a draft that has any attachment. Same
      // reasoning for the body itself — confirmed live at ~40k tokens for a single
      // subject-only edit of a ~202 KB draft (see truncateDraftBodyForResponse). The
      // caller already knows what it attached and what body it just sent; get_draft
      // remains full-content for the "let me look at this draft" case, which is a
      // single call rather than a loop.
      return createTextResult(
        (bodyEditsApplied === undefined
          ? truncateDraftBodyForResponse(redactDraftAttachmentsForListing(result))
          : { ...truncateDraftBodyForResponse(redactDraftAttachmentsForListing(result)), bodyEditsApplied }),
        false,
        [
          draftSource(result),
          ...(result.remoteDraft?.emailId
            ? [
                emailSource({
                  id: result.remoteDraft.emailId,
                  subject: result.subject,
                  folder: result.remoteDraft.folder,
                })
              ]
            : []),
        ],
      );
    }

    case "sync_draft_to_remote": {
      ensureRemoteDraftSyncAllowed(config.runtime);
      const { bundle: syncDraftBundle, rest: syncDraftIdRest } = resolveAccountForDraftId(
        requireString(args, "draftId"),
      );
      const draft = await syncDraftBundle.draftStore.getDraft(syncDraftIdRest);
      const synced = await withAudit(auditService, name, args, async () =>
        syncDraftToRemote(syncDraftBundle.draftStore, syncDraftBundle.smtpService, syncDraftBundle.imapService, draft),
      );
      const presentedSynced = presentDraft(syncDraftBundle, synced.draft);
      // Same fix as create_draft/update_draft's identical bloat — see their comments.
      return createTextResult(
        { ...truncateDraftBodyForResponse(redactDraftAttachmentsForListing(presentedSynced)), remoteSync: synced.remoteSync },
        false,
        [
          draftSource(presentedSynced),
          ...(presentedSynced.remoteDraft?.emailId
            ? [
                emailSource({
                  id: presentedSynced.remoteDraft.emailId,
                  subject: presentedSynced.subject,
                  folder: presentedSynced.remoteDraft.folder,
                })
              ]
            : []),
        ],
      );
    }

    case "delete_draft": {
      // Local draft write — same gap as create_draft, see its comment.
      ensureMailboxWriteAllowed(config.runtime);
      const { bundle: deleteDraftBundle, rest: deleteDraftIdRest } = resolveAccountForDraftId(
        requireString(args, "draftId"),
      );
      const draft = await deleteDraftBundle.draftStore.getDraft(deleteDraftIdRest);
      ensureDestructiveConfirmed(config.runtime, normalizeBoolean(args?.confirmed, false), "Permanently delete draft: " + draft.id);
      const deleted = await withAudit(auditService, name, args, async () => {
        const remoteCleanup = resolveRemoteDraftSync(config.runtime, true).enabled
          ? await clearRemoteDraft(deleteDraftBundle.draftStore, deleteDraftBundle.imapService, draft)
          : {
              draft,
              remoteDelete: draft.remoteDraft?.emailId
                ? {
                    ok: false,
                    skipped: true,
                    message: "Remote draft cleanup skipped by runtime policy.",
                  }
                : undefined,
            };
        const deletedResult = await deleteDraftBundle.draftStore.deleteDraft(draft.id);
        return {
          ...deletedResult,
          id: withAccountPrefix(responseSlug(deleteDraftBundle), deletedResult.id),
          remoteDelete: remoteCleanup.remoteDelete,
        };
      });
      return createTextResult(deleted);
    }

    case "create_thread_reply_draft":
    {
      // Local draft write — same gap as create_draft.
      ensureMailboxWriteAllowed(config.runtime);
      // A threadId is only ever valid within the single account it was produced
      // by — same "<slug>::" resolution as get_thread_by_id/move_thread. This was
      // previously always reading via the PRIMARY account's localIndexService/
      // imapService regardless of the threadId's own prefix, so a reply drafted
      // against a non-primary account's thread either resolved the wrong thread
      // (if the primary happened to have a same-shaped local id) or threw not
      // found. Every read below now goes through the resolved threadBundle.
      const { bundle: threadReplyBundle, rest: threadReplyIdRest } = resolveAccountForEmailId(
        requireString(args, "threadId"),
      );
      await maybeRefreshLocalIndex(threadReplyBundle.imapService, threadReplyBundle.localIndexService, {
        force: normalizeBoolean(args.syncBefore, false),
        folder: "INBOX",
        limitPerFolder: 100,
      });

      const thread = await threadReplyBundle.localIndexService.getThreadById(threadReplyIdRest);
      const targetMessage = pickReplyTargetFromThread(
        thread,
        threadReplyBundle.config.smtp.username,
        normalizeBoolean(args.preferLatestInbound, true),
      );

      if (!targetMessage?.primaryEmailId) {
        throw new McpError(ErrorCode.InvalidParams, "Unable to resolve a reply target from the thread.");
      }

      const detail = await threadReplyBundle.imapService.getEmailById(targetMessage.primaryEmailId);
      const body = requireString(args, "body");
      const isHtml = normalizeBoolean(args.isHtml, false);
      const replyAll = normalizeBoolean(args.replyAll, false);
      const attachments = optionalAttachmentList(args.attachments);
      const extraCc = parseEmails(optionalAddressList(args, "cc"));
      const extraBcc = parseEmails(optionalAddressList(args, "bcc"));
      const recipients = getReplyRecipients(detail, threadReplyBundle.config.smtp.username, replyAll, allAccountAddresses());
      const cc = uniqueAddresses([...recipients.cc, ...extraCc]);
      const to = uniqueAddresses(recipients.to);

      ensureValidEmails(to, "to");
      ensureValidEmails(cc, "cc");
      ensureValidEmails(extraBcc, "bcc");

      if (to.length === 0) {
        throw new McpError(ErrorCode.InvalidParams, "Unable to infer reply recipient.");
      }

      // Same from-based draftStore routing as create_reply_draft — defaults to
      // the THREAD's own account (threadReplyBundle, already resolved above from
      // the threadId's own prefix), not always primary, when `from` isn't given.
      // Previously always defaulted to primary regardless of which account the
      // thread actually belonged to — a reply drafted with no explicit `from`
      // against a non-primary account's thread silently switched accounts.
      const createThreadReplyDraftBundle =
        optionalString(args, "from") !== undefined
          ? accountManager.byAddress(optionalString(args, "from") as string) ?? threadReplyBundle
          : threadReplyBundle;

      const result = await withAudit(auditService, name, args, async () => {
        const draft = await createThreadReplyDraftBundle.draftStore.createDraft({
          mode: "reply",
          to,
          cc,
          bcc: extraBcc,
          subject: prefixedSubject(detail.subject, "Re:"),
          // An HTML draft needs an HTML quote: a plain-text "> ..." quote appended to an HTML
          // body collapses its newlines (HTML whitespace) into one run-on blob.
          body: isHtml ? buildReplyHtml(detail, body) : buildReplyText(detail, body),
          isHtml,
          // Same fix as create_reply_draft — see its comment.
          from: optionalString(args, "from"),
          inReplyTo: detail.messageId,
          references: replyReferences(detail),
          attachments,
          sourceEmailId: detail.id,
          sourceMessageId: detail.messageId,
          notes: optionalString(args, "notes"),
        });

        const remoteSyncDecision = resolveRemoteDraftSync(
          config.runtime,
          normalizeBoolean(args.syncToRemote, true),
        );
        const synced = remoteSyncDecision.enabled
          ? await syncDraftToRemote(
              createThreadReplyDraftBundle.draftStore,
              createThreadReplyDraftBundle.smtpService,
              createThreadReplyDraftBundle.imapService,
              draft,
            )
          : { draft, remoteSync: undefined };
        const remoteSync =
          synced.remoteSync ??
          (remoteSyncDecision.reason
            ? {
                ok: false,
                skipped: true,
                message: remoteSyncDecision.reason,
              }
            : undefined);

        const presented = presentDraft(
          createThreadReplyDraftBundle,
          remoteSync ? { ...synced.draft, remoteSync } : synced.draft,
        );
        return { ...presented, threadId: thread.id };
      });

      // Same fix as create_draft/update_draft's identical bloat — see their comments.
      return createTextResult(
        truncateDraftBodyForResponse(redactDraftAttachmentsForListing(result)),
        false,
        [
          draftSource(result),
          threadSource(thread),
          emailSource(detail),
          ...(result.remoteDraft?.emailId
            ? [
                emailSource({
                  id: result.remoteDraft.emailId,
                  subject: result.subject,
                  folder: result.remoteDraft.folder,
                })
              ]
            : []),
        ],
      );
    }

    case "send_draft": {
      ensureDestructiveConfirmed(config.runtime, (normalizeBoolean(args.confirmed, false) || normalizeBoolean(args.dryRun, false)), `Send draft ${String(args.draftId ?? "?")}`);
      ensureSendAllowed(config.runtime);
      const { bundle: sendDraftBundle, rest: sendDraftIdRest } = resolveAccountForDraftId(
        requireString(args, "draftId"),
      );
      const draft = await sendDraftBundle.draftStore.getDraft(sendDraftIdRest);
      // Found live (external review): sendDraftBundle above is resolved from
      // the draftId's own account-slug prefix — i.e. where the draft is
      // STORED — which never changes just because update_draft later set a
      // different draft.from. Repro: create_draft on primary, then
      // update_draft(from: secondary@example.com), then send_draft — the
      // payload correctly carries "secondary@example.com", but it went out
      // through PRIMARY's live SMTP connection with that as a header
      // override, which a Split-Addresses config (separate login per
      // address) can reject outright instead of accepting as a plain alias.
      // sendBundleForDraft is resolved separately, same distinction
      // send_email/reply_to_email already draw between "where to read/store"
      // and "which account to actually send through" — draft storage,
      // claimForSending, markSent, and remote-draft cleanup all still use
      // sendDraftBundle (the draft doesn't move), only the SMTP call itself
      // uses the resolved account.
      const sendBundleForDraft = draft.from ? accountManager.byAddress(draft.from) ?? sendDraftBundle : sendDraftBundle;
      // Found live: calling send_draft twice on the same draft sent it
      // twice — nothing here checked whether it was already marked
      // "sent" before sending again. Refuse; create_draft for a new
      // message instead.
      if (draft.status === "sent") {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Draft ${draft.id} was already sent (at ${draft.sentAt ?? "an earlier time"}) — sending it again would deliver it twice. Use create_draft to compose a new message instead.`,
        );
      }
      // Found live: schedule_draft followed by send_draft on the same
      // draft sent it twice — two independent, successful SMTP
      // transactions, since nothing here knew about the still-pending
      // scheduled send. Refuse instead; cancel_send first if the
      // immediate send is actually what's wanted.
      const pendingScheduled = (await sendDraftBundle.deliveryQueueService.list()).find(
        (record) => record.sourceDraftId === draft.id && record.status === "pending",
      );
      if (pendingScheduled) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `This draft already has a pending scheduled send (id ${withAccountPrefix(responseSlug(sendDraftBundle), pendingScheduled.id)}, sendAt ${pendingScheduled.sendAt}). Sending now would deliver it twice. Cancel that scheduled send with cancel_send first, or wait for it to fire.`,
        );
      }
      ensureValidEmails(draft.to, "to");
      ensureValidEmails(draft.cc, "cc");
      ensureValidEmails(draft.bcc, "bcc");
      if (draft.replyTo && !isValidEmail(draft.replyTo)) {
        throw new McpError(ErrorCode.InvalidParams, "replyTo must be a valid email address.");
      }
      // Shared helper, and the sending account's own address as "self" —
      // see send_email's comment. isSelfAddress also fixes the IMAP-vs-SMTP
      // username mismatch the old inline check's comment warned about.
      ensureOutboundRecipientsAllowed(config.runtime, sendBundleForDraft.config.smtp.username, [...draft.to, ...draft.cc, ...draft.bcc]);

      if (normalizeBoolean(args.dryRun, false)) {
        return createTextResult({
          dryRun: true,
          wouldSendTo: { to: draft.to, cc: draft.cc, bcc: draft.bcc },
          subject: draft.subject,
          body: draft.body,
          isHtml: draft.isHtml,
          note: "No email was sent.",
        }, false, [draftSource(draft)]);
      }

      // Atomic claim: the status/pending-scheduled checks above are read
      // then acted on non-atomically, so two concurrent send_draft calls
      // (or a scheduled send firing at the same instant) could both pass
      // them. claimForSending() re-reads status under the draft store's
      // lock and flips "draft" -> "sending" in that same critical
      // section — only the call that wins the claim proceeds to SMTP.
      await sendDraftBundle.draftStore.claimForSending(draft.id);

      // Found live: withAudit wrapped the SMTP call, so an audit-log
      // write failure AFTER a successful send (e.g. disk full) was
      // indistinguishable from a send failure — it threw out of
      // withAudit, and the catch below reverted an already-sent draft
      // back to "draft", making it resendable and enabling a genuine
      // duplicate delivery. SMTP is called directly here so its outcome
      // (and the revert-on-failure below) can't be corrupted by a
      // separate audit-write failure — the audit record for the success
      // case is written afterward, on its own, with a failure there only
      // logged, never reverting a send that already happened.
      const sendStartedAt = Date.now();
      let result: Awaited<ReturnType<typeof smtpService.sendEmail>>;
      try {
        result = await sendBundleForDraft.smtpService.sendEmail({
          to: draft.to,
          cc: draft.cc,
          bcc: draft.bcc,
          subject: draft.subject,
          body: draft.body,
          isHtml: draft.isHtml,
          priority: draft.priority,
          replyTo: draft.replyTo,
          from: draft.from,
          inReplyTo: draft.inReplyTo,
          references: draft.references,
          attachments: draft.attachments,
          // Draft content is already finalized and reviewed — appending a
          // signature invisibly at send time would change what the user
          // saw and approved. If a signature is wanted, it belongs in the
          // draft body itself.
          appendSignature: false,
        });
      } catch (error) {
        // Mirrors SnoozeService.wake()'s catch handler: revert the claim
        // so the draft is retryable instead of stuck in "sending"
        // forever because SMTP failed.
        // NOT when the outcome is unknown (a timeout, or the connection dropped after the data was sent): the server may
        // have accepted the message, and making the draft sendable again lets a retry deliver it twice. It then stays
        // locked in "sending" until the user has checked the Sent folder, like a timed-out queued send.
        const unknownOutcome = sendOutcomeIsUnknown(error);
        if (!unknownOutcome) await sendDraftBundle.draftStore.revertSending(draft.id);
        await auditService
          .record({
            timestamp: new Date().toISOString(),
            tool: name,
            status: "error",
            durationMs: Date.now() - sendStartedAt,
            input: sanitizeAuditValue(args),
            error: error instanceof Error ? error.message : String(error),
          })
          .catch((auditError) =>
            logger.error("Failed to record audit log for a failed send_draft", "MCPServer", {
              draftId: draft.id,
              error: auditError,
            }),
          );
        if (unknownOutcome) {
          throw new Error(
            // The connection error itself is left out: a tool error that looks like a connection failure is replaced by
            // the generic "could not connect" advice, which would hide this. It is in the audit log.
            "The send failed after the message may have reached the server. " +
              "Check the Sent folder before sending again: the draft stays locked as \"sending\" so it cannot go out twice, and can be deleted once you know.",
          );
        }
        throw error;
      }

      try {
        await auditService.record({
          timestamp: new Date().toISOString(),
          tool: name,
          status: "success",
          durationMs: Date.now() - sendStartedAt,
          input: sanitizeAuditValue(args),
          result: sanitizeAuditValue(result),
        });
      } catch (auditError) {
        logger.error(
          "Failed to record audit log for a successful send_draft — the email was already sent, so the draft is not being reverted",
          "MCPServer",
          { draftId: draft.id, error: auditError },
        );
      }

      let sentDraft = await sendDraftBundle.draftStore.markSent(draft.id, {
        messageId: result.messageId,
        accepted: result.accepted,
        rejected: result.rejected,
        response: result.response,
      });
      const remoteCleanup = resolveRemoteDraftSync(config.runtime, true).enabled
        ? await clearRemoteDraft(sendDraftBundle.draftStore, sendDraftBundle.imapService, sentDraft)
        : {
            draft: sentDraft,
            remoteDelete: sentDraft.remoteDraft?.emailId
              ? {
                  ok: false,
                  skipped: true,
                  message: "Remote draft cleanup skipped by runtime policy.",
                }
              : undefined,
          };
      sentDraft = presentDraft(sendDraftBundle, remoteCleanup.draft);

      // Found live (external review): the send and markSent() above already
      // succeeded — this citation lookup is purely for the response's source
      // list, and used to throw uncaught if the original message had been
      // moved/deleted since the draft was created, reporting a false failure
      // for an email that had actually already been sent (and the draft
      // already marked "sent", so a caller who saw the error and retried
      // would correctly hit the already-sent guard above — but with no way to
      // know the first attempt had, in fact, worked). Best-effort, same as
      // verifySentCopy just below.
      const sources = [draftSource(sentDraft)];
      if (sentDraft.sourceEmailId) {
        try {
          sources.push(emailSource(await sendDraftBundle.imapService.getEmailById(sentDraft.sourceEmailId)));
        } catch (_) {}
      }

      let sentCopyTokenDraft = "[sent-copy:unverified]";
      try {
        const verifyMsgId = result.messageId;
        if (verifyMsgId) {
          const scv = await verifySentCopy(sendBundleForDraft.imapService, verifyMsgId);
          if (scv.found) sentCopyTokenDraft = "[sent-copy:verified]";
        }
      } catch (_) {}

      return createTextResult(
        {
          draftId: sentDraft.id,
          status: sentDraft.status,
          messageId: result.messageId,
          accepted: result.accepted,
          rejected: result.rejected,
          response: result.response,
          remoteDelete: remoteCleanup.remoteDelete,
          sentCopy: sentCopyTokenDraft,
        },
        false,
        sources,
      );
    }

    case "schedule_draft": {
      ensureDestructiveConfirmed(config.runtime, normalizeBoolean(args.confirmed, false), `Schedule draft ${String(args.draftId ?? "?")} to send later`);
      ensureSendAllowed(config.runtime);
      const { bundle: scheduleDraftBundle, rest: scheduleDraftIdRest } = resolveAccountForDraftId(
        requireString(args, "draftId"),
      );
      const draft = await scheduleDraftBundle.draftStore.getDraft(scheduleDraftIdRest);
      // Same fix as send_draft's identical sendBundleForDraft — see its
      // comment. The delivery queue fires via whichever account's own
      // deliveryQueueService it was enqueued into, so this must be the
      // account draft.from actually names, not always the draft's storage
      // account — used consistently below for both the duplicate-schedule
      // check and the enqueue call itself, so both look at the same queue.
      const sendBundleForScheduleDraft = draft.from ? accountManager.byAddress(draft.from) ?? scheduleDraftBundle : scheduleDraftBundle;
      // Mirrors send_draft's own pendingScheduled guard, for the reverse
      // ordering: send_draft already delivered this draft once, and
      // scheduling it again here would deliver it a second time at
      // sendAt. Found live: send_draft then schedule_draft on the same
      // (already-sent) draft queued a second, independent delivery.
      if (draft.status === "sent") {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Draft ${draft.id} was already sent — scheduling it again would deliver it twice. Use create_draft to compose a new message instead.`,
        );
      }
      // Mirrors the check above but for the same-ordering case: a draft
      // has no "scheduled" status (only "draft"/"sent" — see
      // DraftStoreService), so calling schedule_draft twice on the same
      // still-"draft" draft (e.g. to change sendAt, or a client retry
      // after an ambiguous response) sailed past the status check above
      // and enqueued a second, independent delivery-queue record. Both
      // fire independently later, delivering the same email twice.
      //
      // Found live: this list()-then-check was itself a non-atomic
      // TOCTOU race — two concurrent schedule_draft calls could both
      // observe no pending record here and both enqueue. The real
      // enforcement now lives inside deliveryQueueService.enqueue()
      // itself, under its lock, which is what actually prevents the
      // duplicate. This external check is kept only as an optional
      // early-exit optimization to avoid a wasted round-trip to the lock
      // in the common non-racing case.
      const alreadyPendingScheduled = (await sendBundleForScheduleDraft.deliveryQueueService.list()).find(
        (record) => record.sourceDraftId === draft.id && record.status === "pending",
      );
      if (alreadyPendingScheduled) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `This draft already has a pending scheduled send (id ${withAccountPrefix(responseSlug(sendBundleForScheduleDraft), alreadyPendingScheduled.id)}, sendAt ${alreadyPendingScheduled.sendAt}). Scheduling it again would deliver it twice. Cancel the existing one with cancel_send first if you want a different sendAt.`,
        );
      }
      const sendAt = requireString(args, "sendAt");
      const sendAtTime = new Date(sendAt).getTime();
      if (Number.isNaN(sendAtTime)) {
        throw new McpError(ErrorCode.InvalidParams, `sendAt is not a valid ISO 8601 timestamp: ${sendAt}`);
      }
      if (sendAtTime <= Date.now()) {
        throw new McpError(ErrorCode.InvalidParams, "sendAt must be in the future. Use send_draft to send immediately.");
      }
      ensureValidEmails(draft.to, "to");
      ensureValidEmails(draft.cc, "cc");
      ensureValidEmails(draft.bcc, "bcc");
      if (draft.replyTo && !isValidEmail(draft.replyTo)) {
        throw new McpError(ErrorCode.InvalidParams, "replyTo must be a valid email address.");
      }
      // Shared helper, and the sending account's own address as "self" —
      // see send_draft's identical fix.
      ensureOutboundRecipientsAllowed(config.runtime, sendBundleForScheduleDraft.config.smtp.username, [...draft.to, ...draft.cc, ...draft.bcc]);

      const queued = await withAudit(auditService, name, args, async () =>
        sendBundleForScheduleDraft.deliveryQueueService.enqueue(
          {
            to: draft.to,
            cc: draft.cc,
            bcc: draft.bcc,
            subject: draft.subject,
            body: draft.body,
            isHtml: draft.isHtml,
            priority: draft.priority,
            replyTo: draft.replyTo,
            from: draft.from,
            inReplyTo: draft.inReplyTo,
            references: draft.references,
            attachments: draft.attachments,
            // Draft content is already finalized and reviewed — see the
            // identical note on send_draft.
            appendSignature: false,
          },
          new Date(sendAtTime).toISOString(),
          "scheduled_send",
          draft.id,
          // The draft stays in its own account's store even when `from` routes the
          // send through another account's queue/SMTP.
          scheduleDraftBundle.account.slug,
        ),
      );

      return createTextResult({
        queued: true,
        id: withAccountPrefix(responseSlug(sendBundleForScheduleDraft), queued.id),
        draftId: withAccountPrefix(responseSlug(scheduleDraftBundle), draft.id),
        sendAt: queued.sendAt,
        note: "The draft's content was snapshotted now and queued. This server must stay running for the send to fire at sendAt — if restarted first, it fires on next startup instead. The draft record itself is not automatically marked sent; use cancel_send with this id to abort before it fires.",
      });
    }

    default:
      throw new Error(`handleDraftTool: unexpected tool ${name}`);
  }
}
