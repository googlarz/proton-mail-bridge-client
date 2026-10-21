#!/usr/bin/env node

import { chmod, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { isMainModule } from "./is-main.js";
import { CORE_TOOL_NAMES, listedTools } from "./tools/definitions.js";
import { findMailPrompt, MAIL_PROMPTS } from "./utils/mail-prompts.js";
import { applyBodyEdits } from "./services/draft-store-service.js";
import { describeImapError, isLikelyAuthenticationError, isLikelyConnectionError, isLikelyTlsMismatchError } from "./services/simple-imap-service.js";
import { applySignature } from "./services/smtp-service.js";
import type {
  ActionableThreadSummary,
  BatchActionEntry,
  BatchActionResult,
  BulkMatchCriteria,
  BulkOperationResult,
  EmailAddress,
  ProtonMailConfig,
  SendEmailInput,
  ThreadDetail,
} from "./types/index.js";
import {
  ensureValidEmails,
  isTextLikeMimeType,
  isValidEmail,
  InvalidArgumentError,
  normalizeBoolean,
  normalizeLimit,
  optionalBoolean,
  optionalInteger,
  optionalNumber,
  parseEmailId,
  parseEmails,
  projectFields,
  trimAttachmentsForListing,
  renderMarkdown,
  splitAccountPrefix,
  withAccountPrefix,
} from "./utils/helpers.js";
import { AccountManager, type AccountBundle } from "./services/account-manager.js";
import { createToolContext } from "./tools/context.js";
import { handleAttachmentTool } from "./tools/attachments.js";
import { handleTemplateAndReminderTool } from "./tools/templates-and-reminders.js";
import { healthProblems } from "./utils/health.js";
import { logger } from "./utils/logger.js";
import {
  ensureDestructiveConfirmed,
  ensureEmailActionAllowed,
  ensureFlagChangeAllowed,
  ensureMailboxWriteAllowed,
  ensureOutboundRecipientsAllowed,
  ensureRemoteDraftSyncAllowed,
  ensureSendAllowed,
  resolveRemoteDraftSync,
  sanitizeRuntimeConfig,
} from "./utils/runtime-policy.js";
import { InviteError, buildInviteReply, findMyAttendee, parseInvite, type ParsedInvite } from "./utils/ical-reply.js";
import { ToolResult, createTextResult } from "./tools/results.js";
import { parseBodyEdits, withIgnoredArgumentsNote, asObject, requireString, optionalString, optionalClearableString, parseFieldsArg, parseStringListArg, requireEmailAction, optionalAttachmentList } from "./tools/args.js";
import { sanitizeAuditValue, withAudit } from "./tools/audit.js";
import { formatEmailDetailOutput, extractUnsubscribeInfo, uniqueAddresses, prefixedSubject, replyReferences, buildReplyText, buildForwardText, buildReplyHtml, buildForwardHtml, getReplyRecipients } from "./tools/compose.js";
import { buildEmailResourceUri, buildThreadResourceUri, buildDraftResourceUri, emailSource, threadSource, draftSource, attachmentSource, formatEmailResource, formatThreadResource, formatDraftResource, parseResourceUri } from "./tools/resources.js";
import { getBulkMaxBatchSize, ensureBulkBatchSize, BulkExcludedEmailId, getBulkNotFoundEmailIds, withBulkNotFound, groupEmailIdsByAccount, prefixBulkResult, prefixNotFound, mergeBulkResults } from "./tools/bulk.js";
import { tagAccountIds, THREAD_LIST_RESPONSE_BUDGET_CHARS, trimThreadsToBudget, paginationFields, accountSlugForTag, sortByDateDesc, paginateMergedAccountResults, mergeMailboxLabels, mergeContactStats, mergeCountedEntries, mergeVolumeTrends, paginateRecentRecords } from "./tools/merge.js";
import { redactDraftAttachmentsForListing, isNoopDraftPatch, truncateDraftBodyForResponse, redactQueueRecordAttachments } from "./tools/drafts-support.js";
import { MissingCredentialsError, buildConfigFromEnv } from "./config-env.js";
import { refreshIndexForSearch, maybeRefreshLocalIndex, getAnalyticsSampleFromIndex } from "./tools/index-refresh.js";
import { ensureMoveTargetAllowed, syncDraftToRemote, clearRemoteDraft, emailSourceFromActionResult, applyBatchEmailAction, verifySentCopy, pickReplyTargetFromThread, buildThreadBrief, isMissingTargetFolderError } from "./tools/actions.js";
export { mailboxChangedSinceCheckpoint } from "./tools/index-refresh.js";
export { MissingCredentialsError, buildConfigFromEnv } from "./config-env.js";
export { redactDraftAttachmentsForListing, isNoopDraftPatch, truncateDraftBodyForResponse, redactQueueRecordAttachments, writeAttachmentToDownloadDir } from "./tools/drafts-support.js";
export { tagAccountIds, THREAD_LIST_RESPONSE_BUDGET_CHARS, trimThreadsToBudget, paginateMergedAccountResults } from "./tools/merge.js";
export { getBulkMaxBatchSize, ensureBulkBatchSize, getBulkNotFoundEmailIds, withBulkNotFound, groupEmailIdsByAccount, prefixBulkResult, prefixNotFound, mergeBulkResults } from "./tools/bulk.js";
export { headerString, parseAuthenticationResults, buildSecurityInfo, parseUnsubscribeMailto, extractUnsubscribeInfo, formatQuoteDate, stripUnshippableImages, buildReplyText, buildForwardText, buildReplyHtml, buildForwardHtml, getReplyRecipients } from "./tools/compose.js";
export { withSources } from "./tools/results.js";
export { ignoredArguments, optionalClearableString } from "./tools/args.js";
export { withAudit } from "./tools/audit.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: string };
const PACKAGE_VERSION = packageJson.version ?? process.env.npm_package_version ?? "0.0.0";
// Triage and statistics tools cover every configured account unless told which one.
// Calendar providers that route replies through their own gateway: the organizer in an iCloud invitation is an
// address at Apple's iMIP relay, while the message comes from noreply@email.apple.com. A reply to such an address
// goes to the provider itself, so the organizer/sender mismatch warning is not raised for it.
const CALENDAR_RELAY_DOMAINS = new Set(["imip.me.com"]);

export function createServer(
  config: ProtonMailConfig,
  options: {
    startBackgroundSync?: boolean;
  } = {},
) {
  // AccountManager builds one full, isolated service stack per configured account
  // (config.accounts — primary plus any PROTONMAIL_ACCOUNTS_JSON entries). The bare
  // names below stay bound to the PRIMARY account's stack so every existing
  // single-account tool handler keeps working completely unchanged; only handlers that
  // need to act on a specific (possibly non-primary) account resolve through
  // accountManager instead — see resolveAccountForEmailId/resolveAccountForDraft below.
  const accountManager = new AccountManager(config, logger);
  const primaryBundle = accountManager.primary();

  const ctx = createToolContext(config, accountManager);
  const {
    smtpService,
    imapService,
    analyticsService,
    auditService,
    localIndexService,
    draftStore,
    backgroundSyncService,
    deliveryQueueService,
    snoozeService,
    resolveAccountArg,
    resolveFolderTarget,
    selectedBundles,
    evaluateReminders,
    allAccountAddresses,
    resolveAccountForEmailId,
    prefixedIdFor,
    withPrefixedIds,
    resolveAccountForDraftId,
    resolveAccountForQueueId,
    responseSlug,
    resolveUndoWindowSeconds,
    queueUndoSend,
    slugForBundle,
    presentDraft,
  } = ctx;

  if (options.startBackgroundSync) {
    // Every configured account gets its own independent sync/delivery-queue/snooze
    // loop — additional accounts are not just readable, they stay live-synced exactly
    // like the primary. The primary's own start() call below is intentionally
    // redundant with this loop (primaryBundle is included in accountManager.all()) so
    // this doesn't silently change primary-only behavior if that ever stops holding.
    for (const bundle of accountManager.all()) {
      bundle.backgroundSyncService.start();
      // start()'s first real work is awaiting recoverInterruptedSends(), which
      // can throw a lock-acquisition-timeout error (see file-lock.ts). Bare
      // `void` here would turn that into an unhandled rejection, and the
      // process-wide unhandledRejection handler below calls process.exit(1) —
      // crashing the whole server before it serves a single request over
      // nothing worse than startup lock contention. Log and degrade instead:
      // the delivery queue just won't be running yet.
      bundle.deliveryQueueService.start().catch((error) => {
        logger.error("deliveryQueueService.start() failed", "MCPServer", { account: bundle.account.slug, error });
      });
      // snoozeService.start() is synchronous (returns void, not a Promise) —
      // nothing to catch here.
      bundle.snoozeService.start();
    }
  }

  const server = new Server(
    {
      name: "proton-mail-bridge-client",
      version: PACKAGE_VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listedTools() }));

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: MAIL_PROMPTS.map(({ name, title, description, arguments: promptArguments }) => ({
      name,
      title,
      description,
      ...(promptArguments ? { arguments: promptArguments } : {}),
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const prompt = findMailPrompt(request.params.name);
    if (!prompt) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown prompt "${request.params.name}". Available: ${MAIL_PROMPTS.map((entry) => entry.name).join(", ")}.`);
    }
    const provided = request.params.arguments ?? {};
    for (const argument of prompt.arguments ?? []) {
      if (argument.required && !String(provided[argument.name] ?? "").trim()) {
        throw new McpError(ErrorCode.InvalidParams, `Prompt "${prompt.name}" needs the argument "${argument.name}": ${argument.description}`);
      }
    }
    return {
      description: prompt.description,
      messages: [{ role: "user" as const, content: { type: "text" as const, text: prompt.render(provided) } }],
    };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    const cursor = request.params?.cursor ? Number.parseInt(request.params.cursor, 10) : 0;
    // Fan out across every configured account and prefix non-primary ids exactly as the
    // tools do (responseSlug is undefined for the primary, so a single-account setup
    // lists byte-for-byte what it always did).
    const perAccount = await Promise.all(
      accountManager.all().map(async (bundle) => {
        const [drafts, threadsResult, messages] = await Promise.all([
          bundle.draftStore.listDrafts(false),
          bundle.localIndexService.getThreads({ limit: 25 }),
          bundle.localIndexService.listRecentMessages(25),
        ]);
        const slug = responseSlug(bundle);
        return [
          ...drafts.map((draft) => {
            const id = withAccountPrefix(slug, draft.id);
            return {
              uri: buildDraftResourceUri(id),
              name: id,
              title: draft.subject,
              description: `${draft.status} · updated ${draft.updatedAt}`,
              mimeType: "text/markdown",
            };
          }),
          ...threadsResult.threads.map((thread) => {
            const id = withAccountPrefix(slug, thread.id);
            return {
              uri: buildThreadResourceUri(id),
              name: id,
              title: thread.subject,
              description: `${thread.messageCount} message(s)`,
              mimeType: "text/markdown",
            };
          }),
          ...messages.map((message) => {
            const id = withAccountPrefix(slug, message.primaryEmailId);
            return {
              uri: buildEmailResourceUri(id),
              name: id,
              title: message.subject,
              description: `${message.folder} · ${message.internalDate || message.date || "undated"}`,
              mimeType: "message/rfc822",
            };
          }),
        ];
      }),
    );
    const resources = perAccount.flat();

    const pageSize = 50;
    const nextCursor =
      cursor + pageSize < resources.length ? String(cursor + pageSize) : undefined;

    return {
      resources: resources.slice(cursor, cursor + pageSize),
      nextCursor,
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const target = parseResourceUri(request.params.uri);

    switch (target.kind) {
      case "email": {
        const { bundle: emailBundle, rest: emailRest } = resolveAccountForEmailId(target.emailId);
        const detail = await emailBundle.imapService.getEmailById(emailRest);
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: "text/markdown",
              text: formatEmailResource(detail),
            },
          ],
        };
      }
      case "thread": {
        const { bundle: threadBundle, rest: threadRest } = resolveAccountForEmailId(target.threadId);
        const thread = await threadBundle.localIndexService.getThreadById(threadRest);
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: "text/markdown",
              text: formatThreadResource({
                id: thread.id,
                subject: thread.subject,
                latestDate: thread.latestDate,
                normalizedLabels: thread.normalizedLabels,
                messages: thread.messages.map((message) => ({
                  id: message.primaryEmailId,
                  subject: message.subject,
                  from: message.from,
                  date: message.date,
                  internalDate: message.internalDate,
                  preview: message.preview,
                })),
              }),
            },
          ],
        };
      }
      case "draft": {
        const { bundle: draftBundle, rest: draftRest } = resolveAccountForDraftId(target.draftId);
        const draft = await draftBundle.draftStore.getDraft(draftRest);
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: "text/markdown",
              text: formatDraftResource(draft),
            },
          ],
        };
      }
      case "attachment": {
        const { bundle: attachmentBundle, rest: attachmentEmailRest } = resolveAccountForEmailId(target.emailId);
        const attachment = await attachmentBundle.imapService.getAttachmentContent(
          attachmentEmailRest,
          target.attachmentId,
          true,
        );
        const mimeType = attachment.attachment.contentType || "application/octet-stream";
        if (attachment.text && isTextLikeMimeType(mimeType)) {
          return {
            contents: [
              {
                uri: request.params.uri,
                mimeType,
                text: attachment.text,
              },
            ],
          };
        }

        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType,
              blob: attachment.base64 || "",
            },
          ],
        };
      }
    }
  });

  server.setRequestHandler(CallToolRequestSchema, withIgnoredArgumentsNote(async (request) => {
    const name = request.params.name;
    const args = asObject(request.params.arguments);
    logger.debug("Handling tool call", "MCPServer", { name, argKeys: Object.keys(args || {}) });

    try {
      switch (name) {
        case "send_email": {
          ensureDestructiveConfirmed(config.runtime, (normalizeBoolean(args.confirmed, false) || normalizeBoolean(args.dryRun, false)), `Send email to ${String(args.to ?? "?")} — "${String(args.subject ?? "?")}"`);
          ensureSendAllowed(config.runtime);
          const to = parseEmails(requireString(args, "to"));
          const cc = parseEmails(optionalString(args, "cc"));
          const bcc = parseEmails(optionalString(args, "bcc"));
          const subject = requireString(args, "subject");
          const markdownBodySend = optionalString(args, "markdownBody");
          const body = markdownBodySend ? markdownBodySend : requireString(args, "body");
          const isHtml = markdownBodySend ? false : normalizeBoolean(args.isHtml, false);
          const htmlBody = markdownBodySend ? renderMarkdown(markdownBodySend).html : undefined;
          const priority = optionalString(args, "priority");
          const replyTo = optionalString(args, "replyTo");
          const fromName = optionalString(args, "fromName");
          const from = optionalString(args, "from");
          const sanitizeHtml = normalizeBoolean(args.sanitizeHtml, true);
          const attachments = optionalAttachmentList(args.attachments);

          ensureValidEmails(to, "to");
          ensureValidEmails(cc, "cc");
          ensureValidEmails(bcc, "bcc");
          if (replyTo && !isValidEmail(replyTo)) {
            throw new McpError(ErrorCode.InvalidParams, "replyTo must be a valid email address.");
          }
          if (from && !isValidEmail(from)) {
            throw new McpError(ErrorCode.InvalidParams, "from must be a valid email address.");
          }

          // dryRun: preview without sending
          const dryRunSend = normalizeBoolean(args.dryRun, false);

          // RESTRICT_OUTBOUND_TO_SELF check — shared helper so a self-send to
          // "you+tag@..." isn't wrongly rejected (see its comment in runtime-policy.ts).
          // `from`'s own account (if any) is the correct "self" for a multi-account send.
          ensureOutboundRecipientsAllowed(
            config.runtime,
            (from ? accountManager.byAddress(from)?.config.smtp.username : undefined) ?? config.smtp.username,
            [...to, ...(cc ?? []), ...(bcc ?? [])],
          );

          if (dryRunSend) {
            return createTextResult({ dryRun: true, wouldSendTo: { to, cc: cc ?? [], bcc: bcc ?? [] }, subject, note: "No email was sent." });
          }

          const emailPayload: SendEmailInput = {
            to,
            cc,
            bcc,
            subject,
            body,
            isHtml,
            htmlBody,
            fromName,
            from,
            sanitizeHtml,
            priority:
              priority === "high" || priority === "low" || priority === "normal"
                ? priority
                : "normal",
            replyTo,
            attachments,
            requestReadReceipt: normalizeBoolean(args.requestReadReceipt, false),
            appendSignature: normalizeBoolean(args.appendSignature, true),
          };

          // Undo-send: PROTONMAIL_SEND_DELAY_SECONDS > 0 queues instead of sending
          // immediately, cancelable via cancel_send until the window elapses.
          // undoWindowSeconds overrides the server default for this one send —
          // including forcing 0 (send immediately) when a default is configured.
          const undoWindowSeconds = resolveUndoWindowSeconds(args);
          // A `from` matching a configured additional account routes through that
          // account's own SMTP connection — required under Bridge's Split Addresses
          // feature, where each address is its own separate IMAP/SMTP login, not just
          // an alias on the primary's connection. A `from` that doesn't match any
          // configured account falls back to the pre-multi-account behavior: send via
          // the primary connection with `from` passed through as a plain header
          // override (still valid for a genuine alias only reachable that way).
          const sendBundle = from ? accountManager.byAddress(from) : undefined;
          const effectiveSendBundle = sendBundle ?? primaryBundle;
          const sendSmtp = sendBundle ? sendBundle.smtpService : smtpService;
          const sendImap = sendBundle ? sendBundle.imapService : imapService;

          if (undoWindowSeconds > 0) {
            // The undo-send queue now goes through the resolved account's OWN
            // deliveryQueueService (same routing as the immediate-send path above),
            // so it fires later via that account's real SMTP connection rather than
            // always the primary's — a delayed send with a non-primary `from` used
            // to only ever get the header-override-on-primary fallback at fire time.
            // The returned id is prefixed with that account's slug (same scheme as
            // emailId/draftId) so cancel_send/list_scheduled_sends can find it again.
            const sendAt = new Date(Date.now() + undoWindowSeconds * 1000).toISOString();
            const queued = await withAudit(auditService, name, args, async () =>
              effectiveSendBundle.deliveryQueueService.enqueue(emailPayload, sendAt, "undo_send"),
            );
            return createTextResult({
              queued: true,
              id: withAccountPrefix(responseSlug(effectiveSendBundle), queued.id),
              sendAt: queued.sendAt,
              note: `Not sent yet — will send in ~${undoWindowSeconds}s unless canceled with cancel_send. This server must stay running for the send to fire; if it's restarted before sendAt, the send fires on next startup instead.`,
            });
          }

          const result = await withAudit(auditService, name, args, async () =>
            sendSmtp.sendEmail(emailPayload),
          );

          let sentCopyTokenSend = "[sent-copy:unverified]";
          try {
            const verifyMsgId = result.messageId;
            if (verifyMsgId) {
              const scv = await verifySentCopy(sendImap, verifyMsgId);
              if (scv.found) sentCopyTokenSend = "[sent-copy:verified]";
            }
          } catch (_) {}

          return createTextResult({
            messageId: result.messageId,
            accepted: result.accepted,
            rejected: result.rejected,
            response: result.response,
            sentCopy: sentCopyTokenSend,
          });
        }

        case "cancel_send": {
          // Zero policy gate: canceling a queued send mutates local delivery-queue
          // state, but nothing here ever checked read-only mode.
          ensureMailboxWriteAllowed(config.runtime);
          // The queue id carries an account-slug prefix when the item was enqueued
          // through a non-primary account (see send_email/schedule_draft) — resolve
          // it back to that account's own deliveryQueueService, same as an
          // emailId/draftId, instead of always checking the primary's queue.
          const { bundle: cancelSendBundle, rest: cancelSendIdRest } = resolveAccountForQueueId(
            requireString(args, "id"),
          );
          const result = await withAudit(auditService, name, args, async () =>
            cancelSendBundle.deliveryQueueService.cancel(cancelSendIdRest),
          );
          return createTextResult({ ...result, id: withAccountPrefix(responseSlug(cancelSendBundle), result.id) });
        }

        case "list_scheduled_sends": {
          const statusFilter = optionalString(args, "status");
          // Fan out across every configured account's own delivery queue and tag each
          // item's id with its owning account's slug — mirrors the read-tool fan-out
          // pattern (get_emails etc.). A single account produces the same records, just
          // untagged.
          // Each record's payload carries the same full base64 attachment content as
          // a draft — see redactQueueRecordAttachments' comment. Redacted for every
          // record regardless of status (including canceled ones, which otherwise
          // stayed just as bloated once queued).
          const perAccount = await withAudit(auditService, name, args, async () =>
            Promise.all(
              selectedBundles(args).map(async (bundle) => ({
                bundle,
                items: await bundle.deliveryQueueService.list(),
              })),
            ),
          );
          const tagged = perAccount.flatMap(({ bundle, items }) =>
            items.map((item) => ({ ...item, id: withAccountPrefix(responseSlug(bundle), item.id) })),
          );
          // Newest first across accounts, then bounded: a stale queue must not turn one
          // status check into an unbounded response. Sorting happens before slicing so
          // the page is the same regardless of how many accounts contribute.
          // (reversed first: the sort is stable, so records sharing a createdAt
          // millisecond come out latest-inserted first, deterministically)
          const matching = sortByDateDesc(
            (statusFilter ? tagged.filter((item) => item.status === statusFilter) : tagged).reverse(),
            (item) => item.createdAt,
          );
          const offset = normalizeLimit(args.offset, 0, 0, 100_000);
          const limit = normalizeLimit(args.limit, 50, 1, 10_000);
          const page = matching.slice(offset, offset + limit);
          return createTextResult({
            total: matching.length,
            offset,
            returned: page.length,
            hasMore: offset + page.length < matching.length,
            items: page.map(redactQueueRecordAttachments),
          });
        }

        case "get_unsubscribe_info": {
          const rawEmailId = requireString(args, "emailId");
          const { bundle, rest: emailId } = resolveAccountForEmailId(rawEmailId);
          const detail = await bundle.imapService.getEmailById(emailId);
          const info = extractUnsubscribeInfo(detail);
          return createTextResult({
            emailId: prefixedIdFor(bundle, detail.id),
            hasUnsubscribeHeader: Boolean(info.mailto || info.url),
            mailto: info.mailto,
            ...(info.mailtoSubject ? { mailtoSubject: info.mailtoSubject } : {}),
            ...(info.mailtoBody ? { mailtoBody: info.mailtoBody } : {}),
            url: info.url,
            note: info.url
              ? "This server never auto-fetches unsubscribe URLs — open the url yourself, or use unsubscribe_sender if mailto is also set."
              : undefined,
          });
        }

        case "unsubscribe_sender": {
          const rawEmailId = requireString(args, "emailId");
          const { bundle, rest: emailId } = resolveAccountForEmailId(rawEmailId);
          const detail = await bundle.imapService.getEmailById(emailId);
          const info = extractUnsubscribeInfo(detail);
          if (!info.mailto) {
            if (info.url) {
              throw new McpError(
                ErrorCode.InvalidParams,
                `This message's List-Unsubscribe header only has an https link, not a mailto address — this server never auto-fetches unsubscribe URLs. Open it yourself: ${info.url}`,
              );
            }
            throw new McpError(ErrorCode.InvalidParams, "This message has no List-Unsubscribe header — nothing to unsubscribe from.");
          }

          ensureDestructiveConfirmed(config.runtime, normalizeBoolean(args.confirmed, false), `Send unsubscribe email to ${info.mailto} for message "${detail.subject}"`);
          ensureSendAllowed(config.runtime);
          // info.mailto comes from an untrusted inbound header — subject to the
          // same outbound restriction as every other send path.
          ensureOutboundRecipientsAllowed(config.runtime, config.smtp.username, [info.mailto]);

          const result = await withAudit(auditService, name, args, () =>
            bundle.smtpService.sendEmail({
              to: [info.mailto as string],
              subject: info.mailtoSubject ?? "unsubscribe",
              body: info.mailtoBody ?? "unsubscribe",
              isHtml: false,
            }),
          );

          return createTextResult({
            emailId: prefixedIdFor(bundle, detail.id),
            unsubscribedVia: info.mailto,
            messageId: result.messageId,
            accepted: result.accepted,
            rejected: result.rejected,
          });
        }

        case "send_test_email": {
          const to = requireString(args, "to");
          if (!isValidEmail(to)) {
            throw new McpError(ErrorCode.InvalidParams, "to must be a valid email address.");
          }
          const fromTest = optionalString(args, "from");
          if (fromTest && !isValidEmail(fromTest)) {
            throw new McpError(ErrorCode.InvalidParams, "from must be a valid email address.");
          }

          ensureDestructiveConfirmed(config.runtime, normalizeBoolean(args.confirmed, false), `Send test email to ${to}`);
          ensureSendAllowed(config.runtime);
          ensureOutboundRecipientsAllowed(config.runtime, config.smtp.username, [to]);

          // Same account-routing-or-header-override fallback as send_email.
          const testSendBundle = fromTest ? accountManager.byAddress(fromTest) : undefined;
          const testSmtp = testSendBundle ? testSendBundle.smtpService : smtpService;

          const result = await withAudit(auditService, name, args, async () =>
            testSmtp.sendTestEmail(to, optionalString(args, "customMessage"), testSendBundle ? undefined : fromTest),
          );
          return createTextResult({
            messageId: result.messageId,
            accepted: result.accepted,
            rejected: result.rejected,
            response: result.response,
          });
        }

        case "reply_to_email": {
          ensureDestructiveConfirmed(config.runtime, (normalizeBoolean(args.confirmed, false) || normalizeBoolean(args.dryRun, false)), `Reply to email ${String(args.emailId ?? "?")}`);
          ensureSendAllowed(config.runtime);
          // The message being replied to might belong to a non-primary account (its
          // emailId carries that account's slug prefix) — resolve it the same way
          // every other emailId-taking tool does, and read AND send through that same
          // account by default (a `from` matching a DIFFERENT configured account still
          // wins and routes the send there instead — see sendBundleForReply below).
          const { bundle: readBundleReply, rest: emailIdReplyRest } = resolveAccountForEmailId(
            requireString(args, "emailId"),
          );
          const detail = await readBundleReply.imapService.getEmailById(emailIdReplyRest);
          const markdownBodyReply = optionalString(args, "markdownBody");
          const body = markdownBodyReply ? markdownBodyReply : requireString(args, "body");
          const isHtml = markdownBodyReply ? false : normalizeBoolean(args.isHtml, false);
          const htmlBody = markdownBodyReply ? renderMarkdown(markdownBodyReply).html : undefined;
          const replyAll = normalizeBoolean(args.replyAll, false);
          const fromNameReply = optionalString(args, "fromName");
          const fromReply = optionalString(args, "from");
          if (fromReply && !isValidEmail(fromReply)) {
            throw new McpError(ErrorCode.InvalidParams, "from must be a valid email address.");
          }
          const sendBundleReply = fromReply ? accountManager.byAddress(fromReply) : undefined;
          const sendBundleForReply = sendBundleReply ?? readBundleReply;
          const sanitizeHtmlReply = normalizeBoolean(args.sanitizeHtml, true);
          const attachments = optionalAttachmentList(args.attachments);
          const extraCc = parseEmails(optionalString(args, "cc"));
          const extraBcc = parseEmails(optionalString(args, "bcc"));
          const recipients = getReplyRecipients(detail, readBundleReply.config.smtp.username, replyAll, allAccountAddresses());
          const cc = uniqueAddresses([...recipients.cc, ...extraCc]);
          const to = uniqueAddresses(recipients.to);

          ensureValidEmails(to, "to");
          ensureValidEmails(cc, "cc");
          ensureValidEmails(extraBcc, "bcc");

          if (to.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, "Unable to infer reply recipient.");
          }

          const dryRunReply = normalizeBoolean(args.dryRun, false);
          const includeQuoteReply = normalizeBoolean(args.includeQuote, true);
          // Signature goes right after the user's own reply text, before the
          // quoted original — not at the very end, after the quote.
          const signedReply = applySignature(body, htmlBody, normalizeBoolean(args.appendSignature, true), isHtml);
          // With isHtml the body is HTML source, so the quoted original (untrusted text) must be HTML-escaped
          // by the HTML builder, not appended as raw plain text.
          const replyBody = includeQuoteReply
            ? (isHtml ? buildReplyHtml(detail, signedReply.body) : buildReplyText(detail, signedReply.body))
            : signedReply.body;
          // A separate htmlBody (the markdown-rendered case) needs the SAME quoted
          // original merged in — see buildReplyHtml's comment for why this was
          // previously missing entirely from the html part.
          const replyHtmlBody = includeQuoteReply && signedReply.htmlBody !== undefined
            ? buildReplyHtml(detail, signedReply.htmlBody)
            : signedReply.htmlBody;

          // Shared helper, and the sending account's own address as "self" —
          // see send_email's comment.
          ensureOutboundRecipientsAllowed(config.runtime, sendBundleForReply.config.smtp.username, [...to, ...cc, ...extraBcc]);

          if (dryRunReply) {
            return createTextResult({ dryRun: true, wouldSendTo: { to, cc, bcc: extraBcc }, subject: prefixedSubject(detail.subject, "Re:"), note: "No email was sent." }, false, [emailSource({ ...detail, id: prefixedIdFor(readBundleReply, detail.id) })]);
          }

          const replyPayload: SendEmailInput = {
              to,
              cc,
              bcc: extraBcc,
              subject: prefixedSubject(detail.subject, "Re:"),
              body: replyBody,
              isHtml,
              htmlBody: replyHtmlBody,
              fromName: fromNameReply,
              from: fromReply,
              sanitizeHtml: sanitizeHtmlReply,
              inReplyTo: detail.messageId,
              references: replyReferences(detail),
              attachments,
              // Already applied above, before quote-wrapping.
              appendSignature: false,
          };
          const undoWindowreply = resolveUndoWindowSeconds(args);
          if (undoWindowreply > 0) {
            return queueUndoSend(sendBundleForReply, replyPayload, undoWindowreply, name, args, { repliedTo: prefixedIdFor(readBundleReply, detail.id), to, cc });
          }
          const result = await withAudit(auditService, name, args, async () =>
            sendBundleForReply.smtpService.sendEmail(replyPayload),
          );

          let sentCopyTokenReply = "[sent-copy:unverified]";
          try {
            const verifyMsgId = result.messageId;
            if (verifyMsgId) {
              const scv = await verifySentCopy(sendBundleForReply.imapService, verifyMsgId);
              if (scv.found) sentCopyTokenReply = "[sent-copy:verified]";
            }
          } catch (_) {}

          return createTextResult({
            repliedTo: prefixedIdFor(readBundleReply, detail.id),
            to,
            cc,
            messageId: result.messageId,
            accepted: result.accepted,
            rejected: result.rejected,
            response: result.response,
            sentCopy: sentCopyTokenReply,
          }, false, [emailSource({ ...detail, id: prefixedIdFor(readBundleReply, detail.id) })]);
        }

        case "reply_all_email": {
          ensureDestructiveConfirmed(config.runtime, (normalizeBoolean(args.confirmed, false) || normalizeBoolean(args.dryRun, false)), `Reply-all to email ${String(args.emailId ?? "?")}`);
          ensureSendAllowed(config.runtime);
          // Same emailId account resolution as reply_to_email — see its comment.
          const { bundle: readBundleRa, rest: emailIdRaRest } = resolveAccountForEmailId(
            requireString(args, "emailId"),
          );
          const detailRa = await readBundleRa.imapService.getEmailById(emailIdRaRest);
          const markdownBodyRa = optionalString(args, "markdownBody");
          const bodyRa = markdownBodyRa ? markdownBodyRa : requireString(args, "body");
          const isHtmlRa = markdownBodyRa ? false : normalizeBoolean(args.isHtml, false);
          const htmlBodyRa = markdownBodyRa ? renderMarkdown(markdownBodyRa).html : undefined;
          const fromNameRa = optionalString(args, "fromName");
          const fromRa = optionalString(args, "from");
          if (fromRa && !isValidEmail(fromRa)) {
            throw new McpError(ErrorCode.InvalidParams, "from must be a valid email address.");
          }
          const sendBundleRa = fromRa ? accountManager.byAddress(fromRa) : undefined;
          const sendBundleForRa = sendBundleRa ?? readBundleRa;
          const sanitizeHtmlRa = normalizeBoolean(args.sanitizeHtml, true);
          const attachmentsRa = optionalAttachmentList(args.attachments);
          const extraCcRa = parseEmails(optionalString(args, "cc"));
          const extraBccRa = parseEmails(optionalString(args, "bcc"));
          const recipientsRa = getReplyRecipients(detailRa, readBundleRa.config.smtp.username, true, allAccountAddresses());
          const ccRa = uniqueAddresses([...recipientsRa.cc, ...extraCcRa]);
          const toRa = uniqueAddresses(recipientsRa.to);

          ensureValidEmails(toRa, "to");
          ensureValidEmails(ccRa, "cc");
          ensureValidEmails(extraBccRa, "bcc");

          if (toRa.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, "Unable to infer reply recipients.");
          }

          const dryRunRa = normalizeBoolean(args.dryRun, false);
          // Shared helper, and the sending account's own address as "self" —
          // see send_email's comment.
          ensureOutboundRecipientsAllowed(config.runtime, sendBundleForRa.config.smtp.username, [...toRa, ...ccRa, ...extraBccRa]);
          if (dryRunRa) {
            return createTextResult({ dryRun: true, wouldSendTo: { to: toRa, cc: ccRa, bcc: extraBccRa }, subject: prefixedSubject(detailRa.subject, "Re:"), note: "No email was sent." });
          }

          const includeQuoteRa = normalizeBoolean(args.includeQuote, true);
          // Signature goes right after the user's own reply text, before the
          // quoted original — not at the very end, after the quote.
          const signedReplyRa = applySignature(bodyRa, htmlBodyRa, normalizeBoolean(args.appendSignature, true), isHtmlRa);
          const replyBodyRa = includeQuoteRa
            ? (isHtmlRa ? buildReplyHtml(detailRa, signedReplyRa.body) : buildReplyText(detailRa, signedReplyRa.body))
            : signedReplyRa.body;
          // Same fix as reply_to_email — see buildReplyHtml's comment.
          const replyHtmlBodyRa = includeQuoteRa && signedReplyRa.htmlBody !== undefined
            ? buildReplyHtml(detailRa, signedReplyRa.htmlBody)
            : signedReplyRa.htmlBody;

          const replyAllPayload: SendEmailInput = {
              to: toRa,
              cc: ccRa,
              bcc: extraBccRa,
              subject: prefixedSubject(detailRa.subject, "Re:"),
              body: replyBodyRa,
              isHtml: isHtmlRa,
              htmlBody: replyHtmlBodyRa,
              fromName: fromNameRa,
              from: fromRa,
              sanitizeHtml: sanitizeHtmlRa,
              inReplyTo: detailRa.messageId,
              references: detailRa.messageId ? [detailRa.messageId] : undefined,
              attachments: attachmentsRa,
              // Already applied above, before quote-wrapping.
              appendSignature: false,
          };
          const undoWindowreplyAll = resolveUndoWindowSeconds(args);
          if (undoWindowreplyAll > 0) {
            return queueUndoSend(sendBundleForRa, replyAllPayload, undoWindowreplyAll, name, args, { repliedTo: prefixedIdFor(readBundleRa, detailRa.id), to: toRa, cc: ccRa });
          }
          const resultRa = await withAudit(auditService, name, args, async () =>
            sendBundleForRa.smtpService.sendEmail(replyAllPayload),
          );

          let sentCopyTokenRa = "[sent-copy:unverified]";
          try {
            const verifyMsgId = resultRa.messageId;
            if (verifyMsgId) {
              const scv = await verifySentCopy(sendBundleForRa.imapService, verifyMsgId);
              if (scv.found) sentCopyTokenRa = "[sent-copy:verified]";
            }
          } catch (_) {}

          return createTextResult({
            repliedTo: prefixedIdFor(readBundleRa, detailRa.id),
            to: toRa,
            cc: ccRa,
            messageId: resultRa.messageId,
            accepted: resultRa.accepted,
            rejected: resultRa.rejected,
            response: resultRa.response,
            sentCopy: sentCopyTokenRa,
          }, false, [emailSource({ ...detailRa, id: prefixedIdFor(readBundleRa, detailRa.id) })]);
        }

        case "create_template":
        case "list_templates":
        case "get_template":
        case "delete_template":
        case "render_template":
        case "set_autoresponder":
        case "get_autoresponder":
        case "set_reply_reminder":
        case "list_reply_reminders":
        case "cancel_reply_reminder":
        case "snooze_email":
        case "cancel_snooze":
        case "list_snoozed":
          return await handleTemplateAndReminderTool(name, args, ctx);

        case "respond_to_invite": {
          ensureDestructiveConfirmed(config.runtime, (normalizeBoolean(args.confirmed, false) || normalizeBoolean(args.dryRun, false)), `Answer calendar invitation ${String(args.emailId ?? "?")}`);
          ensureSendAllowed(config.runtime);
          const { bundle: inviteBundle, rest: inviteEmailId } = resolveAccountForEmailId(requireString(args, "emailId"));
          const responseArg = requireString(args, "response");
          if (responseArg !== "accept" && responseArg !== "decline" && responseArg !== "tentative") {
            throw new McpError(ErrorCode.InvalidParams, "response must be accept, decline or tentative.");
          }
          const inviteComment = optionalString(args, "comment");
          if (inviteComment !== undefined && inviteComment.length > 1000) {
            throw new McpError(ErrorCode.InvalidParams, "comment must be at most 1000 characters.");
          }
          const inviteDetail = await inviteBundle.imapService.getEmailById(inviteEmailId);
          const candidates = (inviteDetail.attachments ?? []).filter(
            (attachment) =>
              Boolean(attachment.id) &&
              (attachment.isCalendarInvite || attachment.kind === "calendar" || /text\/calendar/i.test(attachment.contentType ?? "") || /\.ics$/i.test(attachment.filename ?? "")),
          );
          if (candidates.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, "This message has no calendar invitation attachment.");
          }
          let invite: ParsedInvite | undefined;
          let inviteProblem: string | undefined;
          for (const candidate of candidates) {
            const content = await inviteBundle.imapService.getAttachmentContent(inviteEmailId, candidate.id as string, { includeBase64: true });
            try {
              invite = parseInvite(Buffer.from(content.base64 ?? "", "base64").toString("utf8"));
              break;
            } catch (error) {
              if (!(error instanceof InviteError)) throw error;
              inviteProblem ??= error.message;
            }
          }
          if (!invite) {
            throw new McpError(ErrorCode.InvalidParams, inviteProblem ?? "No invitation could be read from this message.");
          }
          // Answer as the account that holds the message. Only an attendee address that is exactly one of our
          // accounts is used; a "+tag" or alias address in a hostile invite never picks the sender.
          const myAttendee = findMyAttendee(invite, (address) => address.toLowerCase() === inviteBundle.config.smtp.username.toLowerCase());
          // Never another account: a hostile invitation could otherwise make a different mailbox answer it.
          const inviteSendBundle = inviteBundle;
          const answeringAs = inviteSendBundle.config.smtp.username;
          const inviteReply = buildInviteReply(invite, {
            attendeeAddress: answeringAs,
            attendeeName: myAttendee?.name,
            response: responseArg,
            comment: inviteComment,
          });
          const inviteTo = [inviteReply.to];
          ensureValidEmails(inviteTo, "to");
          ensureOutboundRecipientsAllowed(config.runtime, inviteSendBundle.config.smtp.username, inviteTo);
          const senderDomains = (inviteDetail.from ?? []).map((entry) => (entry.address ?? "").split("@").pop()?.toLowerCase());
          const organizerDomain = invite.organizer.address.split("@").pop()?.toLowerCase();
          const organizerMismatch = !senderDomains.includes(organizerDomain) && !CALENDAR_RELAY_DOMAINS.has(organizerDomain ?? "");
          const inviteSummary = {
            event: invite.summary ?? "(no title)",
            ...(organizerMismatch
              ? { warning: `The organizer (${invite.organizer.address}) is not the sender of this message; the answer goes to the organizer, so check that you trust them.` }
              : {}),
            organizer: invite.organizer.address,
            answeringAs,
            response: responseArg,
            previousStatus: myAttendee?.partstat,
            ...(invite.hasRecurrence ? { note: "This invitation repeats; the answer applies to the whole series." } : {}),
          };
          if (normalizeBoolean(args.dryRun, false)) {
            return createTextResult({ dryRun: true, wouldSendTo: inviteTo, subject: inviteReply.subject, ...inviteSummary, replyCalendar: inviteReply.ics.split("\r\n").filter(Boolean), note: "No email was sent." });
          }
          const invitePayload: SendEmailInput = {
            to: inviteTo,
            subject: inviteReply.subject,
            body: inviteReply.body,
            from: inviteSendBundle.config.smtp.username === answeringAs ? undefined : answeringAs,
            inReplyTo: inviteDetail.messageId,
            references: replyReferences(inviteDetail),
            icalEvent: { method: "REPLY", content: inviteReply.ics },
            appendSignature: false,
          };
          const inviteUndo = resolveUndoWindowSeconds(args);
          if (inviteUndo > 0) {
            return queueUndoSend(inviteSendBundle, invitePayload, inviteUndo, name, args, { to: inviteTo, ...inviteSummary });
          }
          const inviteResult = await withAudit(auditService, name, args, async () =>
            inviteSendBundle.smtpService.sendEmail(invitePayload),
          );
          return createTextResult({
            ...inviteSummary,
            to: inviteTo,
            subject: inviteReply.subject,
            messageId: inviteResult.messageId,
            accepted: inviteResult.accepted,
            rejected: inviteResult.rejected,
            response_: inviteResult.response,
          }, false, [emailSource({ ...inviteDetail, id: prefixedIdFor(inviteBundle, inviteDetail.id) })]);
        }

        case "forward_email": {
          ensureDestructiveConfirmed(config.runtime, (normalizeBoolean(args.confirmed, false) || normalizeBoolean(args.dryRun, false)), `Forward email ${String(args.emailId ?? "?")} to ${String(args.to ?? "?")}`);
          ensureSendAllowed(config.runtime);
          // Same emailId account resolution as reply_to_email — see its comment.
          const { bundle: readBundleFwd, rest: emailIdFwdRest } = resolveAccountForEmailId(
            requireString(args, "emailId"),
          );
          const detail = await readBundleFwd.imapService.getEmailById(emailIdFwdRest);
          const to = parseEmails(requireString(args, "to"));
          const cc = parseEmails(optionalString(args, "cc"));
          const bcc = parseEmails(optionalString(args, "bcc"));
          const markdownBodyFwd = optionalString(args, "markdownBody");
          const body = markdownBodyFwd ?? optionalString(args, "body");
          const isHtml = markdownBodyFwd ? false : normalizeBoolean(args.isHtml, false);
          const htmlBody = markdownBodyFwd ? renderMarkdown(markdownBodyFwd).html : undefined;
          const fromNameFwd = optionalString(args, "fromName");
          const fromFwd = optionalString(args, "from");
          if (fromFwd && !isValidEmail(fromFwd)) {
            throw new McpError(ErrorCode.InvalidParams, "from must be a valid email address.");
          }
          const sendBundleFwd = fromFwd ? accountManager.byAddress(fromFwd) : undefined;
          const sendBundleForFwd = sendBundleFwd ?? readBundleFwd;
          const sanitizeHtmlFwd = normalizeBoolean(args.sanitizeHtml, true);
          // args.attachments are new attachments the caller wants to add to the
          // forward — they are NOT the original message's attachments. Despite
          // the tool's own description ("preserving original attachments") and
          // includeAttachments defaulting to true, nothing here ever fetched the
          // original attachments themselves, so every forward silently dropped
          // them unless the caller had already fetched and resupplied their
          // content manually. attachmentParts was accepted in the schema and
          // documented but never read at all. Found live: forwarding a fixture
          // with one attachment produced a forward with zero attachments.
          const attachments = optionalAttachmentList(args.attachments) ?? [];
          const includeAttachments = normalizeBoolean(args.includeAttachments, true);
          const attachmentParts = Array.isArray(args.attachmentParts)
            ? (args.attachmentParts as unknown[]).map(String)
            : undefined;

          ensureValidEmails(to, "to");
          ensureValidEmails(cc, "cc");
          ensureValidEmails(bcc, "bcc");

          const dryRunFwd = normalizeBoolean(args.dryRun, false);
          // Shared helper, and the sending account's own address as "self" —
          // see send_email's comment.
          ensureOutboundRecipientsAllowed(config.runtime, sendBundleForFwd.config.smtp.username, [...to, ...cc, ...bcc]);
          if (dryRunFwd) {
            return createTextResult({ dryRun: true, wouldSendTo: { to, cc, bcc }, subject: prefixedSubject(detail.subject, "Fwd:"), note: "No email was sent." });
          }

          // args.attachments are new attachments the caller wants to add to the
          // forward — they are NOT the original message's attachments. Despite
          // the tool's own description ("preserving original attachments") and
          // includeAttachments defaulting to true, nothing here ever fetched the
          // original attachments themselves, so every forward silently dropped
          // them unless the caller had already fetched and resupplied their
          // content manually. attachmentParts was accepted in the schema and
          // documented but never read at all. Found live: forwarding a fixture
          // with one attachment produced a forward with zero attachments.
          const originalAttachments = includeAttachments
            ? await Promise.all(
                detail.attachments
                  .filter((a) => a.id && (!attachmentParts || (a.part !== undefined && attachmentParts.includes(a.part))))
                  .map((a) => readBundleFwd.imapService.getAttachmentForForward(detail.id, a.id as string)),
              )
            : [];
          const fwdAttachments = [...originalAttachments, ...attachments];

          // Signature goes right after the user's own note, before the
          // "---------- Forwarded message ---------" block — not at the very
          // end, after the forwarded content.
          const signedFwd = applySignature(body ?? "", htmlBody, normalizeBoolean(args.appendSignature, true), isHtml);
          // Same fix as reply_to_email/reply_all_email — see buildReplyHtml's
          // comment (applies equally to a markdown-authored forward's separate
          // htmlBody, which buildForwardText never touches).
          const forwardHtmlBody = signedFwd.htmlBody !== undefined
            ? buildForwardHtml(detail, signedFwd.htmlBody)
            : signedFwd.htmlBody;

          const forwardPayload: SendEmailInput = {
              to,
              cc,
              bcc,
              subject: prefixedSubject(detail.subject, "Fwd:"),
              body: isHtml ? buildForwardHtml(detail, signedFwd.body) : buildForwardText(detail, signedFwd.body),
              isHtml,
              htmlBody: forwardHtmlBody,
              fromName: fromNameFwd,
              from: fromFwd,
              sanitizeHtml: sanitizeHtmlFwd,
              attachments: fwdAttachments,
              // Already applied above, before quote-wrapping.
              appendSignature: false,
          };
          const undoWindowforward = resolveUndoWindowSeconds(args);
          if (undoWindowforward > 0) {
            return queueUndoSend(sendBundleForFwd, forwardPayload, undoWindowforward, name, args, { forwardedMessage: prefixedIdFor(readBundleFwd, detail.id), to, cc });
          }
          const result = await withAudit(auditService, name, args, async () =>
            sendBundleForFwd.smtpService.sendEmail(forwardPayload),
          );

          let sentCopyTokenFwd = "[sent-copy:unverified]";
          try {
            const verifyMsgId = result.messageId;
            if (verifyMsgId) {
              const scv = await verifySentCopy(sendBundleForFwd.imapService, verifyMsgId);
              if (scv.found) sentCopyTokenFwd = "[sent-copy:verified]";
            }
          } catch (_) {}

          return createTextResult({
            forwardedMessage: prefixedIdFor(readBundleFwd, detail.id),
            to,
            cc,
            messageId: result.messageId,
            accepted: result.accepted,
            rejected: result.rejected,
            response: result.response,
            sentCopy: sentCopyTokenFwd,
          }, false, [emailSource({ ...detail, id: prefixedIdFor(readBundleFwd, detail.id) })]);
        }

        case "create_draft": {
          // Local draft write — was only gated on the remote-sync side, so
          // PROTONMAIL_READ_ONLY never actually stopped a local draft being created.
          ensureMailboxWriteAllowed(config.runtime);
          const to = parseEmails(optionalString(args, "to"));
          const cc = parseEmails(optionalString(args, "cc"));
          const bcc = parseEmails(optionalString(args, "bcc"));
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
          const extraCc = parseEmails(optionalString(args, "cc"));
          const extraBcc = parseEmails(optionalString(args, "bcc"));
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
          const to = parseEmails(requireString(args, "to"));
          const cc = parseEmails(optionalString(args, "cc"));
          const bcc = parseEmails(optionalString(args, "bcc"));
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
          const to = args.to === undefined ? undefined : parseEmails(optionalString(args, "to"));
          const cc = args.cc === undefined ? undefined : parseEmails(optionalString(args, "cc"));
          const bcc = args.bcc === undefined ? undefined : parseEmails(optionalString(args, "bcc"));
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
            await sendDraftBundle.draftStore.revertSending(draft.id);
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

        case "get_emails": {
          const effectiveLimit = normalizeLimit(args.limit, 50);
          const getEmailsInput = {
            folder: optionalString(args, "folder"),
            limit: effectiveLimit,
            offset: optionalInteger(args.offset, 0, 1_000_000),
            beforeUid: typeof args?.beforeUid === "number" ? args.beforeUid : undefined,
            sortByUid: (args?.sortByUid === "asc" || args?.sortByUid === "desc" ? args.sortByUid : undefined) as "asc" | "desc" | undefined,
            includeSnippet: normalizeBoolean(args.includeSnippet, false),
          };
          if (accountManager.all().length === 1) {
            resolveAccountArg(args);
            const result = await imapService.getEmails(getEmailsInput);
            return createTextResult(
              {
                ...result,
                emails: projectFields(result.emails, parseFieldsArg(args.fields)),
                returned: result.emails.length,
                hasMore: result.emails.length === effectiveLimit,
              },
              false,
              result.emails.map(emailSource),
            );
          }
          // Merge strategy: an `offset` applied separately to each account's own page
          // BEFORE merging is wrong — e.g. offset=25,limit=25 (page 2) would skip each
          // account's own first 25 messages independently, then concatenate their
          // page-2 results, which is not the same as page 2 of the globally-merged,
          // newest-first timeline (found live with interleaved messages across two
          // accounts: page 2 skipped the second-newest message overall). Fixed by
          // always fetching from offset 0 up to (requestedOffset + limit) from EVERY
          // account — enough that each account's true contribution to the global top
          // (requestedOffset + limit) is fully captured, since getEmails already
          // returns newest-first — then merging, re-sorting, and applying the
          // requested offset/limit to that merged superset instead of per account.
          const primarySlug = accountManager.primary().account.slug;
          const requestedOffset = getEmailsInput.offset ?? 0;
          // +1 beyond what's strictly needed to fill the page: whether that extra
          // item actually comes back is what tells us hasMore, independent of any
          // filter (beforeUid etc.) or of how the raw mailbox total compares to the
          // page window. Two things were tried and each broke a different case:
          // (1) using mergedAll.length > offset+limit as hasMore, with NO extra
          // overfetch — a lopsided distribution (e.g. 300 messages in one account,
          // 0 in another) fetches exactly offset+limit from the big account, so
          // mergedAll.length can never exceed that window even though hundreds
          // more exist, reporting hasMore:false wrongly.
          // (2) using the raw summed mailbox `total` for hasMore instead — correct
          // for that case, but wrong under a restrictive filter like beforeUid:
          // `total` is the UNFILTERED mailbox message count, not the count of
          // messages actually matching the filter, so a beforeUid narrowing 300
          // messages down to 2 matches still compared against total=300 and
          // reported hasMore:true with nothing left to page to.
          // Fetching one extra item fixes both: it directly observes whether a
          // NEXT matching item exists, under whatever filter is active, rather
          // than inferring it from a count that can be either capped-by-fetch or
          // filter-blind depending on which one you pick.
          const perAccountFetchLimit = requestedOffset + effectiveLimit + 1;
          const perAccount = await Promise.all(
            selectedBundles(args).map(async (bundle) => {
              const result = await bundle.imapService.getEmails({ ...getEmailsInput, offset: 0, limit: perAccountFetchLimit });
              return { bundle, result };
            }),
          );
          const taggedEmails = perAccount.flatMap(({ bundle, result }) =>
            result.emails.map((email) => ({ ...email, id: withAccountPrefix(accountSlugForTag(bundle, primarySlug), email.id) })),
          );
          const mergedAll = sortByDateDesc(taggedEmails, (email) => email.internalDate || email.date);
          const { page: merged, hasMore } = paginateMergedAccountResults(mergedAll, requestedOffset, effectiveLimit);
          const total = perAccount.reduce((sum, { result }) => sum + result.total, 0);
          return createTextResult(
            {
              folder: getEmailsInput.folder?.trim() || "INBOX",
              total,
              limit: effectiveLimit,
              offset: requestedOffset,
              emails: projectFields(merged, parseFieldsArg(args.fields)),
              returned: merged.length,
              hasMore,
              byAccount: perAccount.map(({ bundle, result }) => ({ slug: bundle.account.slug, total: result.total })),
            },
            false,
            merged.map(emailSource),
          );
        }

        case "get_email_by_id": {
          const rawEmailId = requireString(args, "emailId");
          const { bundle, rest: emailId } = resolveAccountForEmailId(rawEmailId);
          const detail = await bundle.imapService.getEmailById(emailId);
          const preferHtml = normalizeBoolean(args.preferHtml, false);
          const maxBodyLength = normalizeLimit(args.maxBodyLength, undefined as unknown as number, 1, 500_000);
          const showHeaders = normalizeBoolean(args.showHeaders, false);

          const output = formatEmailDetailOutput(detail, preferHtml, maxBodyLength);
          // formatEmailDetailOutput always strips the full raw header map (needless
          // token bloat by default) — re-add it only when explicitly requested.
          // showHeaders already existed but previously only added a 2-field duplicate
          // on top without ever removing the always-present full map.
          if (showHeaders) output.headers = detail.headers;

          const prefixedEmailId = prefixedIdFor(bundle, detail.id);
          output.id = prefixedEmailId;
          return createTextResult(output, false, [emailSource({ ...detail, id: prefixedEmailId }), ...detail.attachments.map((attachment) => attachmentSource(prefixedEmailId, attachment))]);
        }

        case "get_emails_by_ids": {
          const emailIds = [...new Set(parseStringListArg(args, "emailIds"))];
          if (emailIds.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, "emailIds must contain at least one email id.");
          }
          if (emailIds.length > 25) {
            throw new McpError(ErrorCode.InvalidParams, `get_emails_by_ids: maximum 25 email IDs per call, got ${emailIds.length}. Split into multiple calls.`);
          }
          const preferHtml = normalizeBoolean(args.preferHtml, false);
          const maxBodyLength = normalizeLimit(args.maxBodyLength, undefined as unknown as number, 1, 500_000);

          // Found live (external review): every id went straight to the primary
          // account's imapService regardless of its own "<slug>::" prefix, so a
          // non-primary account's id in the list either resolved the wrong
          // message on primary or (more often) just failed to be found — the
          // list [primaryId, secondary::id] reported succeeded:1 instead of 2.
          // Each id is now resolved to its own account first, same as every
          // other emailId-taking tool, and the returned id keeps its prefix.
          const results = await Promise.all(
            emailIds.map(async (emailId) => {
              try {
                const { bundle, rest } = resolveAccountForEmailId(emailId);
                const detail = await bundle.imapService.getEmailById(rest);
                const output = formatEmailDetailOutput(detail, preferHtml, maxBodyLength);
                output.id = prefixedIdFor(bundle, detail.id);
                return { emailId, ok: true as const, email: output };
              } catch (error) {
                return { emailId, ok: false as const, error: error instanceof Error ? error.message : String(error) };
              }
            }),
          );

          const sources = results.flatMap((entry) =>
            entry.ok ? [emailSource(entry.email as unknown as Parameters<typeof emailSource>[0])] : [],
          );
          return createTextResult(
            { requested: emailIds.length, succeeded: results.filter((entry) => entry.ok).length, results },
            false,
            sources,
          );
        }

        case "search_emails": {
          const effectiveLimit = normalizeLimit(args.limit, 50);
          try {
            const searchAccount = resolveAccountArg(args);
            const liveSearchInput = {
              query: optionalString(args, "query"),
              folder: optionalString(args, "folder"),
              label: optionalString(args, "label"),
              threadId: optionalString(args, "threadId"),
              from: optionalString(args, "from"),
              to: optionalString(args, "to"),
              senderDomain: optionalString(args, "senderDomain"),
              mailboxRole: optionalString(args, "mailboxRole"),
              messageId: optionalString(args, "messageId"),
              cc: optionalString(args, "cc"),
              bcc: optionalString(args, "bcc"),
              subject: optionalString(args, "subject"),
              hasAttachment:
                optionalBoolean(args.hasAttachment),
              attachmentName: optionalString(args, "attachmentName"),
              isRead: optionalBoolean(args.isRead),
              isStarred: optionalBoolean(args.isStarred),
              dateFrom: optionalString(args, "dateFrom"),
              dateTo: optionalString(args, "dateTo"),
              sizeLarger: optionalNumber(args.sizeLarger, 0, Number.MAX_SAFE_INTEGER),
              sizeSmaller: optionalNumber(args.sizeSmaller, 0, Number.MAX_SAFE_INTEGER),
              listId: optionalString(args, "listId"),
              limit: effectiveLimit,
              includeSnippet: normalizeBoolean(args.includeSnippet, false),
            };
            let result: Awaited<ReturnType<typeof imapService.searchEmails>>;
            let liveHasMore = false;
            let liveFailedAccounts: Array<{ account: string; error: string }> = [];
            if (accountManager.all().length === 1) {
              result = await imapService.searchEmails(liveSearchInput);
              // The service also knows when it cut its candidates short (e.g. the non-ASCII scan checks
              // only the newest 500), which a full page alone does not show.
              liveHasMore = result.hasMore || result.emails.length === effectiveLimit;
            } else {
              // Merge strategy (mirrors search_indexed_emails): each account has its own
              // single IMAP connection, so search the selected accounts strictly one after
              // another, tag non-primary ids with the account slug, re-sort newest-first
              // and re-apply the limit across the merged set.
              const primarySlugForLive = accountManager.primary().account.slug;
              const targets = searchAccount ? [searchAccount] : accountManager.all();
              const perAccountLive: Array<{ bundle: AccountBundle; result: Awaited<ReturnType<typeof imapService.searchEmails>> }> = [];
              const failedAccounts: Array<{ account: string; error: string }> = [];
              let firstFailure: unknown;
              for (const bundle of targets) {
                try {
                  perAccountLive.push({ bundle, result: await bundle.imapService.searchEmails(liveSearchInput) });
                } catch (error) {
                  // An implicit all-accounts search must not fail because ONE account is unreachable or
                  // lacks the requested folder/label; report it and return the rest. An explicit
                  // `account`, a bad argument (dates), or every account failing still throws.
                  const invalidArgument = error instanceof Error && error.message.includes("Invalid date");
                  if (searchAccount || invalidArgument || targets.length === 1) throw error;
                  firstFailure ??= error;
                  failedAccounts.push({ account: bundle.account.slug, error: error instanceof Error ? error.message : String(error) });
                }
              }
              if (perAccountLive.length === 0) throw firstFailure;
              liveFailedAccounts = failedAccounts;
              const tagged = perAccountLive.flatMap(({ bundle, result: r }) =>
                r.emails.map((email) => ({ ...email, id: withAccountPrefix(accountSlugForTag(bundle, primarySlugForLive), email.id) })),
              );
              const merged = sortByDateDesc(tagged, (email) => email.internalDate || email.date).slice(0, effectiveLimit);
              result = {
                folders: [...new Set(perAccountLive.flatMap(({ result: r }) => r.folders))],
                limit: effectiveLimit,
                total: perAccountLive.reduce((sum, { result: r }) => sum + r.total, 0),
                totalMatched: perAccountLive.reduce((sum, { result: r }) => sum + r.totalMatched, 0),
                hasMore: false,
                emails: merged,
              };
              liveHasMore = merged.length === effectiveLimit || perAccountLive.some(({ result: r }) => r.hasMore);
            }
            return createTextResult(
              {
                ...result,
                emails: projectFields(result.emails, parseFieldsArg(args.fields)),
                returned: result.emails.length,
                hasMore: liveHasMore,
                ...(liveFailedAccounts.length > 0 ? { failedAccounts: liveFailedAccounts } : {}),
              },
              false,
              result.emails.map(emailSource),
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes("Invalid date")) {
              throw new McpError(ErrorCode.InvalidParams, message);
            }
            throw error;
          }
        }

        case "update_message_labels": {
          ensureMailboxWriteAllowed(config.runtime);
          const rawEmailId = requireString(args, "emailId");
          const { bundle, rest: emailId } = resolveAccountForEmailId(rawEmailId);
          const labelsToAdd = Array.isArray(args.labelsToAdd)
            ? (args.labelsToAdd as unknown[]).map(String)
            : [];
          const labelsToRemove = Array.isArray(args.labelsToRemove)
            ? (args.labelsToRemove as unknown[]).map(String)
            : [];
          if (labelsToAdd.length === 0 && labelsToRemove.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, "Provide at least one label in labelsToAdd or labelsToRemove.");
          }
          // undefined for an old-format id (no embedded UIDVALIDITY) —
          // updateMessageLabels's own assertMailboxUidValidity guard already
          // treats that as "unverifiable, don't block on it", same as every
          // other mutation handler below.
          const uidValidity = parseEmailId(emailId).uidValidity;
          const result = await withAudit(auditService, name, args, async () =>
            bundle.imapService.updateMessageLabels(emailId, labelsToAdd, labelsToRemove, uidValidity),
          );
          return createTextResult(result, false, [emailSource({ id: prefixedIdFor(bundle, emailId) } as Parameters<typeof emailSource>[0])]);
        }

        case "update_message_flags": {
          const rawEmailId = requireString(args, "emailId");
          const { bundle, rest: emailId } = resolveAccountForEmailId(rawEmailId);
          const flagsToAdd = Array.isArray(args.flagsToAdd)
            ? (args.flagsToAdd as unknown[]).map(String)
            : [];
          const flagsToRemove = Array.isArray(args.flagsToRemove)
            ? (args.flagsToRemove as unknown[]).map(String)
            : [];
          if (flagsToAdd.length === 0 && flagsToRemove.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, "Provide at least one flag in flagsToAdd or flagsToRemove.");
          }
          ensureFlagChangeAllowed(config.runtime, flagsToAdd, flagsToRemove, normalizeBoolean(args.confirmed, false));
          const uidValidity = parseEmailId(emailId).uidValidity;
          const result = await withAudit(auditService, name, args, async () =>
            bundle.imapService.updateMessageFlags(emailId, flagsToAdd, flagsToRemove, uidValidity),
          );
          return createTextResult(result, false, [emailSource({ id: prefixedIdFor(bundle, emailId) } as Parameters<typeof emailSource>[0])]);
        }

        case "count_messages": {
          const countInput = {
            folder: optionalString(args, "folder"),
            query: optionalString(args, "query"),
            from: optionalString(args, "from"),
            to: optionalString(args, "to"),
            subject: optionalString(args, "subject"),
            hasAttachment:
              optionalBoolean(args.hasAttachment),
            label: optionalString(args, "label"),
            threadId: optionalString(args, "threadId"),
            senderDomain: optionalString(args, "senderDomain"),
            isRead: optionalBoolean(args.isRead),
            isStarred: optionalBoolean(args.isStarred),
            dateFrom: optionalString(args, "dateFrom"),
            dateTo: optionalString(args, "dateTo"),
            sizeLarger: optionalNumber(args.sizeLarger, 0, Number.MAX_SAFE_INTEGER),
            sizeSmaller: optionalNumber(args.sizeSmaller, 0, Number.MAX_SAFE_INTEGER),
          };
          if (accountManager.all().length === 1) {
            resolveAccountArg(args);
            const result = await imapService.countMessages(countInput);
            return createTextResult(result);
          }
          // Merge strategy: count in every account's mailbox and sum — folder is
          // reported from the request (all accounts are counted against the same
          // folder name), with a per-account breakdown alongside the total.
          // One account lacking the folder or label (or unreachable) must not fail the whole count, as in
          // search_emails: report it and return the rest. Every account failing still throws.
          const settled = await Promise.allSettled(
            selectedBundles(args).map(async (bundle) => ({
              slug: bundle.account.slug,
              ...(await bundle.imapService.countMessages(countInput)),
            })),
          );
          const perAccount = settled.flatMap((entry) => (entry.status === "fulfilled" ? [entry.value] : []));
          if (perAccount.length === 0) {
            throw (settled[0] as PromiseRejectedResult).reason;
          }
          const failedAccounts = settled.flatMap((entry, index) =>
            entry.status === "rejected"
              ? [{ account: selectedBundles(args)[index].account.slug, error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason) }]
              : [],
          );
          return createTextResult({
            folder: countInput.folder ?? "INBOX",
            count: perAccount.reduce((sum, entry) => sum + entry.count, 0),
            ...(perAccount.some((entry) => entry.approximate) ? { approximate: true } : {}),
            ...(failedAccounts.length > 0 ? { failedAccounts } : {}),
            byAccount: perAccount,
          });
        }

        case "folder_stats": {
          const folderStatsFolder = optionalString(args, "folder");
          if (accountManager.all().length === 1) {
            resolveAccountArg(args);
            const result = await imapService.getFolderStats(folderStatsFolder);
            return createTextResult(result);
          }
          // Merge strategy: fetch stats for the same folder in every account and
          // sum the numeric fields (total/unseen); uidNext/uidValidity are
          // per-account concepts and only make sense in the breakdown.
          const perAccount = await Promise.all(
            selectedBundles(args).map(async (bundle) => ({
              slug: bundle.account.slug,
              ...(await bundle.imapService.getFolderStats(folderStatsFolder)),
            })),
          );
          return createTextResult({
            folder: folderStatsFolder ?? "INBOX",
            total: perAccount.reduce((sum, entry) => sum + entry.total, 0),
            unseen: perAccount.reduce((sum, entry) => sum + entry.unseen, 0),
            byAccount: perAccount,
          });
        }

        case "empty_folder": {
          if (!config.runtime.allowEmptyFolder) {
            throw new McpError(
              ErrorCode.InvalidParams,
              "empty_folder is disabled. Set PROTONMAIL_ALLOW_EMPTY_FOLDER=true to enable.",
            );
          }
          ensureEmailActionAllowed(config.runtime, "delete");
          const { bundle: emptyBundle, paths: [folder] } = resolveFolderTarget(args, requireString(args, "folder"));
          const confirmed = normalizeBoolean(args.confirmed, false);
          if (!confirmed) {
            ensureDestructiveConfirmed(config.runtime, confirmed, "Delete all messages in folder " + folder);
            const stats = await emptyBundle.imapService.getFolderStats(folder);
            return createTextResult({
              preview: true,
              folder,
              wouldDelete: stats.total,
              message: `This would permanently delete ${stats.total} messages from "${folder}". Call again with confirmed:true to execute.`,
            });
          }
          ensureDestructiveConfirmed(config.runtime, confirmed, "Delete all messages in folder " + folder);
          const result = await withAudit(emptyBundle.auditService, name, args, async () =>
            emptyBundle.imapService.emptyFolder(folder),
          );
          return createTextResult(result);
        }

        case "bulk_move": {
          ensureEmailActionAllowed(config.runtime, "move");
          const emailIds = Array.isArray(args.emailIds)
            ? (args.emailIds as unknown[]).map(String) : undefined;
          const match = args.match && typeof args.match === "object"
            ? (args.match as BulkMatchCriteria) : undefined;
          if (emailIds && emailIds.length === 0) throw new McpError(ErrorCode.InvalidParams, "emailIds must contain at least one email id.");
          if (!emailIds && !match) throw new McpError(ErrorCode.InvalidParams, "Provide emailIds or match.");
          if (emailIds && match) throw new McpError(ErrorCode.InvalidParams, "Provide emailIds OR match, not both.");
          const folder = optionalString(args, "folder") ?? "INBOX";
          const targetFolder = requireString(args, "targetFolder");
          await ensureMoveTargetAllowed(config.runtime, accountManager.all().map((entry) => entry.imapService), targetFolder);
          const max = getBulkMaxBatchSize(args);
          const dryRun = normalizeBoolean(args.dryRun, false);

          // emailIds can span multiple configured accounts (a "<slug>::"
          // prefix names one; a plain id is the primary's) — group them so
          // each account's ids resolve/run against that account's own
          // imapService, then merge the per-group results back below. A
          // match-only call (no emailIds) has no account identity to group
          // by, so it stays scoped to the primary account, unchanged.
          const groups = emailIds
            ? groupEmailIdsByAccount(accountManager, emailIds)
            : new Map<string | undefined, { bundle: AccountBundle; restIds: string[] | undefined }>([
                [undefined, { bundle: primaryBundle, restIds: undefined }],
              ]);

          let totalUids = 0;
          const prepared: Array<{
            slug: string | undefined;
            bundle: AccountBundle;
            notFound: BulkExcludedEmailId[];
            run: () => Promise<BulkOperationResult>;
          }> = [];
          for (const [slug, group] of groups) {
            // Only fetched (an extra STATUS round trip) when there are ids to
            // check against it — a match-only bulk_move has no ids that could
            // be stale, since match resolves directly against the live
            // mailbox each time.
            const currentUidValidity = await group.bundle.imapService.getMailboxUidValidity(folder);
            const notFoundEmailIds = getBulkNotFoundEmailIds(group.restIds, folder, currentUidValidity);
            // Resolve the match/emailIds set exactly once and reuse it for both
            // the preview and the real run — see resolveUidsForBulkOp's
            // comment for why re-resolving `match` a second time (the old
            // dry-run-then-real-run pattern) could silently exceed maxBatchSize.
            // Also excludes any id whose embedded UIDVALIDITY is stale.
            const uids = await group.bundle.imapService.resolveUidsForBulkOp(folder, group.restIds, match, currentUidValidity);
            totalUids += uids.length;
            prepared.push({
              slug,
              bundle: group.bundle,
              notFound: notFoundEmailIds,
              run: () =>
                group.bundle.imapService.bulkMove({
                  emailIds: group.restIds,
                  match,
                  folder,
                  targetFolder,
                  resolvedUids: uids,
                  uidValidity: currentUidValidity,
                  dryRun,
                }),
            });
          }
          ensureBulkBatchSize(totalUids, max);

          const outputs: BulkOperationResult[] = [];
          for (const group of prepared) {
            const outputSlug = group.slug === primaryBundle.account.slug ? undefined : group.slug;
            const raw = dryRun ? await group.run() : await withAudit(group.bundle.auditService, name, args, group.run);
            outputs.push(withBulkNotFound(prefixBulkResult(raw, outputSlug), prefixNotFound(group.notFound, outputSlug)));
          }
          return createTextResult(mergeBulkResults(outputs));
        }

        case "bulk_delete": {
          const permanent = normalizeBoolean(args.permanent, false);
          if (permanent) ensureDestructiveConfirmed(config.runtime, (normalizeBoolean(args.confirmed, false) || normalizeBoolean(args.dryRun, false)), "Permanently delete multiple emails");
          // Same distinction as delete_email/delete_thread: a non-permanent
          // bulk_delete only moves messages to Trash, so it's gated as
          // "trash" (which a policy may allow independently of "delete").
          ensureEmailActionAllowed(config.runtime, permanent ? "delete" : "trash");
          const emailIds = Array.isArray(args.emailIds)
            ? (args.emailIds as unknown[]).map(String) : undefined;
          const match = args.match && typeof args.match === "object"
            ? (args.match as BulkMatchCriteria) : undefined;
          if (emailIds && emailIds.length === 0) throw new McpError(ErrorCode.InvalidParams, "emailIds must contain at least one email id.");
          if (!emailIds && !match) throw new McpError(ErrorCode.InvalidParams, "Provide emailIds or match.");
          if (emailIds && match) throw new McpError(ErrorCode.InvalidParams, "Provide emailIds OR match, not both.");
          const folder = optionalString(args, "folder") ?? "INBOX";
          const max = getBulkMaxBatchSize(args);
          const dryRun = normalizeBoolean(args.dryRun, false);

          // emailIds can span multiple configured accounts — group them so
          // each account's ids resolve/run against that account's own
          // imapService, then merge the per-group results back below. See
          // bulk_move's identical grouping comment. A match-only call stays
          // scoped to the primary account, unchanged.
          const groups = emailIds
            ? groupEmailIdsByAccount(accountManager, emailIds)
            : new Map<string | undefined, { bundle: AccountBundle; restIds: string[] | undefined }>([
                [undefined, { bundle: primaryBundle, restIds: undefined }],
              ]);

          let totalUids = 0;
          const prepared: Array<{
            slug: string | undefined;
            bundle: AccountBundle;
            notFound: BulkExcludedEmailId[];
            run: () => Promise<BulkOperationResult>;
          }> = [];
          for (const [slug, group] of groups) {
            // Fetched once, up front, and reused for both the notFound
            // reporting below and resolveUidsForBulkOp's own filtering — a
            // single shared point-in-time value, same "resolve once" spirit
            // as the uids resolution itself, so the ids this call reports as
            // excluded and the uids it actually acts on can never disagree
            // about which generation was current. Only fetched when there are
            // ids to check against it (a match-only call has none).
            const currentUidValidity = await group.bundle.imapService.getMailboxUidValidity(folder);
            const notFoundEmailIds = getBulkNotFoundEmailIds(group.restIds, folder, currentUidValidity);
            // Resolve the match/emailIds set exactly once and reuse it for both
            // the preview and the real run — see resolveUidsForBulkOp's
            // comment for why re-resolving `match` a second time (the old
            // dry-run-then-real-run pattern) could silently exceed maxBatchSize.
            // Also excludes any id whose embedded UIDVALIDITY is stale — see
            // resolveUidsForBulkOp's comment.
            const uids = await group.bundle.imapService.resolveUidsForBulkOp(folder, group.restIds, match, currentUidValidity);
            totalUids += uids.length;
            prepared.push({
              slug,
              bundle: group.bundle,
              notFound: notFoundEmailIds,
              run: () =>
                group.bundle.imapService.bulkDelete({
                  emailIds: group.restIds,
                  match,
                  folder,
                  permanent,
                  resolvedUids: uids,
                  uidValidity: currentUidValidity,
                  dryRun,
                }),
            });
          }
          ensureBulkBatchSize(totalUids, max);

          const outputs: BulkOperationResult[] = [];
          for (const group of prepared) {
            const outputSlug = group.slug === primaryBundle.account.slug ? undefined : group.slug;
            const raw = dryRun ? await group.run() : await withAudit(group.bundle.auditService, name, args, group.run);
            outputs.push(withBulkNotFound(prefixBulkResult(raw, outputSlug), prefixNotFound(group.notFound, outputSlug)));
          }
          return createTextResult(mergeBulkResults(outputs));
        }

        case "bulk_update_flags": {
          const emailIds = Array.isArray(args.emailIds)
            ? (args.emailIds as unknown[]).map(String) : undefined;
          const match = args.match && typeof args.match === "object"
            ? (args.match as BulkMatchCriteria) : undefined;
          if (emailIds && emailIds.length === 0) throw new McpError(ErrorCode.InvalidParams, "emailIds must contain at least one email id.");
          if (!emailIds && !match) throw new McpError(ErrorCode.InvalidParams, "Provide emailIds or match.");
          if (emailIds && match) throw new McpError(ErrorCode.InvalidParams, "Provide emailIds OR match, not both.");
          const flagsToAdd = Array.isArray(args.flagsToAdd) ? (args.flagsToAdd as unknown[]).map(String) : [];
          const flagsToRemove = Array.isArray(args.flagsToRemove) ? (args.flagsToRemove as unknown[]).map(String) : [];
          if (flagsToAdd.length === 0 && flagsToRemove.length === 0) throw new McpError(ErrorCode.InvalidParams, "Provide flagsToAdd or flagsToRemove.");
          ensureFlagChangeAllowed(config.runtime, flagsToAdd, flagsToRemove, normalizeBoolean(args.confirmed, false));
          const folder = optionalString(args, "folder") ?? "INBOX";
          const max = getBulkMaxBatchSize(args);
          const dryRun = normalizeBoolean(args.dryRun, false);

          // emailIds can span multiple configured accounts — group them so
          // each account's ids resolve/run against that account's own
          // imapService, then merge the per-group results back below. See
          // bulk_move's identical grouping comment. A match-only call stays
          // scoped to the primary account, unchanged.
          const groups = emailIds
            ? groupEmailIdsByAccount(accountManager, emailIds)
            : new Map<string | undefined, { bundle: AccountBundle; restIds: string[] | undefined }>([
                [undefined, { bundle: primaryBundle, restIds: undefined }],
              ]);

          let totalUids = 0;
          const prepared: Array<{
            slug: string | undefined;
            bundle: AccountBundle;
            notFound: BulkExcludedEmailId[];
            run: () => Promise<BulkOperationResult>;
          }> = [];
          for (const [slug, group] of groups) {
            // See the bulk_delete case above for why this is fetched once and
            // shared between notFound reporting and uid resolution.
            const currentUidValidity = await group.bundle.imapService.getMailboxUidValidity(folder);
            const notFoundEmailIds = getBulkNotFoundEmailIds(group.restIds, folder, currentUidValidity);
            // Resolve the match/emailIds set exactly once and reuse it for both
            // the preview and the real run — see resolveUidsForBulkOp's
            // comment for why re-resolving `match` a second time (the old
            // dry-run-then-real-run pattern) could silently exceed maxBatchSize.
            // Also excludes any id whose embedded UIDVALIDITY is stale.
            const uids = await group.bundle.imapService.resolveUidsForBulkOp(folder, group.restIds, match, currentUidValidity);
            totalUids += uids.length;
            prepared.push({
              slug,
              bundle: group.bundle,
              notFound: notFoundEmailIds,
              run: () =>
                group.bundle.imapService.bulkUpdateFlags({
                  emailIds: group.restIds,
                  match,
                  folder,
                  flagsToAdd,
                  flagsToRemove,
                  resolvedUids: uids,
                  uidValidity: currentUidValidity,
                  dryRun,
                }),
            });
          }
          ensureBulkBatchSize(totalUids, max);

          const outputs: BulkOperationResult[] = [];
          for (const group of prepared) {
            const outputSlug = group.slug === primaryBundle.account.slug ? undefined : group.slug;
            const raw = dryRun ? await group.run() : await withAudit(group.bundle.auditService, name, args, group.run);
            outputs.push(withBulkNotFound(prefixBulkResult(raw, outputSlug), prefixNotFound(group.notFound, outputSlug)));
          }
          return createTextResult(mergeBulkResults(outputs));
        }

        case "bulk_update_labels": {
          ensureMailboxWriteAllowed(config.runtime);
          const emailIds = Array.isArray(args.emailIds)
            ? (args.emailIds as unknown[]).map(String) : undefined;
          const match = args.match && typeof args.match === "object"
            ? (args.match as BulkMatchCriteria) : undefined;
          if (emailIds && emailIds.length === 0) throw new McpError(ErrorCode.InvalidParams, "emailIds must contain at least one email id.");
          if (!emailIds && !match) throw new McpError(ErrorCode.InvalidParams, "Provide emailIds or match.");
          if (emailIds && match) throw new McpError(ErrorCode.InvalidParams, "Provide emailIds OR match, not both.");
          const labelsToAdd = Array.isArray(args.labelsToAdd) ? (args.labelsToAdd as unknown[]).map(String) : [];
          const labelsToRemove = Array.isArray(args.labelsToRemove) ? (args.labelsToRemove as unknown[]).map(String) : [];
          const folder = optionalString(args, "folder") ?? "INBOX";
          const max = getBulkMaxBatchSize(args);
          const dryRun = normalizeBoolean(args.dryRun, false);

          // emailIds can span multiple configured accounts — group them so
          // each account's ids resolve/run against that account's own
          // imapService, then merge the per-group results back below. See
          // bulk_move's identical grouping comment. A match-only call stays
          // scoped to the primary account, unchanged.
          const groups = emailIds
            ? groupEmailIdsByAccount(accountManager, emailIds)
            : new Map<string | undefined, { bundle: AccountBundle; restIds: string[] | undefined }>([
                [undefined, { bundle: primaryBundle, restIds: undefined }],
              ]);

          let totalUids = 0;
          const prepared: Array<{
            slug: string | undefined;
            bundle: AccountBundle;
            notFound: BulkExcludedEmailId[];
            run: () => Promise<BulkOperationResult>;
          }> = [];
          for (const [slug, group] of groups) {
            // See the bulk_delete case above for why this is fetched once and
            // shared between notFound reporting and uid resolution.
            const currentUidValidity = await group.bundle.imapService.getMailboxUidValidity(folder);
            const notFoundEmailIds = getBulkNotFoundEmailIds(group.restIds, folder, currentUidValidity);
            // Resolve the match/emailIds set exactly once and reuse it for both
            // the preview and the real run — see resolveUidsForBulkOp's
            // comment for why re-resolving `match` a second time (the old
            // dry-run-then-real-run pattern) could silently exceed maxBatchSize.
            // Also excludes any id whose embedded UIDVALIDITY is stale.
            const uids = await group.bundle.imapService.resolveUidsForBulkOp(folder, group.restIds, match, currentUidValidity);
            totalUids += uids.length;
            prepared.push({
              slug,
              bundle: group.bundle,
              notFound: notFoundEmailIds,
              run: () =>
                group.bundle.imapService.bulkUpdateLabels({
                  emailIds: group.restIds,
                  match,
                  folder,
                  labelsToAdd,
                  labelsToRemove,
                  resolvedUids: uids,
                  uidValidity: currentUidValidity,
                  dryRun,
                }),
            });
          }
          ensureBulkBatchSize(totalUids, max);

          const outputs: BulkOperationResult[] = [];
          for (const group of prepared) {
            const outputSlug = group.slug === primaryBundle.account.slug ? undefined : group.slug;
            const raw = dryRun ? await group.run() : await withAudit(group.bundle.auditService, name, args, group.run);
            outputs.push(withBulkNotFound(prefixBulkResult(raw, outputSlug), prefixNotFound(group.notFound, outputSlug)));
          }
          return createTextResult(mergeBulkResults(outputs));
        }

        case "top_senders": {
          const topSendersLimit = optionalInteger(args.limit, 1, 200);
          const topSendersInput = {
            folder: optionalString(args, "folder"),
            since: optionalString(args, "since"),
            before: optionalString(args, "before"),
            limit: topSendersLimit,
            scanLimit: optionalInteger(args.scanLimit, 1, 20_000),
            excludeSelf: normalizeBoolean(args.excludeSelf, true),
          };
          if (accountManager.all().length === 1) {
            resolveAccountArg(args);
            const result = await imapService.topSenders(topSendersInput);
            return createTextResult(result);
          }
          // Merge strategy: scan each account's folder independently, merge
          // sender frequency by address (summing counts across accounts), then
          // re-sort and re-apply the requested top-N limit over the merged set.
          // Each account is asked for its WHOLE table, not just its own top N: a sender in the middle of every
          // account's table can still be first in total, and cutting each table first made it disappear.
          const perAccount = await Promise.all(
            selectedBundles(args).map(async (bundle) => ({
              bundle,
              result: await bundle.imapService.topSenders({ ...topSendersInput, limit: 10_000 }),
            })),
          );
          const senderMap = new Map<string, { address: string; name?: string; count: number; direction: "self" | "received" }>();
          for (const { result } of perAccount) {
            for (const sender of result.senders) {
              const existing = senderMap.get(sender.address);
              if (existing) {
                existing.count += sender.count;
              } else {
                senderMap.set(sender.address, { ...sender });
              }
            }
          }
          const mergedSenders = [...senderMap.values()].sort((left, right) => right.count - left.count).slice(0, topSendersLimit ?? 20);
          return createTextResult({
            folder: topSendersInput.folder?.trim() || "INBOX",
            scanned: perAccount.reduce((sum, { result }) => sum + result.scanned, 0),
            senders: mergedSenders,
            byAccount: perAccount.map(({ bundle, result }) => ({ slug: bundle.account.slug, scanned: result.scanned })),
          });
        }

        case "move_thread": {
          ensureEmailActionAllowed(config.runtime, "move");
          // A threadId only ever names ONE account — a thread can't span
          // multiple mailboxes/accounts — so this reuses
          // resolveAccountForEmailId's generic "<slug>::" prefix stripping
          // (it doesn't care that the string is an emailId vs a threadId) to
          // route the whole call to that account's own imapService/
          // auditService. A plain, unprefixed threadId keeps going to the
          // primary account, unchanged. Full cross-account thread resolution
          // (e.g. a match/threading key that could resolve differently per
          // account) is out of scope for this pass.
          const { bundle, rest: messageId } = resolveAccountForEmailId(requireString(args, "messageId"));
          await ensureMoveTargetAllowed(config.runtime, bundle.imapService, requireString(args, "destination"));
          const result = await withAudit(bundle.auditService, name, args, () =>
            bundle.imapService.moveThread({
              messageId,
              destination: requireString(args, "destination"),
              acrossFolders: normalizeBoolean(args.acrossFolders, false),
              dryRun: normalizeBoolean(args.dryRun, false),
              maxBatchSize: getBulkMaxBatchSize(args),
            })
          );
          return createTextResult(result);
        }

        case "delete_thread": {
          const permanentThread = normalizeBoolean(args.permanent, false);
          if (permanentThread) ensureDestructiveConfirmed(config.runtime, (normalizeBoolean(args.confirmed, false) || normalizeBoolean(args.dryRun, false)), "Permanently delete thread");
          // Same "trash" vs "delete" distinction as bulk_delete above.
          ensureEmailActionAllowed(config.runtime, permanentThread ? "delete" : "trash");
          // See move_thread's comment on scoping by the threadId's own
          // "<slug>::" prefix — same convention, same single-account
          // limitation.
          const { bundle, rest: messageId } = resolveAccountForEmailId(requireString(args, "messageId"));
          const result = await withAudit(bundle.auditService, name, args, () =>
            bundle.imapService.deleteThread({
              messageId,
              permanent: permanentThread,
              acrossFolders: normalizeBoolean(args.acrossFolders, false),
              dryRun: normalizeBoolean(args.dryRun, false),
              maxBatchSize: getBulkMaxBatchSize(args),
            })
          );
          return createTextResult(result);
        }

        case "flag_thread": {
          const flagsToAdd = Array.isArray(args.flagsToAdd) ? (args.flagsToAdd as unknown[]).map(String) : [];
          const flagsToRemove = Array.isArray(args.flagsToRemove) ? (args.flagsToRemove as unknown[]).map(String) : [];
          if (flagsToAdd.length === 0 && flagsToRemove.length === 0) throw new McpError(ErrorCode.InvalidParams, "Provide flagsToAdd or flagsToRemove.");
          ensureFlagChangeAllowed(config.runtime, flagsToAdd, flagsToRemove, normalizeBoolean(args.confirmed, false));
          // See move_thread's comment on scoping by the threadId's own
          // "<slug>::" prefix — same convention, same single-account
          // limitation.
          const { bundle, rest: messageId } = resolveAccountForEmailId(requireString(args, "messageId"));
          const result = await withAudit(bundle.auditService, name, args, () =>
            bundle.imapService.flagThread({
              messageId,
              flagsToAdd,
              flagsToRemove,
              acrossFolders: normalizeBoolean(args.acrossFolders, false),
              dryRun: normalizeBoolean(args.dryRun, false),
              maxBatchSize: getBulkMaxBatchSize(args),
            })
          );
          return createTextResult(result);
        }

        case "create_label": {
          ensureMailboxWriteAllowed(config.runtime);
          const rawName = requireString(args, "name");
          if (!rawName.trim()) throw new McpError(ErrorCode.InvalidParams, "Label name cannot be empty.");
          const labelPath = rawName.startsWith("Labels/") ? rawName : `Labels/${rawName}`;
          const result = await withAudit(auditService, name, args, () =>
            imapService.createFolder(labelPath)
          );
          return createTextResult(result);
        }

        case "rename_label": {
          ensureMailboxWriteAllowed(config.runtime);
          const rawName = requireString(args, "name");
          const rawNewName = requireString(args, "newName");
          if (!rawName.trim()) throw new McpError(ErrorCode.InvalidParams, "Label name cannot be empty.");
          if (!rawNewName.trim()) throw new McpError(ErrorCode.InvalidParams, "New label name cannot be empty.");
          const labelPath = rawName.startsWith("Labels/") ? rawName : `Labels/${rawName}`;
          const newLabelPath = rawNewName.startsWith("Labels/") ? rawNewName : `Labels/${rawNewName}`;
          const result = await withAudit(auditService, name, args, () =>
            imapService.renameFolder(labelPath, newLabelPath)
          );
          return createTextResult(result);
        }

        case "delete_label": {
          ensureEmailActionAllowed(config.runtime, "delete");
          const rawName = requireString(args, "name");
          if (!rawName.trim()) throw new McpError(ErrorCode.InvalidParams, "Label name cannot be empty.");
          const labelPath = rawName.startsWith("Labels/") ? rawName : `Labels/${rawName}`;
          ensureDestructiveConfirmed(config.runtime, normalizeBoolean(args?.confirmed, false), "Permanently delete label: " + labelPath);
          const result = await withAudit(auditService, name, args, () =>
            imapService.deleteFolder(labelPath)
          );
          return createTextResult(result);
        }

        case "get_folders": {
          if (accountManager.all().length === 1) {
            resolveAccountArg(args);
            return createTextResult(await imapService.getFolders());
          }
          // Merge strategy: fetch each account's own folder list (LIVE IMAP) and
          // tag each folder's path with its account slug (except the primary's,
          // which is left bare) so the merged list stays unambiguous while a
          // single-account setup's own folder paths are completely untouched.
          const primarySlug = accountManager.primary().account.slug;
          const perAccount = await Promise.all(
            selectedBundles(args).map(async (bundle) => ({ bundle, folders: await bundle.imapService.getFolders() })),
          );
          const merged = perAccount.flatMap(({ bundle, folders }) =>
            folders.map((folder) => {
              const slug = accountSlugForTag(bundle, primarySlug);
              return slug ? { ...folder, path: `${slug}::${folder.path}`, account: slug } : folder;
            }),
          );
          return createTextResult(merged);
        }

        case "sync_folders":
          return createTextResult(await (resolveAccountArg(args) ?? primaryBundle).imapService.syncFolders());

        case "create_folder": {
          ensureMailboxWriteAllowed(config.runtime);
          const { bundle: folderBundle, paths: [folderPath] } = resolveFolderTarget(args, requireString(args, "path"));
          return createTextResult(
            await withAudit(folderBundle.auditService, name, args, async () =>
              folderBundle.imapService.createFolder(folderPath),
            ),
          );
        }

        case "rename_folder": {
          ensureMailboxWriteAllowed(config.runtime);
          const { bundle: folderBundle, paths: [fromPath, toPath] } = resolveFolderTarget(args, requireString(args, "path"), requireString(args, "newPath"));
          return createTextResult(
            await withAudit(folderBundle.auditService, name, args, async () =>
              folderBundle.imapService.renameFolder(fromPath, toPath),
            ),
          );
        }

        case "delete_folder": {
          ensureEmailActionAllowed(config.runtime, "delete");
          const { bundle: folderBundle, paths: [folderPath] } = resolveFolderTarget(args, requireString(args, "path"));
          ensureDestructiveConfirmed(config.runtime, normalizeBoolean(args?.confirmed, false), "Permanently delete folder and all messages in it: " + requireString(args, "path"));
          return createTextResult(
            await withAudit(folderBundle.auditService, name, args, async () =>
              folderBundle.imapService.deleteFolder(folderPath),
            ),
          );
        }

        case "mark_email_read": {
          ensureEmailActionAllowed(
            config.runtime,
            normalizeBoolean(args.isRead, true) ? "mark_read" : "mark_unread",
          );
          const rawEmailId = requireString(args, "emailId");
          const { bundle, rest: emailId } = resolveAccountForEmailId(rawEmailId);
          const uidValidity = parseEmailId(emailId).uidValidity;
          return createTextResult(
            withPrefixedIds(
              bundle,
              await withAudit(auditService, name, args, async () =>
                bundle.imapService.markEmailRead(
                  emailId,
                  normalizeBoolean(args.isRead, true),
                  uidValidity,
                ),
              ),
            ),
          );
        }

        case "star_email": {
          ensureEmailActionAllowed(
            config.runtime,
            normalizeBoolean(args.isStarred, true) ? "star" : "unstar",
          );
          const rawEmailId = requireString(args, "emailId");
          const { bundle, rest: emailId } = resolveAccountForEmailId(rawEmailId);
          const uidValidity = parseEmailId(emailId).uidValidity;
          return createTextResult(
            withPrefixedIds(
              bundle,
              await withAudit(auditService, name, args, async () =>
                bundle.imapService.starEmail(
                  emailId,
                  normalizeBoolean(args.isStarred, true),
                  uidValidity,
                ),
              ),
            ),
          );
        }

        case "move_email":
        {
          ensureEmailActionAllowed(config.runtime, "move");
          const rawEmailId = requireString(args, "emailId");
          const { bundle, rest: emailId } = resolveAccountForEmailId(rawEmailId);
          const targetFolder = requireString(args, "targetFolder");
          await ensureMoveTargetAllowed(config.runtime, bundle.imapService, targetFolder);
          const uidValidity = parseEmailId(emailId).uidValidity;
          const result = await withAudit(auditService, name, args, async () => {
            try {
              return await bundle.imapService.moveEmail(emailId, targetFolder, uidValidity);
            } catch (error) {
              if (isMissingTargetFolderError(error)) {
                throw new McpError(
                  ErrorCode.InvalidParams,
                  `Target folder ${targetFolder} does not exist. Use get_folders to list valid paths.`,
                );
              }
              throw error;
            }
          });
          const targetEmailId = result.targetEmailId ? prefixedIdFor(bundle, result.targetEmailId) : undefined;
          const sources = targetEmailId
            ? [
                {
                  uri: buildEmailResourceUri(targetEmailId),
                  name: targetEmailId,
                  title: `Moved email ${targetEmailId}`,
                  description: `${result.targetFolder} · uid ${result.targetUid || result.uid}`,
                  mimeType: "message/rfc822",
                },
              ]
            : [];
          return createTextResult(withPrefixedIds(bundle, { ...result, targetEmailId }), false, sources);
        }

        case "archive_email":
        {
          ensureEmailActionAllowed(config.runtime, "archive");
          const rawEmailId = requireString(args, "emailId");
          const { bundle, rest: emailId } = resolveAccountForEmailId(rawEmailId);
          const uidValidity = parseEmailId(emailId).uidValidity;
          const result = await withAudit(auditService, name, args, async () =>
            bundle.imapService.archiveEmail(emailId, uidValidity),
          );
          const targetEmailId = result.targetEmailId ? prefixedIdFor(bundle, result.targetEmailId) : undefined;
          const sources = targetEmailId
            ? [
                {
                  uri: buildEmailResourceUri(targetEmailId),
                  name: targetEmailId,
                  title: `Archived email ${targetEmailId}`,
                  description: `${result.targetFolder} · uid ${result.targetUid || result.uid}`,
                  mimeType: "message/rfc822",
                },
              ]
            : [];
          return createTextResult(withPrefixedIds(bundle, { ...result, targetEmailId }), false, sources);
        }

        case "trash_email":
        {
          ensureEmailActionAllowed(config.runtime, "trash");
          const rawEmailId = requireString(args, "emailId");
          const { bundle, rest: emailId } = resolveAccountForEmailId(rawEmailId);
          const uidValidity = parseEmailId(emailId).uidValidity;
          const result = await withAudit(auditService, name, args, async () =>
            bundle.imapService.trashEmail(emailId, uidValidity),
          );
          const targetEmailId = result.targetEmailId ? prefixedIdFor(bundle, result.targetEmailId) : undefined;
          const sources = targetEmailId
            ? [
                {
                  uri: buildEmailResourceUri(targetEmailId),
                  name: targetEmailId,
                  title: `Trashed email ${targetEmailId}`,
                  description: `${result.targetFolder} · uid ${result.targetUid || result.uid}`,
                  mimeType: "message/rfc822",
                },
              ]
            : [];
          return createTextResult(withPrefixedIds(bundle, { ...result, targetEmailId }), false, sources);
        }

        case "restore_email":
        {
          ensureEmailActionAllowed(config.runtime, "restore");
          const rawEmailId = requireString(args, "emailId");
          const { bundle, rest: emailId } = resolveAccountForEmailId(rawEmailId);
          await ensureMoveTargetAllowed(config.runtime, bundle.imapService, optionalString(args, "targetFolder"));
          const uidValidity = parseEmailId(emailId).uidValidity;
          const result = await withAudit(auditService, name, args, async () =>
            bundle.imapService.restoreEmail(
              emailId,
              optionalString(args, "targetFolder"),
              uidValidity,
            ),
          );
          const targetEmailId = result.targetEmailId ? prefixedIdFor(bundle, result.targetEmailId) : undefined;
          const sources = targetEmailId
            ? [
                {
                  uri: buildEmailResourceUri(targetEmailId),
                  name: targetEmailId,
                  title: `Restored email ${targetEmailId}`,
                  description: `${result.targetFolder} · uid ${result.targetUid || result.uid}`,
                  mimeType: "message/rfc822",
                },
              ]
            : [];
          return createTextResult(withPrefixedIds(bundle, { ...result, targetEmailId }), false, sources);
        }

        case "delete_email": {
          ensureDestructiveConfirmed(config.runtime, normalizeBoolean(args.confirmed, false), `Permanently delete ${String(args.emailId ?? "?")} (cannot be recovered)`);
          ensureEmailActionAllowed(config.runtime, "delete");
          const rawEmailId = requireString(args, "emailId");
          const { bundle, rest: emailId } = resolveAccountForEmailId(rawEmailId);
          const uidValidity = parseEmailId(emailId).uidValidity;
          return createTextResult(
            withPrefixedIds(
              bundle,
              await withAudit(auditService, name, args, async () => bundle.imapService.deleteEmail(emailId, uidValidity)),
            ),
          );
        }

        case "batch_email_action":
        {
          const emailIds = [...new Set(parseStringListArg(args, "emailIds"))];
          if (emailIds.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, "emailIds must contain at least one email id.");
          }
          // Same safety rail as the bulk_* tools (bulk_delete etc.) — without
          // it, an arbitrarily large emailIds array would be processed in
          // full with no size limit at all.
          ensureBulkBatchSize(emailIds.length, getBulkMaxBatchSize(args));
          const action = requireEmailAction(args);
          ensureEmailActionAllowed(config.runtime, action);
          if (action === "delete") {
            ensureDestructiveConfirmed(config.runtime, (normalizeBoolean(args.confirmed, false) || normalizeBoolean(args.dryRun, false)), `Permanently delete ${emailIds.length} email(s) (cannot be recovered)`);
          }
          // emailIds can span multiple configured accounts — group them so
          // each account's ids run against that account's own imapService
          // (and get audited to that account's own auditService), then merge
          // the per-group BatchActionResults back into one. continueOnError
          // is honored within each group (as before); across groups, a
          // failure in one account's group still lets independent, unrelated
          // groups for OTHER accounts run — an id in account B failing
          // doesn't block account A's ids, which are on an entirely separate
          // connection anyway.
          const continueOnError = normalizeBoolean(args.continueOnError, true);
          const dryRun = normalizeBoolean(args.dryRun, false);
          const targetFolder = optionalString(args, "targetFolder");
          if (action === "move" || action === "restore") {
            await ensureMoveTargetAllowed(config.runtime, accountManager.all().map((entry) => entry.imapService), targetFolder);
          }
          const groups = groupEmailIdsByAccount(accountManager, emailIds);

          const groupResults: Array<{ slug: string | undefined; result: BatchActionResult }> = [];
          for (const [slug, group] of groups) {
            const entries: BatchActionEntry[] = [];
            const groupResult = await withAudit(group.bundle.auditService, name, args, () =>
              applyBatchEmailAction(group.bundle.imapService, entries, {
                emailIds: group.restIds,
                action,
                targetFolder,
                continueOnError,
                dryRun,
              }),
            );
            groupResults.push({ slug, result: groupResult });
          }

          const outputSlugFor = (slug: string | undefined) => (slug === primaryBundle.account.slug ? undefined : slug);
          const mergedResults: BatchActionEntry[] = groupResults.flatMap(({ slug, result: groupResult }) =>
            groupResult.results.map((entry) => ({ ...entry, emailId: withAccountPrefix(outputSlugFor(slug), entry.emailId) })),
          );
          // Reordered to match the caller's original emailIds order (each
          // group only preserves order within itself) so a mixed-account
          // request's results still line up with the ids the caller passed.
          const byEmailId = new Map(mergedResults.map((entry) => [entry.emailId, entry]));
          const orderedResults = emailIds.flatMap((emailId) => {
            const entry = byEmailId.get(emailId);
            return entry ? [entry] : [];
          });
          const succeeded = orderedResults.filter((entry) => entry.ok).length;
          const notAttempted = groupResults.flatMap(({ slug, result: groupResult }) =>
            (groupResult.notAttempted ?? []).map((id) => withAccountPrefix(outputSlugFor(slug), id)),
          );
          const result: BatchActionResult = {
            action,
            total: orderedResults.length,
            succeeded,
            failed: orderedResults.length - succeeded,
            results: orderedResults,
            ...(notAttempted.length > 0 ? { notAttempted } : {}),
          };

          const sources = result.results.flatMap((entry) =>
            entry.ok ? emailSourceFromActionResult(entry.result) : [],
          );
          return createTextResult(result, false, sources);
        }

        case "get_email_stats": {
          const statsDays = normalizeLimit(args.days, 30, 1, 365);
          const statsLimit = normalizeLimit(args.limit, 2000, 1, 10_000);
          if (accountManager.all().length === 1) {
            resolveAccountArg(args);
            const folders = await imapService.getFolders();
            const sample = await getAnalyticsSampleFromIndex(imapService, localIndexService, statsDays, statsLimit);
            return createTextResult(analyticsService.getEmailStats(sample, folders, config.smtp.username));
          }
          // Merge strategy: compute each account's own stats independently
          // (self-detection needs each account's own address), then sum the
          // numeric mailbox/sample fields and merge folder lists (non-primary
          // folder paths tagged with their account slug to avoid collisions).
          const primarySlugForStats = accountManager.primary().account.slug;
          const statsPerAccount = await Promise.all(
            selectedBundles(args).map(async (bundle) => {
              const folders = await bundle.imapService.getFolders();
              const sample = await getAnalyticsSampleFromIndex(bundle.imapService, bundle.localIndexService, statsDays, statsLimit);
              return {
                bundle,
                stats: analyticsService.getEmailStats(sample, folders, bundle.config.smtp.username),
              };
            }),
          );
          return createTextResult({
            generatedAt: new Date().toISOString(),
            mailbox: {
              folderCount: statsPerAccount.reduce((sum, { stats }) => sum + stats.mailbox.folderCount, 0),
              totalMessages: statsPerAccount.reduce((sum, { stats }) => sum + stats.mailbox.totalMessages, 0),
              unreadMessages: statsPerAccount.reduce((sum, { stats }) => sum + stats.mailbox.unreadMessages, 0),
            },
            sample: {
              size: statsPerAccount.reduce((sum, { stats }) => sum + stats.sample.size, 0),
              starredMessages: statsPerAccount.reduce((sum, { stats }) => sum + stats.sample.starredMessages, 0),
              messagesWithAttachments: statsPerAccount.reduce((sum, { stats }) => sum + stats.sample.messagesWithAttachments, 0),
              uniqueContacts: statsPerAccount.reduce((sum, { stats }) => sum + stats.sample.uniqueContacts, 0),
            },
            folders: statsPerAccount.flatMap(({ bundle, stats }) => {
              const slug = accountSlugForTag(bundle, primarySlugForStats);
              return stats.folders.map((folder) => (slug ? { ...folder, path: `${slug}::${folder.path}` } : folder));
            }),
            byAccount: statsPerAccount.map(({ bundle, stats }) => ({ slug: bundle.account.slug, mailbox: stats.mailbox, sample: stats.sample })),
          });
        }

        case "get_email_analytics": {
          const analyticsDays = normalizeLimit(args.days, 30, 1, 365);
          const analyticsLimit = normalizeLimit(args.limit, 2000, 1, 10_000);
          if (accountManager.all().length === 1) {
            resolveAccountArg(args);
            const sample = await getAnalyticsSampleFromIndex(imapService, localIndexService, analyticsDays, analyticsLimit);
            return createTextResult(analyticsService.getEmailAnalytics(sample, config.smtp.username, analyticsDays));
          }
          // Merge strategy: compute each account's own analytics independently
          // (self-detection needs each account's own address), then merge the
          // top-N breakdowns (hours/senders/domains) by summing counts per key
          // and re-sorting, and recompute busiestDay/insights from the merged
          // results.
          const analyticsPerAccount = await Promise.all(
            selectedBundles(args).map(async (bundle) => {
              const sample = await getAnalyticsSampleFromIndex(bundle.imapService, bundle.localIndexService, analyticsDays, analyticsLimit);
              return analyticsService.getEmailAnalytics(sample, bundle.config.smtp.username, analyticsDays);
            }),
          );
          const busiestHours = mergeCountedEntries(
            analyticsPerAccount.map((entry) => entry.busiestHours),
            (entry) => entry.hour,
            5,
          );
          const topSenders = mergeCountedEntries(
            analyticsPerAccount.map((entry) => entry.topSenders),
            (entry) => entry.address,
            10,
          );
          const topDomains = mergeCountedEntries(
            analyticsPerAccount.map((entry) => entry.topDomains),
            (entry) => entry.domain,
            10,
          );
          const busiestDayCandidates = analyticsPerAccount.flatMap((entry) => (entry.busiestDay ? [entry.busiestDay] : []));
          const busiestDay = busiestDayCandidates.length > 0
            ? busiestDayCandidates.reduce((best, candidate) => (candidate.count > best.count ? candidate : best))
            : undefined;
          return createTextResult({
            generatedAt: new Date().toISOString(),
            sampleSize: analyticsPerAccount.reduce((sum, entry) => sum + entry.sampleSize, 0),
            busiestHours,
            topSenders,
            topDomains,
            busiestDay,
            insights: [
              busiestHours[0]
                ? `Peak sampled activity occurs around ${busiestHours[0].hour}.`
                : "No recent activity was available for hourly analysis.",
              topSenders[0]
                ? `Top sender in the sampled window: ${topSenders[0].address}.`
                : "No sender data was available in the sampled window.",
              busiestDay
                ? `Busiest sampled day was ${busiestDay.date} with ${busiestDay.count} messages.`
                : "No day-level trend data was available.",
            ],
          });
        }

        case "get_contacts": {
          // limit is "how many contacts to return", not "how many messages to
          // sample" — unlike get_email_stats/get_email_analytics (which return
          // one aggregate object, so their limit genuinely means sample size),
          // get_contacts returns a ranked list. Reusing limit as the sample size
          // meant limit: 5 silently ranked contacts from only 5 messages total.
          const limit = normalizeLimit(args.limit, 100);
          if (accountManager.all().length === 1) {
            resolveAccountArg(args);
            const sample = await getAnalyticsSampleFromIndex(imapService, localIndexService, 30, 3000);
            return createTextResult(analyticsService.getContacts(sample, limit, config.smtp.username));
          }
          // Merge strategy: compute each account's own contact list independently
          // (self-detection needs each account's own address), then merge same
          // address across accounts by summing incoming/outgoing/totalMessages
          // and keeping the most recent lastContactAt, and re-apply the
          // requested limit over the merged, re-sorted set.
          const contactsPerAccount = await Promise.all(
            selectedBundles(args).map(async (bundle) => {
              const sample = await getAnalyticsSampleFromIndex(bundle.imapService, bundle.localIndexService, 30, 3000);
              return analyticsService.getContacts(sample, Number.MAX_SAFE_INTEGER, bundle.config.smtp.username);
            }),
          );
          return createTextResult(mergeContactStats(contactsPerAccount, limit));
        }

        case "get_volume_trends": {
          const days = normalizeLimit(args.days, 30, 1, 365);
          // Counted in SQL over the whole index (a sample of the newest 3000 messages cut the older days short).
          if (accountManager.all().length === 1) {
            resolveAccountArg(args);
            await maybeRefreshLocalIndex(imapService, localIndexService, {});
            return createTextResult(await localIndexService.getDailyVolume(days));
          }
          // Merge strategy: compute each account's own daily trend points
          // independently, then sum count/unreadCount/starredCount/attachmentCount
          // for matching dates across accounts.
          const trendsPerAccount = await Promise.all(
            selectedBundles(args).map(async (bundle) => {
              await maybeRefreshLocalIndex(bundle.imapService, bundle.localIndexService, {});
              return bundle.localIndexService.getDailyVolume(days);
            }),
          );
          return createTextResult(mergeVolumeTrends(trendsPerAccount));
        }

        case "get_connection_status": {
          const includeRawConnectionErrors = process.env.PROTONMAIL_DEBUG === "true";
          const [smtpStatus, imapStatus] = await Promise.allSettled([
            smtpService.verifyConnection(),
            imapService.ping(),
          ]);

          return createTextResult({
            checkedAt: new Date().toISOString(),
            // A running server has no other way to tell an MCP client which
            // install it's actually talking to — a stale/orphaned install
            // (wrong path, old version) looks identical to a fresh one from
            // every other field here. Found this gap while diagnosing a
            // real 5-month-stale install that silently caused timeouts long
            // after the underlying bugs were fixed upstream.
            version: PACKAGE_VERSION,
            entrypoint: fileURLToPath(import.meta.url),
            smtp: {
              ok: smtpStatus.status === "fulfilled",
              message:
                smtpStatus.status === "fulfilled"
                  ? "SMTP connection verified."
                  : includeRawConnectionErrors
                    ? smtpStatus.reason instanceof Error
                      ? smtpStatus.reason.message
                      : String(smtpStatus.reason)
                    : "SMTP connection failed.",
            },
            imap: {
              ok: imapStatus.status === "fulfilled",
              connected: imapService.isConnected(),
              idle: imapService.getIdleStatus(),
              message:
                imapStatus.status === "fulfilled"
                  ? "IMAP connection verified."
                  : includeRawConnectionErrors
                    ? imapStatus.reason instanceof Error
                      ? imapStatus.reason.message
                      : String(imapStatus.reason)
                    : "IMAP connection failed.",
            },
          });
        }

        case "run_doctor": {
          const includeRawConnectionErrors = process.env.PROTONMAIL_DEBUG === "true";
          const includeSmtp = normalizeBoolean(args.includeSmtp, true);
          const includeImap = normalizeBoolean(args.includeImap, true);
          const includeIdleProbe = normalizeBoolean(args.includeIdleProbe, false);
          const idleTimeoutSeconds = normalizeLimit(args.idleTimeoutSeconds, 5, 1, 60);
          const [smtpStatus, imapStatus, indexStatus, integrity, drafts] = await Promise.all([
            includeSmtp
              ? Promise.allSettled([smtpService.verifyConnection()]).then(([result]) => result)
              : Promise.resolve({ status: "fulfilled", value: undefined } as const),
            includeImap
              ? Promise.allSettled([imapService.ping()]).then(([result]) => result)
              : Promise.resolve({ status: "fulfilled", value: undefined } as const),
            localIndexService.getStatus(),
            localIndexService.runIntegrityCheck(),
            draftStore.listDrafts(true),
          ]);

          const idleProbe = includeIdleProbe
            ? await Promise.allSettled([
                imapService.waitForMailboxChanges({
                  // autoSyncFolder is a comma-separated list ("INBOX,Sent") for
                  // the periodic index sync, but IMAP IDLE can only watch one
                  // mailbox per connection (same constraint documented on
                  // BackgroundSyncService's primaryIdleFolder). Passing the raw
                  // multi-folder string through made every run_doctor
                  // includeIdleProbe:true call try to SELECT a literal mailbox
                  // named "INBOX,Sent" and fail — reproduced live, 100% of the
                  // time with the default config.
                  folder: config.runtime.autoSyncFolder?.split(",")[0]?.trim() || "INBOX",
                  timeoutMs: idleTimeoutSeconds * 1000,
                }),
              ]).then(([result]) => result)
            : undefined;

          // Classifies the connection failure into a specific, actionable cause —
          // without PROTONMAIL_DEBUG this used to just say "connection failed" for
          // both a wrong password and Bridge not being open at all.
          const diagnoseFailure = (
            reason: unknown,
          ): { cause: string; suggestion: string } | undefined => {
            if (isLikelyAuthenticationError(reason)) {
              return {
                cause: "authentication_failed",
                suggestion:
                  "PROTONMAIL_PASSWORD must be the Proton Bridge password (Bridge app -> account -> Mailbox details), not your Proton account password. Confirm you're signed in inside the Bridge app.",
              };
            }
            // Checked before the generic connection-error case: an EPROTO/
            // "wrong version number" is unambiguous evidence of a TLS-mode
            // mismatch, distinct from Bridge simply being unreachable.
            if (isLikelyTlsMismatchError(reason)) {
              return {
                cause: "tls_mismatch",
                suggestion:
                  "TLS handshake failed against a plaintext/STARTTLS port. PROTONMAIL_IMAP_SECURE/PROTONMAIL_SMTP_SECURE likely doesn't match the security mode of the port in Bridge's Mailbox details (implicit TLS vs STARTTLS) — check both against Bridge's IMAP/SMTP port settings.",
              };
            }
            if (isLikelyConnectionError(reason)) {
              return {
                cause: "bridge_unreachable",
                suggestion:
                  "Proton Bridge isn't reachable on the configured host/port, OR (if this is ECONNRESET) a TLS-mode mismatch in the other direction — plaintext attempted against an implicit-TLS port. Make sure the Bridge app is running, that PROTONMAIL_IMAP_HOST/PORT and PROTONMAIL_SMTP_HOST/PORT match Bridge's Mailbox details, and that PROTONMAIL_IMAP_SECURE/PROTONMAIL_SMTP_SECURE match the security mode shown there.",
              };
            }
            return undefined;
          };

          // Per-account breakdown, purely additive alongside every existing top-level
          // field above (which keep describing the PRIMARY account only, unchanged, for
          // backward compatibility) — same shape list_accounts already returns, plus a
          // live connection check reusing that same checkConnections pattern, gated on
          // this tool's own includeSmtp/includeImap flags.
          const accountsInfo = await Promise.all(
            accountManager.all().map(async (bundle) => {
              const [accountIndexStatus, connection] = await Promise.all([
                bundle.localIndexService.getStatus(),
                includeSmtp || includeImap
                  ? Promise.allSettled([
                      includeSmtp ? bundle.smtpService.verifyConnection() : Promise.resolve(undefined),
                      includeImap ? bundle.imapService.ping() : Promise.resolve(undefined),
                    ]).then(([smtpResult, imapResult]) => ({
                      smtp: !includeSmtp
                        ? undefined
                        : smtpResult.status === "fulfilled" ? { ok: true } : { ok: false, error: describeImapError(smtpResult.reason) },
                      imap: !includeImap
                        ? undefined
                        : imapResult.status === "fulfilled" ? { ok: true } : { ok: false, error: describeImapError(imapResult.reason) },
                    }))
                  : Promise.resolve(undefined),
              ]);
              return {
                slug: bundle.account.slug,
                address: bundle.account.address,
                isPrimary: bundle.account.slug === primaryBundle.account.slug,
                index: { storedMessageCount: accountIndexStatus.storedMessageCount, updatedAt: accountIndexStatus.updatedAt, isStale: accountIndexStatus.isStale },
                connection,
              };
            }),
          );

          return createTextResult({
            checkedAt: new Date().toISOString(),
            // See get_connection_status for why this matters: from inside
            // the tool, a stale install is indistinguishable from a fresh
            // one on every other field here.
            version: PACKAGE_VERSION,
            entrypoint: fileURLToPath(import.meta.url),
            runtime: sanitizeRuntimeConfig(config.runtime),
            smtp: {
              ok: smtpStatus.status === "fulfilled",
              enabled: includeSmtp,
              message:
                smtpStatus.status === "fulfilled"
                  ? "SMTP connection verified."
                  : includeRawConnectionErrors
                    ? smtpStatus.reason instanceof Error
                      ? smtpStatus.reason.message
                      : String(smtpStatus.reason)
                    : "SMTP connection failed.",
              ...(smtpStatus.status === "rejected" ? { diagnosis: diagnoseFailure(smtpStatus.reason) } : {}),
            },
            imap: {
              ok: imapStatus.status === "fulfilled",
              enabled: includeImap,
              idle: imapService.getIdleStatus(),
              message:
                imapStatus.status === "fulfilled"
                  ? "IMAP connection verified."
                  : includeRawConnectionErrors
                    ? imapStatus.reason instanceof Error
                      ? imapStatus.reason.message
                      : String(imapStatus.reason)
                    : "IMAP connection failed.",
              ...(imapStatus.status === "rejected" ? { diagnosis: diagnoseFailure(imapStatus.reason) } : {}),
            },
            idleProbe:
              idleProbe === undefined
                ? { skipped: true }
                : idleProbe.status === "fulfilled"
                  ? idleProbe.value
                  : {
                      ok: false,
                      error: includeRawConnectionErrors
                        ? idleProbe.reason instanceof Error
                          ? idleProbe.reason.message
                          : String(idleProbe.reason)
                        : "IMAP connection failed.",
                      // smtp/imap above both attach this; idleProbe never did,
                      // so an idle-specific failure (e.g. the wrong-folder bug
                      // just fixed above) gave no actionable next step despite
                      // this tool's own description promising one.
                      diagnosis: diagnoseFailure(idleProbe.reason),
                    },
            backgroundSync: backgroundSyncService.getStatus(),
            index: indexStatus,
            integrity,
            drafts: {
              total: drafts.length,
              syncFailed: drafts.filter((draft) => draft.remoteSyncState === "sync_failed").length,
              syncFailedIds: drafts
                .filter((draft) => draft.remoteSyncState === "sync_failed")
                .map((draft) => draft.id),
            },
            audit: {
              path: auditService.getPath(),
            },
            // What this server can and cannot do, given Proton Bridge only proxies
            // local IMAP/SMTP — prevents an agent from attempting an impossible
            // operation (e.g. server-side filters) and getting a confusing failure.
            capabilities: {
              supported: ["mail read/search/send", "folders", "labels (IMAP folders under Labels/)", "drafts", "local full-text index"],
              notSupported: [
                "server-side filters/rules (no ManageSieve access through Bridge)",
                "real contacts / address book (no CardDAV access through Bridge)",
                "calendar (no CalDAV access through Bridge)",
                "vacation responder (Proton account API only, not exposed via Bridge)",
              ],
            },
            accounts: accountsInfo,
          });
        }

        case "get_runtime_status": {
          const [indexStatus, drafts] = await Promise.all([
            localIndexService.getStatus(),
            draftStore.listDrafts(true),
          ]);
          // Per-account breakdown, purely additive alongside every existing top-level
          // field above (which keep describing the PRIMARY account only, unchanged, for
          // backward compatibility) — same shape list_accounts already returns, index
          // status only (no live connection check here — this tool is meant to be fast,
          // unlike run_doctor).
          const accountsInfo = await Promise.all(
            accountManager.all().map(async (bundle) => {
              const accountIndexStatus = await bundle.localIndexService.getStatus();
              return {
                slug: bundle.account.slug,
                address: bundle.account.address,
                isPrimary: bundle.account.slug === primaryBundle.account.slug,
                index: { storedMessageCount: accountIndexStatus.storedMessageCount, updatedAt: accountIndexStatus.updatedAt, isStale: accountIndexStatus.isStale },
                backgroundSync: bundle.backgroundSyncService.getStatus(),
                health: healthProblems(bundle.backgroundSyncService.getStatus(), accountIndexStatus),
              };
            }),
          );
          return createTextResult({
            checkedAt: new Date().toISOString(),
            runtime: sanitizeRuntimeConfig(config.runtime),
            backgroundSync: backgroundSyncService.getStatus(),
            health: healthProblems(backgroundSyncService.getStatus(), indexStatus),
            imapIdle: imapService.getIdleStatus(),
            index: indexStatus,
            audit: {
              enabled: true,
            },
            drafts: {
              total: drafts.length,
              active: drafts.filter((draft) => draft.status !== "sent").length,
              remoteSynced: drafts.filter((draft) => draft.remoteSyncState === "synced").length,
              syncFailed: drafts.filter((draft) => draft.remoteSyncState === "sync_failed").length,
            },
            accounts: accountsInfo,
          });
        }

        case "list_accounts": {
          const checkConnections = normalizeBoolean(args.checkConnections, false);
          const accountsInfo = await Promise.all(
            accountManager.all().map(async (bundle) => {
              const [indexStatus, connection] = await Promise.all([
                bundle.localIndexService.getStatus(),
                checkConnections
                  ? Promise.allSettled([bundle.smtpService.verifyConnection(), bundle.imapService.ping()]).then(
                      ([smtpResult, imapResult]) => ({
                        smtp: smtpResult.status === "fulfilled" ? { ok: true } : { ok: false, error: describeImapError(smtpResult.reason) },
                        imap: imapResult.status === "fulfilled" ? { ok: true } : { ok: false, error: describeImapError(imapResult.reason) },
                      }),
                    )
                  : Promise.resolve(undefined),
              ]);
              return {
                slug: bundle.account.slug,
                address: bundle.account.address,
                isPrimary: bundle.account.slug === accountManager.primary().account.slug,
                imapUsername: bundle.account.imap.username,
                smtpUsername: bundle.account.smtp.username,
                dataDir: bundle.account.dataDir,
                index: { storedMessageCount: indexStatus.storedMessageCount, updatedAt: indexStatus.updatedAt, isStale: indexStatus.isStale },
                connection,
              };
            }),
          );
          return createTextResult({
            checkedAt: new Date().toISOString(),
            total: accountsInfo.length,
            accounts: accountsInfo,
            note: "Prefix an emailId/draftId with '<slug>::' to target a non-primary account in any other tool; a plain id always means the primary account.",
          });
        }

        case "run_background_sync":
        {
          const target = resolveAccountArg(args) ?? primaryBundle;
          return createTextResult({
            checkedAt: new Date().toISOString(),
            backgroundSync: await target.backgroundSyncService.runNow(),
            index: await target.localIndexService.getStatus(),
          });

        }

        case "wait_for_mailbox_changes":
        {
          const target = resolveAccountArg(args) ?? primaryBundle;
          return createTextResult(
            await target.imapService.waitForMailboxChanges({
              folder: optionalString(args, "folder"),
              timeoutMs: normalizeLimit(args.timeoutSeconds, 15, 1, 300) * 1000,
            }),
          );
        }

        case "sync_emails":
        {
          const target = resolveAccountArg(args) ?? primaryBundle;
          const folder = optionalString(args, "folder");
          const full = optionalBoolean(args.full);
          const limitPerFolder = optionalInteger(args.limitPerFolder, 1, 50_000);
          const includeAttachmentText =
            optionalBoolean(args.includeAttachmentText);

          // target.backgroundSyncService.runNow() always runs the *fixed* background-
          // sync config (autoSyncFolder/autoSyncFull/autoSyncLimitPerFolder —
          // typically just "INBOX,Sent", incremental, 100/folder) and ignores
          // any argument entirely. This tool's own schema advertises folder/
          // full/limitPerFolder/includeAttachmentText as per-call overrides,
          // but every one of them was silently discarded — a caller asking to
          // sync "Archive" with full:true got back a status snapshot of the
          // last INBOX/Sent background run, with Archive never touched at
          // all. Found live: sync_emails({folder:"Archive", full:true}) did
          // not add an Archive entry to get_index_status's syncCheckpoints.
          // When the caller supplies any of these, run a one-off sync with
          // their actual parameters instead.
          if (folder !== undefined || full !== undefined || limitPerFolder !== undefined || includeAttachmentText !== undefined) {
            // Commit each folder to the index as soon as it is fetched (rather than one
            // recordSnapshot after ALL folders), and stop starting new folders once the time
            // budget is spent. Before this, a full sync over many folders that hit the
            // client's request timeout lost everything it had already fetched and gave the
            // caller no way to tell what had synced. The default budget sits below typical
            // 60s MCP client timeouts; a single folder in flight still runs to completion.
            const budgetMs = normalizeLimit(args.timeBudgetSeconds, 45, 1, 300) * 1000;
            const startedAtMs = Date.now();
            const snapshot = await target.imapService.collectEmailsForIndex({
              folder,
              full,
              limitPerFolder,
              includeAttachmentText,
              checkpoints: await target.localIndexService.getSyncCheckpointMap(),
              deadlineAt: startedAtMs + budgetMs,
              onFolderCollected: async (batch) => {
                await target.localIndexService.recordSnapshot({
                  folders: [],
                  emails: batch.emails,
                  syncedAt: batch.checkpoint.lastSyncAt ?? new Date().toISOString(),
                  folderStats: [batch.checkpoint],
                });
              },
            });
            // Final commit carries the complete folder list (folder counts, pruning of folders
            // deleted server-side) — no messages, those were committed per folder above.
            const indexStatus = await target.localIndexService.recordSnapshot({
              folders: snapshot.folders,
              folderListComplete: true,
              emails: [],
              syncedAt: snapshot.syncedAt,
              folderStats: [],
            });
            return createTextResult({
              checkedAt: new Date().toISOString(),
              complete: snapshot.complete,
              remainingFolders: snapshot.remainingFolders,
              ...(snapshot.failedFolders.length > 0 ? { failedFolders: snapshot.failedFolders } : {}),
              ...(snapshot.skippedFolders.length > 0 ? { skippedFolders: snapshot.skippedFolders } : {}),
              elapsedMs: Date.now() - startedAtMs,
              budgetMs,
              ...(snapshot.complete
                ? {}
                : { note: "Time budget reached; completed folders are already committed. Call sync_emails again with the same arguments to continue with remainingFolders." }),
              synced: {
                folder: folder ?? "all",
                full: Boolean(full),
                complete: snapshot.complete,
                remainingFolders: snapshot.remainingFolders,
                folderStats: snapshot.folderStats,
                // Per-folder progress: `moreHistory` is true while a full sync is still walking
                // backward through history or an incremental catch-up cursor is pending.
                folderProgress: snapshot.folderStats.map((stat) => ({
                  folder: stat.folder,
                  fetched: stat.fetched ?? 0,
                  total: stat.total,
                  strategy: stat.strategy,
                  moreHistory:
                    stat.incrementalResumeUid !== undefined ||
                    (Boolean(full) && stat.backfilledToUid !== undefined && stat.backfilledToUid > 1),
                })),
              },
              index: {
                updatedAt: indexStatus.updatedAt,
                storedMessageCount: indexStatus.storedMessageCount,
                dedupedMessageCount: indexStatus.dedupedMessageCount,
                path: indexStatus.path,
              },
            });
          }

          const syncStatus = await target.backgroundSyncService.runNow("sync_emails");
          const indexStatus = await target.localIndexService.getStatus();
          return createTextResult({
            checkedAt: new Date().toISOString(),
            backgroundSync: syncStatus,
            index: {
              updatedAt: indexStatus.updatedAt,
              storedMessageCount: indexStatus.storedMessageCount,
              dedupedMessageCount: indexStatus.dedupedMessageCount,
              path: indexStatus.path,
            },
          });
        }

        case "get_index_status":
        {
          const statusBundle = resolveAccountArg(args) ?? primaryBundle;
          const indexStatus = await statusBundle.localIndexService.getStatus();
          const syncCfg = statusBundle.backgroundSyncService.getStatus();
          return createTextResult({
            ...indexStatus,
            // What keeps this index current, so a stale/missing message can be explained:
            // only these folders are synced in the background, and IDLE watches just the first.
            backgroundSync: {
              enabled: syncCfg.enabled,
              intervalMinutes: syncCfg.intervalMinutes,
              folders: syncCfg.folder,
              idleWatching: syncCfg.idleWatching,
              lastSuccessAt: syncCfg.lastSuccessAt,
              lastError: syncCfg.lastError,
            },
          });
        }

        case "search_indexed_emails":
        {
          const searchIndexedInput = {
            query: optionalString(args, "query"),
            folder: optionalString(args, "folder"),
            label: optionalString(args, "label"),
            threadId: optionalString(args, "threadId"),
            from: optionalString(args, "from"),
            to: optionalString(args, "to"),
            senderDomain: optionalString(args, "senderDomain"),
            subject: optionalString(args, "subject"),
            hasAttachment:
              optionalBoolean(args.hasAttachment),
            attachmentName: optionalString(args, "attachmentName"),
            isRead: optionalBoolean(args.isRead),
            isStarred: optionalBoolean(args.isStarred),
            mailboxRole: optionalString(args, "mailboxRole"),
            dateFrom: optionalString(args, "dateFrom"),
            dateTo: optionalString(args, "dateTo"),
            limit: optionalInteger(args.limit, 1, 1000),
          };
          const indexedAccount = resolveAccountArg(args);
          // Serve fresh data: a cheap UIDNEXT/message-count probe, refreshing only when the
          // mailbox moved. This search used to read the index as-is, so mail that arrived
          // after the last sync was reported missing. A refresh failure (Bridge down) must
          // never block serving the local index, which is the point of this tool.
          const refreshTargets = indexedAccount ? [indexedAccount] : accountManager.all();
          await Promise.all(refreshTargets.map((bundle) => refreshIndexForSearch(bundle)));
          if (accountManager.all().length === 1) {
            const result = await localIndexService.search(searchIndexedInput);
            return createTextResult(
              { ...result, emails: projectFields(result.emails, parseFieldsArg(args.fields)) },
              false,
              result.emails.map(emailSource),
            );
          }
          // Merge strategy: search every account's local index independently,
          // tag ids with the account slug, concatenate, re-sort newest-first
          // (each account's own list already arrives relevance-sorted, so this
          // is an approximation of a single global ranking), then re-apply the
          // requested limit across the merged set and sum totals/hasMore.
          const primarySlugForSearch = accountManager.primary().account.slug;
          const searchPerAccount = await Promise.all(
            (indexedAccount ? [indexedAccount] : accountManager.all()).map(async (bundle) => ({ bundle, result: await bundle.localIndexService.search(searchIndexedInput) })),
          );
          const searchLimit = searchIndexedInput.limit ?? 50;
          const taggedSearchEmails = searchPerAccount.flatMap(({ bundle, result }) =>
            result.emails.map((email) => ({ ...email, id: withAccountPrefix(accountSlugForTag(bundle, primarySlugForSearch), email.id) })),
          );
          const mergedSearchEmails = sortByDateDesc(taggedSearchEmails, (email) => email.internalDate || email.date).slice(0, searchLimit);
          const totalSearch = searchPerAccount.reduce((sum, { result }) => sum + result.total, 0);
          const warnings = searchPerAccount.flatMap(({ result }) => result.warnings ?? []);
          const primarySearchEntry = searchPerAccount.find(({ bundle }) => bundle.account.slug === primarySlugForSearch) ?? searchPerAccount[0];
          return createTextResult(
            {
              total: totalSearch,
              hasMore: totalSearch > mergedSearchEmails.length,
              emails: projectFields(mergedSearchEmails, parseFieldsArg(args.fields)),
              lastSyncAt: primarySearchEntry?.result.lastSyncAt,
              ...(warnings.length > 0 ? { warnings } : {}),
            },
            false,
            mergedSearchEmails.map(emailSource),
          );
        }

        case "get_labels":
        {
          const labelsLimit = normalizeLimit(args.limit, 250);
          if (accountManager.all().length === 1) {
            resolveAccountArg(args);
            const labels = await localIndexService.getLabels(labelsLimit);
            return createTextResult({
              total: labels.length,
              labels,
            });
          }
          // Merge strategy: fetch each account's own label list and sum
          // messageCount/unreadCount/threadCount for labels that share the same
          // name+type across accounts, so e.g. "INBOX" folders from two accounts
          // combine into one row rather than appearing as unrelated duplicates.
          const perAccountLabels = await Promise.all(
            selectedBundles(args).map((bundle) => bundle.localIndexService.getLabels(labelsLimit)),
          );
          const mergedLabels = mergeMailboxLabels(perAccountLabels).slice(0, labelsLimit);
          return createTextResult({
            total: mergedLabels.length,
            labels: mergedLabels,
          });
        }

        case "get_threads":
        {
          const threadsInput = {
            query: optionalString(args, "query"),
            label: optionalString(args, "label"),
            folder: optionalString(args, "folder"),
            limit: optionalInteger(args.limit, 1, 1000),
            offset: optionalInteger(args.offset, 0, 1_000_000),
          };
          if (accountManager.all().length === 1) {
            resolveAccountArg(args);
            await maybeRefreshLocalIndex(imapService, localIndexService, {
              folder: "INBOX",
              limitPerFolder: 100,
            });
            const result = await localIndexService.getThreads(threadsInput);
            const budgeted = trimThreadsToBudget(result.threads);
            return createTextResult(
              { ...result, threads: budgeted.threads, ...paginationFields(result.total, result.offset, budgeted.threads.length, budgeted.trimmed) },
              false,
              budgeted.threads.map(threadSource),
            );
          }
          // Merge strategy: refresh and query each account's own thread index
          // independently, tag thread ids with the account slug, concatenate,
          // re-sort newest-first by latestDate, then re-apply the requested
          // limit across the merged set and sum totals/hasMore.
          const primarySlugForThreads = accountManager.primary().account.slug;
          const threadsPerAccount = await Promise.all(
            selectedBundles(args).map(async (bundle) => {
              await maybeRefreshLocalIndex(bundle.imapService, bundle.localIndexService, {
                folder: "INBOX",
                limitPerFolder: 100,
              });
              return {
                bundle,
                result: await bundle.localIndexService.getThreads({
                  ...threadsInput,
                  limit: (threadsInput.limit ?? 100) + (threadsInput.offset ?? 0),
                  offset: 0,
                }),
              };
            }),
          );
          const threadsLimit = threadsInput.limit ?? 100;
          const taggedThreads = threadsPerAccount.flatMap(({ bundle, result }) =>
            result.threads.map((thread) => ({
              ...thread,
              id: withAccountPrefix(accountSlugForTag(bundle, primarySlugForThreads), thread.id),
              messageIds: thread.messageIds.map((id) => withAccountPrefix(accountSlugForTag(bundle, primarySlugForThreads), id)),
            })),
          );
          const threadsOffset = threadsInput.offset ?? 0;
          const pagedThreads = sortByDateDesc(taggedThreads, (thread) => thread.latestDate).slice(threadsOffset, threadsOffset + threadsLimit);
          const budgetedThreads = trimThreadsToBudget(pagedThreads);
          const mergedThreads = budgetedThreads.threads;
          const totalThreads = threadsPerAccount.reduce((sum, { result }) => sum + result.total, 0);
          return createTextResult(
            {
              total: totalThreads,
              ...paginationFields(totalThreads, threadsOffset, mergedThreads.length, budgetedThreads.trimmed),
              threads: mergedThreads,
            },
            false,
            mergedThreads.map(threadSource),
          );
        }

        case "get_actionable_threads":
        {
          const limit = normalizeLimit(args.limit, 50, 1, 1000);
          const offset = normalizeLimit(args.offset, 0, 0, 1_000_000);
          // Fan-out merge: ask every account for its own top-`limit` actionable threads
          // (each account's own getActionableThreads already sorts by score, then
          // recency — see local-index-service.ts), tag every thread/message id with its
          // account's slug, then merge all accounts' lists, re-sort by that exact same
          // (score, then latestDate) order, and take the top `limit` of the MERGED set —
          // never per-account. Requesting `limit` (not divided) from each account is what
          // makes this correct: any thread in the true global top-`limit` must already
          // rank within its own account's top-`limit`, since a lower rank there would mean
          // at least `limit` better-or-equal threads exist ahead of it account-wide alone.
          const perAccount = await Promise.all(
            selectedBundles(args).map(async (bundle) => {
              const refresh = await maybeRefreshLocalIndex(bundle.imapService, bundle.localIndexService, {
                force: normalizeBoolean(args.syncBefore, false),
                folder: "INBOX",
                limitPerFolder: 100,
              });
              const result = await bundle.localIndexService.getActionableThreads({
                query: optionalString(args, "query"),
                label: optionalString(args, "label"),
                pendingOn:
                  args.pendingOn === "you" || args.pendingOn === "them" || args.pendingOn === "any"
                    ? args.pendingOn
                    : undefined,
                unreadOnly: normalizeBoolean(args.unreadOnly, true),
                limit: limit + offset,
              });
              return { bundle, refresh, result };
            }),
          );
          const mergedThreads = perAccount
            .flatMap(({ bundle, result }) => tagAccountIds(slugForBundle(bundle), result.threads))
            .sort((left: ActionableThreadSummary, right: ActionableThreadSummary) => {
              if (right.score !== left.score) return right.score - left.score;
              return new Date(right.latestDate || 0).getTime() - new Date(left.latestDate || 0).getTime();
            })
            .slice(offset, offset + limit);
          const budgetedActionable = trimThreadsToBudget(mergedThreads);
          const totalCount = perAccount.reduce((sum, { result }) => sum + result.total, 0);
          const messagesCapped = perAccount.some(({ result }) => result.messagesCapped);
          const latestRefresh = perAccount.map(({ refresh }) => refresh).find((refresh) => refresh);
          const actionableFreshness = perAccount.find(({ result }) => result.lastSyncAt)?.result;
          return createTextResult(
            {
              total: totalCount,
              ...paginationFields(totalCount, offset, budgetedActionable.threads.length, budgetedActionable.trimmed),
              threads: budgetedActionable.threads,
              ...(actionableFreshness?.lastSyncAt ? { lastSyncAt: actionableFreshness.lastSyncAt, indexFreshnessMinutes: actionableFreshness.indexFreshnessMinutes } : {}),
              ...(perAccount.some(({ result }) => result.stale) ? { stale: true } : {}),
              ...(messagesCapped ? { messagesCapped: true } : {}),
              ...(latestRefresh ? { indexUpdatedAt: latestRefresh.indexStatus.updatedAt } : {}),
            },
            false,
            budgetedActionable.threads.map(threadSource),
          );
        }

        case "get_inbox_digest":
        {
          const limit = normalizeLimit(args.limit, 10, 1, 1000);
          const offset = normalizeLimit(args.offset, 0, 0, 1_000_000);
          // Each account is asked for offset+limit+1 rows per section: enough to slice the requested
          // page from the merged list and to know whether another page exists.
          const perAccountWindow = offset + limit + 1;
          // Fan-out merge: get_inbox_digest already internally aggregates two lists
          // (topThreads by score/recency, staleAwaitingYou by score/recency) plus a
          // `counts` summary — mirror that same internal merge style across accounts.
          // Ask each account for its own top-`limit` of both lists, tag ids with the
          // account's slug, concatenate each list across accounts, re-sort by the same
          // (score, then latestDate) order the single-account version uses, and take the
          // top `limit` of the MERGED list (never per-account — see get_actionable_threads
          // for why requesting `limit`, not limit/accounts, per account is what makes this
          // correct). `counts` is summed across accounts field-by-field.
          const perAccount = await Promise.all(
            selectedBundles(args).map(async (bundle) => {
              await maybeRefreshLocalIndex(bundle.imapService, bundle.localIndexService, {
                force: normalizeBoolean(args.syncBefore, false),
                folder: "INBOX",
                limitPerFolder: 100,
              });
              const result = await bundle.localIndexService.getInboxDigest({
                limit: perAccountWindow,
                minAgeHours: optionalNumber(args.minAgeHours, 0, 87_600),
              });
              const slug = slugForBundle(bundle);
              return {
                counts: (result.counts ?? {}) as Record<string, number>,
                countsCapped: result.countsCapped === true,
                indexUpdatedAt: result.indexUpdatedAt as string | undefined,
                topThreads: tagAccountIds(slug, (result.topThreads ?? []) as ActionableThreadSummary[]),
                staleAwaitingYou: tagAccountIds(slug, (result.staleAwaitingYou ?? []) as ActionableThreadSummary[]),
              };
            }),
          );
          const byScoreThenDate = (left: ActionableThreadSummary, right: ActionableThreadSummary) => {
            if (right.score !== left.score) return right.score - left.score;
            return new Date(right.latestDate || 0).getTime() - new Date(left.latestDate || 0).getTime();
          };
          const mergedTop = perAccount.flatMap((entry) => entry.topThreads).sort(byScoreThenDate);
          const mergedStale = perAccount.flatMap((entry) => entry.staleAwaitingYou).sort(byScoreThenDate);
          const topBudget = trimThreadsToBudget(mergedTop.slice(offset, offset + limit), THREAD_LIST_RESPONSE_BUDGET_CHARS / 2);
          const staleBudget = trimThreadsToBudget(mergedStale.slice(offset, offset + limit), THREAD_LIST_RESPONSE_BUDGET_CHARS / 2);
          const topThreads = topBudget.threads;
          const staleAwaitingYou = staleBudget.threads;
          const countKeys = new Set(perAccount.flatMap((entry) => Object.keys(entry.counts)));
          const counts: Record<string, number> = {};
          for (const key of countKeys) {
            counts[key] = perAccount.reduce((sum, entry) => sum + (entry.counts[key] ?? 0), 0);
          }
          // Reply reminders whose date has passed with no answer: they belong in a triage summary.
          const dueReminders = (await evaluateReminders(selectedBundles(args))).filter((reminder) => reminder.state === "due");
          const result = {
            generatedAt: new Date().toISOString(),
            indexUpdatedAt: perAccount.map((entry) => entry.indexUpdatedAt).filter(Boolean).sort().reverse()[0],
            counts,
            ...(perAccount.some((entry) => entry.countsCapped)
              ? { countsCapped: true, countsNote: "counts and topThreads cover only the newest 5000 indexed messages per account; counts.staleAwaitingYou covers every thread in the index, so it is not comparable with them." }
              : {}),
            topThreads,
            staleAwaitingYou,
            ...(dueReminders.length > 0 ? { repliesDue: dueReminders.slice(0, 10), repliesDueTotal: dueReminders.length } : {}),
            // Each section pages independently with the same offset/limit: pass nextOffset back as
            // `offset` to continue (a section with hasMore:false is exhausted).
            paging: {
              topThreads: paginationFields(mergedTop.length, offset, topThreads.length, topBudget.trimmed),
              staleAwaitingYou: paginationFields(mergedStale.length, offset, staleAwaitingYou.length, staleBudget.trimmed),
            },
            ...(topBudget.trimmed > 0 || staleBudget.trimmed > 0 ? { truncatedForSize: true } : {}),
          };
          return createTextResult(
            result,
            false,
            [...topThreads, ...staleAwaitingYou].map(threadSource),
          );
        }

        case "get_follow_up_candidates":
        {
          const limit = normalizeLimit(args.limit, 25, 1, 1000);
          const offset = normalizeLimit(args.offset, 0, 0, 1_000_000);
          // Fan-out merge: ask every account for its own top-`limit` follow-up
          // candidates (each account's own getFollowUpCandidates sorts by ageHours, then
          // score), tag ids with the account's slug, concatenate, re-sort by that same
          // (ageHours, then score) order, and take the top `limit` of the MERGED set —
          // same correctness argument as get_actionable_threads' fan-out.
          const perAccount = await Promise.all(
            selectedBundles(args).map(async (bundle) => {
              await maybeRefreshLocalIndex(bundle.imapService, bundle.localIndexService, {
                force: normalizeBoolean(args.syncBefore, false),
                folder: "INBOX",
                limitPerFolder: 100,
              });
              const result = await bundle.localIndexService.getFollowUpCandidates({
                limit: limit + offset,
                minAgeHours: optionalNumber(args.minAgeHours, 0, 87_600),
                pendingOn:
                  args.pendingOn === "you" || args.pendingOn === "them" || args.pendingOn === "any"
                    ? args.pendingOn
                    : undefined,
              });
              return {
                bundle,
                indexUpdatedAt: result.indexUpdatedAt as string | undefined,
                threads: tagAccountIds(slugForBundle(bundle), (result.threads ?? []) as (ActionableThreadSummary & { ageHours?: number })[]),
                total: (result.total as number) ?? 0,
              };
            }),
          );
          const threads = perAccount
            .flatMap((entry) => entry.threads)
            .sort((left, right) => {
              if ((right.ageHours ?? 0) !== (left.ageHours ?? 0)) return (right.ageHours ?? 0) - (left.ageHours ?? 0);
              return right.score - left.score;
            })
            .slice(offset, offset + limit);
          const followUpBudget = trimThreadsToBudget(threads);
          const totalCount = perAccount.reduce((sum, entry) => sum + entry.total, 0);
          const result = {
            generatedAt: new Date().toISOString(),
            indexUpdatedAt: perAccount.map((entry) => entry.indexUpdatedAt).filter(Boolean).sort().reverse()[0],
            minAgeHours: (optionalNumber(args.minAgeHours, 0, 87_600) ?? 24),
            pendingOn: args.pendingOn === "you" || args.pendingOn === "them" || args.pendingOn === "any" ? args.pendingOn : "you",
            total: totalCount,
            ...paginationFields(totalCount, offset, followUpBudget.threads.length, followUpBudget.trimmed),
            threads: followUpBudget.threads,
          };
          return createTextResult(
            result,
            false,
            followUpBudget.threads
              .filter((thread): thread is ActionableThreadSummary & { ageHours?: number } & { id: string; subject: string; latestDate?: string; messageCount: number; normalizedLabels?: string[]; participants?: EmailAddress[] } =>
                Boolean(thread && typeof thread === "object" && "id" in thread),
              )
              .map(threadSource),
          );
        }

        case "find_document_threads":
        {
          const limit = normalizeLimit(args.limit, 25, 1, 1000);
          // Fan-out merge: ask every account for its own top-`limit` document threads
          // (each account's own findDocumentThreads sorts by document count, then
          // recency), tag ids (including each document's own emailId) with the
          // account's slug, concatenate, re-sort by that same order, and take the top
          // `limit` of the MERGED set — same correctness argument as
          // get_actionable_threads' fan-out.
          const category =
            args.category === "document" ||
            args.category === "invoice" ||
            args.category === "contract" ||
            args.category === "travel" ||
            args.category === "calendar"
              ? args.category
              : "document";
          const perAccount = await Promise.all(
            selectedBundles(args).map(async (bundle) => {
              await maybeRefreshLocalIndex(bundle.imapService, bundle.localIndexService, {
                force: normalizeBoolean(args.syncBefore, false),
                folder: "INBOX",
                limitPerFolder: 100,
              });
              const result = await bundle.localIndexService.findDocumentThreads({
                category,
                query: optionalString(args, "query"),
                limit,
              });
              type DocumentThread = ThreadDetail & { documents: { emailId: string; subject: string; filename?: string; kind?: string; contentType?: string }[] };
              return {
                indexUpdatedAt: result.indexUpdatedAt as string | undefined,
                threads: tagAccountIds(slugForBundle(bundle), (result.threads ?? []) as DocumentThread[]),
                total: (result.total as number) ?? 0,
              };
            }),
          );
          const threads = perAccount
            .flatMap((entry) => entry.threads)
            .sort((left, right) => {
              if (right.documents.length !== left.documents.length) return right.documents.length - left.documents.length;
              return new Date(right.latestDate || 0).getTime() - new Date(left.latestDate || 0).getTime();
            })
            .slice(0, limit);
          const totalCount = perAccount.reduce((sum, entry) => sum + entry.total, 0);
          const result = {
            generatedAt: new Date().toISOString(),
            indexUpdatedAt: perAccount.map((entry) => entry.indexUpdatedAt).filter(Boolean).sort().reverse()[0],
            category,
            total: totalCount,
            hasMore: totalCount > limit,
            threads,
          };
          return createTextResult(
            result,
            false,
            threads.map(threadSource),
          );
        }

        case "prepare_meeting_context":
        {
          const limit = normalizeLimit(args.limit, 10, 1, 1000);
          // Fan-out merge: ask every account for its own top-`limit` meeting-prep
          // threads (each account's own getMeetingPrep sorts by recency — see
          // local-index-service.ts), tag ids with the account's slug, concatenate,
          // re-sort by that same recency order, and take the top `limit` of the
          // MERGED set — same correctness argument as get_actionable_threads' fan-out.
          const perAccount = await Promise.all(
            selectedBundles(args).map(async (bundle) => {
              await maybeRefreshLocalIndex(bundle.imapService, bundle.localIndexService, {
                force: normalizeBoolean(args.syncBefore, false),
                folder: "INBOX",
                limitPerFolder: 100,
              });
              const result = await bundle.localIndexService.getMeetingPrep({
                person: optionalString(args, "person"),
                domain: optionalString(args, "domain"),
                limit,
              });
              return {
                indexUpdatedAt: result.indexUpdatedAt as string | undefined,
                threads: tagAccountIds(slugForBundle(bundle), (result.threads ?? []) as ThreadDetail[]),
                total: (result.total as number) ?? 0,
              };
            }),
          );
          const threads = perAccount
            .flatMap((entry) => entry.threads)
            .sort((left, right) => new Date(right.latestDate || 0).getTime() - new Date(left.latestDate || 0).getTime())
            .slice(0, limit);
          const totalCount = perAccount.reduce((sum, entry) => sum + entry.total, 0);
          const result = {
            generatedAt: new Date().toISOString(),
            indexUpdatedAt: perAccount.map((entry) => entry.indexUpdatedAt).filter(Boolean).sort().reverse()[0],
            total: totalCount,
            hasMore: totalCount > limit,
            threads,
          };
          return createTextResult(
            result,
            false,
            threads.map(threadSource),
          );
        }

        case "get_thread_brief":
        {
          // Fanned out across accounts the same way emailId-targeted tools resolve a
          // specific account: the threadId's optional "<slug>::" prefix (from a merged
          // digest/follow-up/etc. result above) picks the owning account's bundle, same
          // pattern as resolveAccountForEmailId. A plain, unprefixed threadId still
          // means the primary account, unchanged from single-account behavior.
          const { bundle, rest } = resolveAccountForEmailId(requireString(args, "threadId"));
          const slug = slugForBundle(bundle);
          await maybeRefreshLocalIndex(bundle.imapService, bundle.localIndexService, {
            folder: "INBOX",
            limitPerFolder: 100,
          });
          const rawThread = await bundle.localIndexService.getThreadById(rest);
          const thread = tagAccountIds(slug, rawThread);
          const result = buildThreadBrief(thread, bundle.config.smtp.username);
          return createTextResult(
            result,
            false,
            [
              threadSource(thread),
              ...thread.messages.map((message) =>
                emailSource({
                  id: message.primaryEmailId,
                  subject: message.subject,
                  folder: message.folder,
                  date: message.date,
                  internalDate: message.internalDate,
                  preview: message.preview,
                  from: message.from,
                  messageId: message.messageId,
                  threadId: thread.id,
                }),
              ),
            ],
          );
        }

        case "get_thread_by_id":
        {
          // A threadId is only ever valid within the single account it was
          // produced by (see get_threads/search_indexed_emails above) — this is
          // a routed lookup, not a fan-out/merge: resolve the optional
          // "<slug>::" prefix (added when the id came from a non-primary
          // account) back to that account's bundle, defaulting to the primary
          // for a plain id exactly as before multi-account support existed.
          const rawThreadId = requireString(args, "threadId");
          const { accountSlug: threadAccountSlug, rest: unprefixedThreadId } = splitAccountPrefix(
            rawThreadId,
            accountManager.additionalSlugs(),
          );
          const threadBundle = accountManager.bySlugOrPrimary(threadAccountSlug);
          await maybeRefreshLocalIndex(threadBundle.imapService, threadBundle.localIndexService, {
            folder: "INBOX",
            limitPerFolder: 100,
          });
          const rawFolders = args?.folders;
          const threadFolders = Array.isArray(rawFolders) ? rawFolders.filter((f): f is string => typeof f === "string") : undefined;
          const rawThread = await threadBundle.localIndexService.getThreadById(unprefixedThreadId);
          const thread = threadAccountSlug
            ? {
                ...rawThread,
                id: withAccountPrefix(threadAccountSlug, rawThread.id),
                messageIds: rawThread.messageIds.map((id) => withAccountPrefix(threadAccountSlug, id)),
              }
            : rawThread;
          const filteredThread = threadFolders && threadFolders.length > 0
            ? {
                ...thread,
                messages: thread.messages.filter((message) => threadFolders.includes(message.folder)),
                messageCount: thread.messages.filter((message) => threadFolders.includes(message.folder)).length,
                unreadCount: thread.messages.filter((message) => threadFolders.includes(message.folder) && !message.isRead).length,
              }
            : thread;
          // Same per-call attachment trimming as every search/list tool — see
          // projectFields' comment. get_thread_by_id's messages carry full
          // MailboxMessage/EmailSummary objects (unlike get_threads' lean
          // ThreadSummary list, which has no per-message attachments at all).
          const result = { ...filteredThread, messages: filteredThread.messages.map(trimAttachmentsForListing) };
          return createTextResult(
            result,
            false,
            [threadSource(result), ...result.messages.map((message) => emailSource({
              id: message.primaryEmailId,
              subject: message.subject,
              folder: message.folder,
              date: message.date,
              internalDate: message.internalDate,
            }))],
          );
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
          const extraCc = parseEmails(optionalString(args, "cc"));
          const extraBcc = parseEmails(optionalString(args, "bcc"));
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

        case "apply_thread_action":
        {
          // A threadId only ever names ONE account — see move_thread's
          // identical comment on reusing resolveAccountForEmailId's generic
          // "<slug>::" prefix stripping for threadIds. Every message in the
          // resolved thread therefore belongs to this same account, so
          // (unlike batch_email_action's emailIds) there is nothing to
          // group — the whole action runs against this one bundle's own
          // imapService/localIndexService/auditService. Full cross-account
          // thread resolution is out of scope for this pass.
          const { bundle, rest: threadId } = resolveAccountForEmailId(requireString(args, "threadId"));
          const outputSlug = bundle.account.slug === primaryBundle.account.slug ? undefined : bundle.account.slug;
          await maybeRefreshLocalIndex(bundle.imapService, bundle.localIndexService, {
            force: normalizeBoolean(args.syncBefore, false),
            folder: "INBOX",
            limitPerFolder: 100,
          });

          const thread = await bundle.localIndexService.getThreadById(threadId);
          const action = requireEmailAction(args);
          ensureEmailActionAllowed(config.runtime, action);
          if (action === "move" || action === "restore") {
            await ensureMoveTargetAllowed(config.runtime, bundle.imapService, optionalString(args, "targetFolder"));
          }
          const unreadOnly = normalizeBoolean(args.unreadOnly, false);
          const emailIds = [...new Set(
            thread.messages
              .filter((message) => !unreadOnly || !message.isRead)
              .map((message) => message.primaryEmailId),
          )];
          // Same safety rail as the bulk_* tools (bulk_delete etc.) — without
          // it, a thread with an arbitrarily large message count would be
          // processed in full with no size limit at all.
          ensureBulkBatchSize(emailIds.length, getBulkMaxBatchSize(args));
          if (action === "delete") {
            ensureDestructiveConfirmed(config.runtime, (normalizeBoolean(args.confirmed, false) || normalizeBoolean(args.dryRun, false)), `Permanently delete ${emailIds.length} email(s) in thread (cannot be recovered)`);
          }

          const result = await withAudit(bundle.auditService, name, args, async () =>
            applyBatchEmailAction(bundle.imapService, [], {
              emailIds,
              action,
              targetFolder: optionalString(args, "targetFolder"),
              continueOnError: normalizeBoolean(args.continueOnError, true),
              dryRun: normalizeBoolean(args.dryRun, false),
            }),
          );
          const prefixedResult: BatchActionResult = {
            ...result,
            results: result.results.map((entry) => ({ ...entry, emailId: withAccountPrefix(outputSlug, entry.emailId) })),
          };

          const sources = [
            threadSource(thread),
            ...result.results.flatMap((entry) => (entry.ok ? emailSourceFromActionResult(entry.result) : [])),
          ];

          return createTextResult(
            {
              threadId: withAccountPrefix(outputSlug, thread.id),
              unreadOnly,
              dryRun: normalizeBoolean(args.dryRun, false),
              ...prefixedResult,
            },
            false,
            sources,
          );
        }

        case "list_attachments":
        case "get_attachment_content":
        case "get_attachment_text":
        case "save_attachment":
        case "save_attachments":
          return await handleAttachmentTool(name, args, ctx);

        case "export_email": {
          const rawEmailId = requireString(args, "emailId");
          const { bundle, rest: emailId } = resolveAccountForEmailId(rawEmailId);
          const result = await withAudit(auditService, name, args, async () =>
            bundle.imapService.exportEmail(emailId, optionalString(args, "outputPath")),
          );
          result.emailId = prefixedIdFor(bundle, result.emailId);
          return createTextResult(result);
        }

        case "import_email": {
          ensureMailboxWriteAllowed(config.runtime);
          const rawText = optionalString(args, "raw");
          const rawBase64 = optionalString(args, "rawBase64");
          if (!rawText && !rawBase64) {
            throw new McpError(ErrorCode.InvalidParams, "Provide raw or rawBase64.");
          }
          if (rawText && rawBase64) {
            throw new McpError(ErrorCode.InvalidParams, "Provide raw OR rawBase64, not both.");
          }
          // Many real .eml exports use a legacy 8-bit charset (ISO-8859-1,
          // Windows-1252, etc.) outside of MIME-encoded parts — decoding
          // those bytes as UTF-8 either mangles them or throws outright.
          // rawBase64 preserves the message byte-for-byte regardless of
          // its original encoding.
          // Bounded before the bytes are decoded: base64 is about a third larger than what it encodes.
          if ((rawBase64 ?? rawText ?? "").length > MAX_IMPORT_MESSAGE_BYTES * (rawBase64 ? 4 / 3 : 1)) {
            throw new McpError(ErrorCode.InvalidParams, `The message is larger than the ${Math.round(MAX_IMPORT_MESSAGE_BYTES / 1024 / 1024)} MB import limit.`);
          }
          const raw = rawBase64
            ? Buffer.from(rawBase64, "base64")
            : Buffer.from(rawText as string, "utf8");
          const { bundle: importBundle, paths: [importFolder] } = resolveFolderTarget(args, optionalString(args, "targetFolder") ?? "INBOX");
          const result = await withAudit(importBundle.auditService, name, args, async () =>
            importBundle.imapService.importEmail({
              raw,
              targetFolder: importFolder,
              flags: normalizeBoolean(args.markAsRead, false) ? ["\\Seen"] : [],
            }),
          );
          return createTextResult({
            ...result,
            ...(result.emailId ? { emailId: prefixedIdFor(importBundle, result.emailId) } : {}),
            ...(result.existingEmailId ? { existingEmailId: prefixedIdFor(importBundle, result.existingEmailId) } : {}),
          });
        }

        case "clear_cache":
          // Zero policy gate: this mutates local cache state, but nothing here
          // ever checked read-only mode.
          ensureMailboxWriteAllowed(config.runtime);
          analyticsService.clearCache();
          return createTextResult({
            clearedAt: new Date().toISOString(),
            ...imapService.clearCache(),
          });

        case "clear_index":
          // Zero policy gate — same gap as clear_cache, see its comment.
          ensureMailboxWriteAllowed(config.runtime);
          return createTextResult({
            clearedAt: new Date().toISOString(),
            ...(await localIndexService.clear()),
          });

        case "get_logs":
        {
          const limit = normalizeLimit(args.limit, 100);
          const offset = normalizeLimit(args.offset, 0, 0, 10_000);
          const records = logger.getLogs({
              level:
                args.level === "debug" ||
                args.level === "info" ||
                args.level === "warn" ||
                args.level === "error"
                  ? args.level
                  : undefined,
              limit: limit + offset,
            });
          return createTextResult({
            ...records,
            entries: paginateRecentRecords(records.entries, limit, offset),
          });
        }

        case "get_audit_logs":
        {
          const limit = normalizeLimit(args.limit, 100);
          const offset = normalizeLimit(args.offset, 0, 0, 10_000);
          return createTextResult(
            paginateRecentRecords(await auditService.list(limit + offset), limit, offset),
          );
        }

        default:
          throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
      }
    } catch (error) {
      // A tool that ran and failed is a tool result with isError (MCP spec), not a protocol error: clients such as
      // Claude Desktop pass a protocol error to the user as a generic "connector returned an error" and never to the
      // model, which then cannot read what went wrong or adjust (an inline limit, a missing setting). Only a tool
      // that does not exist stays a protocol error.
      // The CLI starts this server as a child with PROTONMAIL_TOOL_ERRORS=protocol: it reports a failure on stderr
      // with its own exit codes, which scripts rely on.
      const asProtocolError = process.env.PROTONMAIL_TOOL_ERRORS?.trim().toLowerCase() === "protocol";
      const failed = (message: string, code: ErrorCode = ErrorCode.InternalError): ToolResult => {
        // An McpError's own message already starts with "MCP error <code>:", and the client adds that prefix again to
        // what it receives. A plain Error with a code is sent with the message as written.
        if (asProtocolError) throw Object.assign(new Error(message), { code });
        return createTextResult(message, true);
      };
      if (error instanceof McpError) {
        const message = error.message.replace(/^(?:MCP error -?\d+: )+/, "");
        if (error.code === ErrorCode.InvalidParams && message.startsWith("Unknown tool")) {
          throw Object.assign(new Error(message), { code: error.code });
        }
        return failed(message, error.code);
      }
      if (error instanceof InvalidArgumentError) {
        return failed(error.message, ErrorCode.InvalidParams);
      }
      logger.error("Tool call failed", "MCPServer", { name, error });
      if (isLikelyAuthenticationError(error)) {
        return failed(
          "IMAP authentication failed. Check that PROTONMAIL_PASSWORD is your Proton Bridge password (not your Proton account password) and that you're signed in inside the Bridge app. Run run_doctor for a full connectivity check.",
        );
      }
      if (isLikelyTlsMismatchError(error)) {
        return failed(
          "The TLS handshake with Proton Bridge failed. PROTONMAIL_IMAP_SECURE / PROTONMAIL_SMTP_SECURE probably does not match the connection mode of that port in Bridge (implicit TLS vs STARTTLS); compare them with Bridge's settings. Run run_doctor for a full connectivity check.",
        );
      }
      if (isLikelyConnectionError(error)) {
        return failed(
          "Could not connect to Proton Bridge. Make sure the Bridge app is running, and that PROTONMAIL_IMAP_HOST/PORT and PROTONMAIL_SMTP_HOST/PORT match the ports shown in Bridge's settings. Run run_doctor for a full connectivity check.",
        );
      }
      // Every throw new Error(...) across src/services and src/utils is a
      // deliberately-worded, actionable message (not-found, validation,
      // policy-disabled, etc.) with no secrets or stack traces in it —
      // surface it directly instead of discarding it into a generic
      // "check get_logs" message that sends the caller on a diagnostic
      // wild goose chase for something that was already fully explained.
      // describeImapError additionally recovers imapflow's real failure
      // reason (its .responseText) for the many call sites that let a raw
      // IMAP NO/BAD response bubble up as a bare "Command failed".
      const message = describeImapError(error)
        ?? "An internal error occurred. Check get_logs for details, or run run_doctor for a full connectivity check.";
      return failed(message);
    }
  }));

  return {
    server,
    smtpService,
    imapService,
    localIndexService,
    draftStore,
    backgroundSyncService,
    deliveryQueueService,
    snoozeService,
    auditService,
    accountManager,
  };
}

