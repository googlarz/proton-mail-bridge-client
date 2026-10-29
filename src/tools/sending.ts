import { type ParsedInvite, parseInvite, InviteError, findMyAttendee, buildInviteReply } from "../utils/ical-reply.js";
import { emailSource } from "./resources.js";
import { applySignature } from "../services/smtp-service.js";
import { extractUnsubscribeInfo, getReplyRecipients, uniqueAddresses, buildReplyHtml, buildReplyText, prefixedSubject, replyReferences, buildForwardHtml, buildForwardText } from "./compose.js";
import { redactQueueRecordAttachments } from "./drafts-support.js";
import { sortByDateDesc } from "./merge.js";
import { verifySentCopy } from "./actions.js";
import { withAudit } from "./audit.js";
import { type SendEmailInput } from "../types/index.js";
import { createTextResult } from "./results.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { optionalAddressList, optionalAttachmentList, optionalString, requireAddressList, requireString } from "./args.js";
import { normalizeBoolean, parseEmails, renderMarkdown, ensureValidEmails, isValidEmail, withAccountPrefix, normalizeLimit } from "../utils/helpers.js";
import { ensureDestructiveConfirmed, ensureSendAllowed, ensureOutboundRecipientsAllowed, ensureMailboxWriteAllowed } from "../utils/runtime-policy.js";
import type { ToolContext } from "./context.js";
import type { ToolResult } from "./results.js";

// Sending mail: new messages, replies, forwards, answering an invitation, unsubscribing, the test mail, and cancelling or listing scheduled sends.

// Triage and statistics tools cover every configured account unless told which one.
// Calendar providers that route replies through their own gateway: the organizer in an iCloud invitation is an
// address at Apple's iMIP relay, while the message comes from noreply@email.apple.com. A reply to such an address
// goes to the provider itself, so the organizer/sender mismatch warning is not raised for it.
const CALENDAR_RELAY_DOMAINS = new Set(["imip.me.com"]);

export async function handleSendingTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { config, accountManager, primaryBundle, smtpService, imapService, auditService, selectedBundles, allAccountAddresses, resolveAccountForEmailId, prefixedIdFor, resolveAccountForQueueId, responseSlug, resolveUndoWindowSeconds, queueUndoSend } = ctx;
  switch (name) {
    case "send_email": {
      ensureDestructiveConfirmed(config.runtime, (normalizeBoolean(args.confirmed, false) || normalizeBoolean(args.dryRun, false)), `Send email to ${String(args.to ?? "?")} — "${String(args.subject ?? "?")}"`);
      ensureSendAllowed(config.runtime);
      const to = parseEmails(requireAddressList(args, "to"));
      const cc = parseEmails(optionalAddressList(args, "cc"));
      const bcc = parseEmails(optionalAddressList(args, "bcc"));
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

      await ctx.delegation.claim(args, name, effectiveSendBundle, [...to, ...(cc ?? []), ...(bcc ?? [])]);
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
      const extraCc = parseEmails(optionalAddressList(args, "cc"));
      const extraBcc = parseEmails(optionalAddressList(args, "bcc"));
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
      await ctx.delegation.claim(args, name, sendBundleForReply, [...to, ...cc, ...extraBcc], readBundleReply);
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
      const extraCcRa = parseEmails(optionalAddressList(args, "cc"));
      const extraBccRa = parseEmails(optionalAddressList(args, "bcc"));
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
      await ctx.delegation.claim(args, name, sendBundleForRa, [...toRa, ...ccRa, ...extraBccRa], readBundleRa);
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
      const to = parseEmails(requireAddressList(args, "to"));
      const cc = parseEmails(optionalAddressList(args, "cc"));
      const bcc = parseEmails(optionalAddressList(args, "bcc"));
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
      await ctx.delegation.claim(args, name, sendBundleForFwd, [...to, ...cc, ...bcc], readBundleFwd);
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

    default:
      throw new Error(`handleSendingTool: unexpected tool ${name}`);
  }
}
