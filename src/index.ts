#!/usr/bin/env node

import { chmod, mkdir } from "node:fs/promises";
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
import { describeImapError, isLikelyAuthenticationError, isLikelyConnectionError, isLikelyTlsMismatchError } from "./services/simple-imap-service.js";
import { applySignature } from "./services/smtp-service.js";
import type {
  ProtonMailConfig,
  SendEmailInput,
} from "./types/index.js";
import {
  ensureValidEmails,
  isTextLikeMimeType,
  isValidEmail,
  InvalidArgumentError,
  normalizeBoolean,
  normalizeLimit,
  parseEmails,
  renderMarkdown,
  withAccountPrefix,
} from "./utils/helpers.js";
import { AccountManager, type AccountBundle } from "./services/account-manager.js";
import { PACKAGE_VERSION } from "./package-info.js";
import { createToolContext } from "./tools/context.js";
import { handleAttachmentTool } from "./tools/attachments.js";
import { handleFolderTool } from "./tools/folders.js";
import { handleDraftTool } from "./tools/drafts.js";
import { handleReadingTool } from "./tools/reading.js";
import { handleDiagnosticTool } from "./tools/diagnostics.js";
import { handleMessageActionTool } from "./tools/message-actions.js";
import { handleTemplateAndReminderTool } from "./tools/templates-and-reminders.js";
import { logger } from "./utils/logger.js";
import {
  ensureDestructiveConfirmed,
  ensureMailboxWriteAllowed,
  ensureOutboundRecipientsAllowed,
  ensureSendAllowed,
} from "./utils/runtime-policy.js";
import { InviteError, buildInviteReply, findMyAttendee, parseInvite, type ParsedInvite } from "./utils/ical-reply.js";
import { ToolResult, createTextResult } from "./tools/results.js";
import { withIgnoredArgumentsNote, asObject, requireString, optionalString, optionalAttachmentList } from "./tools/args.js";
import { withAudit } from "./tools/audit.js";
import { extractUnsubscribeInfo, uniqueAddresses, prefixedSubject, replyReferences, buildReplyText, buildForwardText, buildReplyHtml, buildForwardHtml, getReplyRecipients } from "./tools/compose.js";
import { buildEmailResourceUri, buildThreadResourceUri, buildDraftResourceUri, emailSource, formatEmailResource, formatThreadResource, formatDraftResource, parseResourceUri } from "./tools/resources.js";
import { sortByDateDesc } from "./tools/merge.js";
import { redactQueueRecordAttachments } from "./tools/drafts-support.js";
import { MissingCredentialsError, buildConfigFromEnv } from "./config-env.js";
import { verifySentCopy } from "./tools/actions.js";
export { mailboxChangedSinceCheckpoint } from "./tools/index-refresh.js";
export { MissingCredentialsError, buildConfigFromEnv } from "./config-env.js";
export { redactDraftAttachmentsForListing, truncateDraftBodyForResponse, redactQueueRecordAttachments, writeAttachmentToDownloadDir } from "./tools/drafts-support.js";
export { tagAccountIds, trimThreadsToBudget, paginateMergedAccountResults } from "./tools/merge.js";
export { getBulkMaxBatchSize, ensureBulkBatchSize, getBulkNotFoundEmailIds, withBulkNotFound, groupEmailIdsByAccount, prefixBulkResult, prefixNotFound, mergeBulkResults } from "./tools/bulk.js";
export { headerString, parseAuthenticationResults, buildSecurityInfo, parseUnsubscribeMailto, extractUnsubscribeInfo, formatQuoteDate, stripUnshippableImages, buildReplyText, buildForwardText, buildReplyHtml, buildForwardHtml, getReplyRecipients } from "./tools/compose.js";
export { withSources } from "./tools/results.js";
export { ignoredArguments, optionalClearableString } from "./tools/args.js";
export { withAudit } from "./tools/audit.js";

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
    auditService,
    localIndexService,
    draftStore,
    backgroundSyncService,
    deliveryQueueService,
    snoozeService,
    selectedBundles,
    allAccountAddresses,
    resolveAccountForEmailId,
    prefixedIdFor,
    resolveAccountForDraftId,
    resolveAccountForQueueId,
    responseSlug,
    resolveUndoWindowSeconds,
    queueUndoSend,
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

        case "get_emails":
        case "get_email_by_id":
        case "get_emails_by_ids":
        case "search_emails":
        case "search_indexed_emails":
        case "get_threads":
        case "get_actionable_threads":
        case "get_inbox_digest":
        case "get_follow_up_candidates":
        case "find_document_threads":
        case "prepare_meeting_context":
        case "get_thread_brief":
        case "get_thread_by_id":
        case "top_senders":
        case "get_email_stats":
        case "get_email_analytics":
        case "get_contacts":
        case "get_volume_trends":
        case "export_email":
        case "import_email":
        case "get_unsubscribe_info":
          return await handleReadingTool(name, args, ctx);

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

        case "create_draft":
        case "create_reply_draft":
        case "create_forward_draft":
        case "list_drafts":
        case "list_remote_drafts":
        case "get_draft":
        case "update_draft":
        case "sync_draft_to_remote":
        case "delete_draft":
        case "create_thread_reply_draft":
        case "send_draft":
        case "schedule_draft":
          return await handleDraftTool(name, args, ctx);

        case "mark_email_read":
        case "star_email":
        case "move_email":
        case "archive_email":
        case "trash_email":
        case "restore_email":
        case "delete_email":
        case "batch_email_action":
        case "update_message_labels":
        case "update_message_flags":
        case "bulk_move":
        case "bulk_delete":
        case "bulk_update_flags":
        case "bulk_update_labels":
        case "move_thread":
        case "delete_thread":
        case "flag_thread":
        case "apply_thread_action":
          return await handleMessageActionTool(name, args, ctx);

        case "get_folders":
        case "sync_folders":
        case "create_folder":
        case "rename_folder":
        case "delete_folder":
        case "create_label":
        case "rename_label":
        case "delete_label":
        case "folder_stats":
        case "empty_folder":
        case "get_labels":
        case "count_messages":
          return await handleFolderTool(name, args, ctx);

        case "get_connection_status":
        case "get_runtime_status":
        case "list_accounts":
        case "run_background_sync":
        case "wait_for_mailbox_changes":
        case "get_index_status":
        case "run_doctor":
        case "clear_cache":
        case "clear_index":
        case "get_logs":
        case "get_audit_logs":
        case "sync_emails":
          return await handleDiagnosticTool(name, args, ctx);

        case "list_attachments":
        case "get_attachment_content":
        case "get_attachment_text":
        case "save_attachment":
        case "save_attachments":
          return await handleAttachmentTool(name, args, ctx);

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