// Stops every account's timers, then closes connections and indexes, waiting at most `timeoutMs` for the
// closing to finish. A Bridge that never answers LOGOUT must not hold the process up (imapflow's own socket
// timeout is minutes, and a pending shutdown ignores further signals).
const MAX_IMPORT_MESSAGE_BYTES = 50 * 1024 * 1024;

export async function stopAllAccounts(
  bundles: Array<Pick<AccountBundle, "backgroundSyncService" | "deliveryQueueService" | "snoozeService" | "imapService" | "smtpService" | "localIndexService">>,
  timeoutMs = 3_000,
): Promise<void> {
  for (const bundle of bundles) {
    bundle.backgroundSyncService.stop();
    bundle.deliveryQueueService.stop();
    bundle.snoozeService.stop();
  }
  const closing = Promise.allSettled(
    bundles.flatMap((bundle) => [
      Promise.resolve().then(() => bundle.imapService.disconnect()),
      Promise.resolve().then(() => bundle.smtpService.close()),
      Promise.resolve().then(() => bundle.localIndexService.close()),
    ]),
  );
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([closing, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
  if (timer) clearTimeout(timer);
}

export const NOT_CONFIGURED_MESSAGE =
  "Proton Mail Bridge Client is not configured: PROTONMAIL_USERNAME and PROTONMAIL_PASSWORD are not set. " +
  "Set them to your Bridge login (the password is the one the Proton Mail Bridge app shows under your account, " +
  "not your Proton password) and restart the server. `proton-mail-bridge-client setup-claude-desktop` does this for Claude Desktop.";

// Starts a server that lists its tools and answers every call with NOT_CONFIGURED_MESSAGE. It touches nothing:
// no data directory, no Bridge connection, no background work.
export function createUnconfiguredServer(): Server {
  const server = new Server({ name: "proton-mail-bridge-client", version: PACKAGE_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listedTools() }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    isError: true,
    content: [{ type: "text", text: NOT_CONFIGURED_MESSAGE }],
  }));
  return server;
}

async function runUnconfigured(): Promise<void> {
  logger.warn(NOT_CONFIGURED_MESSAGE, "MCPServer");
  const server = createUnconfiguredServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const leave = () => process.exit(0);
  process.on("SIGINT", leave);
  process.on("SIGTERM", leave);
  transport.onclose = leave;
}

export async function main(): Promise<void> {
  let config: ProtonMailConfig;
  try {
    config = buildConfigFromEnv();
  } catch (error) {
    if (error instanceof MissingCredentialsError) {
      await runUnconfigured();
      return;
    }
    throw error;
  }
  // Create the data directory explicitly with a restrictive mode as its very
  // first creation, before any service (draft store, template store, audit
  // log, local index, ...) does its own mkdir(dirname(...)) as a side effect
  // and inherits whatever the process umask happens to be. mkdir with
  // recursive:true is a safe no-op on an already-existing directory — it
  // will not change that directory's existing mode.
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  // mkdir's `mode` only applies when the directory doesn't already exist —
  // on every real upgrade of an existing install (the common case, not a
  // fresh one), this directory already existed at 0755 from before this fix,
  // and mkdir on an existing directory is a silent no-op for its mode.
  // Explicitly chmod it too so the restriction actually takes effect on
  // upgrade, not only on a brand-new dataDir.
  await chmod(config.dataDir, 0o700).catch(() => {});
  const { server, accountManager } = createServer(config, {
    startBackgroundSync: true,
  });

  logger.info("Starting ProtonMail MCP server", "MCPServer");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("ProtonMail MCP server ready", "MCPServer");

  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`Received ${reason}, shutting down after ${Math.round((Date.now() - processStartedAt) / 1000)} s`, "MCPServer");
    await stopAllAccounts(accountManager.all());
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  // Lifecycle tie to the MCP client: this is a stdio server whose only consumer
  // is the parent process (e.g. Claude Desktop) on the other end of the pipe.
  // When that parent exits it closes our stdin; without this the background-sync
  // timer and IMAP connection keep the event loop alive and the process is
  // reparented to launchd/init and lingers forever (burning CPU). Exit as soon
  // as the pipe closes so no orphan survives its consumer.
  transport.onclose = () => {
    void shutdown("transport-close");
  };
  process.stdin.on("end", () => {
    void shutdown("stdin-end");
  });
  process.stdin.on("close", () => {
    void shutdown("stdin-close");
  });
  // A broken pipe (parent killed abruptly) surfaces as an stdin error rather
  // than a clean end; treat it the same way instead of crashing.
  process.stdin.on("error", (error) => {
    logger.warn("stdin error, shutting down", "MCPServer", error);
    void shutdown("stdin-error");
  });
}

// A socket that Bridge (or the OS) drops while nobody is using it surfaces as an error event or a rejection with
// no caller to catch it. That is a lost connection, which the next call re-opens, not a reason to end the
// session: Claude Desktop would show the server as disconnected after a quiet period.
export function isRecoverableConnectionError(error: unknown): boolean {
  if (isLikelyConnectionError(error) || isLikelyTlsMismatchError(error)) return true;
  const code = String((error as { code?: unknown } | undefined)?.code ?? "");
  const text = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return ["EPIPE", "ECONNABORTED", "ENETRESET", "ENETUNREACH", "ERR_STREAM_DESTROYED"].includes(code) ||
    ["socket hang up", "socket closed", "write after end", "epipe"].some((needle) => text.includes(needle));
}

const processStartedAt = Date.now();

function fatal(kind: string, error: unknown): void {
  if (isRecoverableConnectionError(error)) {
    logger.warn(`${kind} from a lost connection; the server keeps running`, "MCPServer", error);
    return;
  }
  logger.error(`${kind}; exiting after ${Math.round((Date.now() - processStartedAt) / 1000)} s`, "MCPServer", error);
  process.exit(1);
}

process.on("uncaughtException", (error) => fatal("Uncaught exception", error));

process.on("unhandledRejection", (reason) => fatal("Unhandled rejection", reason));

const isDirectExecution = isMainModule(import.meta.url);

if (isDirectExecution) {
  main().catch((error) => {
    logger.error("Fatal server error", "MCPServer", error);
    process.exit(1);
  });
}

export { CORE_TOOL_NAMES };
