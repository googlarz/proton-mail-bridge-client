import { maybeRefreshLocalIndex } from "./index-refresh.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { createTextResult } from "./results.js";
import { normalizeBoolean, optionalBoolean, optionalInteger, optionalNumber, normalizeLimit, withAccountPrefix } from "../utils/helpers.js";
import { requireString, optionalString } from "./args.js";
import { withAudit } from "./audit.js";
import { ensureMailboxWriteAllowed, ensureDestructiveConfirmed, ensureEmailActionAllowed } from "../utils/runtime-policy.js";
import type { ToolContext } from "./context.js";
import type { ToolResult } from "./results.js";
import type { AutoresponderPatch } from "../services/autoresponder-service.js";
import { assertApprovedContentUnchanged, autoresponderApprovalDigest } from "../utils/approval.js";

// Templates, the autoresponder, reply reminders and snoozing: small local stores that belong to one account.

/** The change set_autoresponder makes to the stored reply; the question to the person is worked out from the same one. */
export function autoresponderPatch(args: Record<string, unknown>): AutoresponderPatch {
  return {
    enabled: optionalBoolean(args.enabled),
    subject: optionalString(args, "subject"),
    body: optionalString(args, "body"),
    subjects: args.subjects,
    bodies: args.bodies,
    returnDate: optionalString(args, "returnDate"),
    backupContact: optionalString(args, "backupContact"),
    startsAt: optionalString(args, "startsAt"),
    endsAt: optionalString(args, "endsAt"),
    replyEveryDays: optionalInteger(args.replyEveryDays, 1, 90),
    dailyLimit: optionalInteger(args.dailyLimit, 1, 200),
    mode: optionalString(args, "mode") as "send" | "draft" | undefined,
    timezone: optionalString(args, "timezone"),
    outsideHours: args.outsideHours === null ? null : (args.outsideHours as { days: number[]; from: string; to: string } | undefined),
    skipIfAnswered: optionalBoolean(args.skipIfAnswered),
    rules: args.rules,
    outgoingNote: optionalString(args, "outgoingNote"),
  };
}

export async function handleTemplateAndReminderTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { config, accountManager, primaryBundle, auditService, snoozeService, templateService, resolveAccountArg, selectedBundles, presentReminder, evaluateReminders, resolveAccountForEmailId, resolveAccountForSnoozeId, responseSlug } = ctx;
  switch (name) {
    case "create_template": {
      // Local template write — same gap as create_draft, see its comment.
      ensureMailboxWriteAllowed(config.runtime);
      const result = await withAudit(auditService, name, args, async () =>
        templateService.create({
          name: requireString(args, "name"),
          subject: requireString(args, "subject"),
          body: requireString(args, "body"),
          isHtml: normalizeBoolean(args.isHtml, false),
        }),
      );
      return createTextResult(result);
    }

    case "list_templates": {
      const result = await withAudit(auditService, name, args, async () => templateService.list());
      return createTextResult(result);
    }

    case "get_template": {
      const result = await withAudit(auditService, name, args, async () =>
        templateService.get(requireString(args, "id")),
      );
      return createTextResult(result);
    }

    case "delete_template": {
      // Local template write — same gap as create_draft, see its comment.
      ensureMailboxWriteAllowed(config.runtime);
      const templateId = requireString(args, "id");
      ensureDestructiveConfirmed(config.runtime, normalizeBoolean(args?.confirmed, false), "Permanently delete template: " + templateId);
      const result = await withAudit(auditService, name, args, async () =>
        templateService.delete(templateId),
      );
      return createTextResult(result);
    }

    case "render_template": {
      if (args.variables !== undefined && args.variables !== null && (typeof args.variables !== "object" || Array.isArray(args.variables))) {
        throw new McpError(ErrorCode.InvalidParams, "variables must be an object of name: value pairs.");
      }
      const variables = (args.variables ?? {}) as Record<string, string>;
      const result = await withAudit(auditService, name, args, async () =>
        templateService.render(requireString(args, "id"), variables),
      );
      return createTextResult(result);
    }

    case "set_autoresponder": {
      const target = resolveAccountArg(args) ?? primaryBundle;
      const enabled = optionalBoolean(args.enabled);
      const existing = (await target.autoresponderService.get()).rule;
      const deps = target.autoresponderDeps();
      if (enabled === true) {
        if (!deps.canSend && !deps.canDraft) {
          throw new McpError(ErrorCode.InvalidParams, "This server can neither send mail nor write drafts under the current runtime policy, so an automatic reply could do nothing.");
        }
        // Whether it could send: the server may, and the default reply or a rule is set to send.
        const mode = optionalString(args, "mode") ?? existing?.mode;
        const rules = Array.isArray(args.rules) ? (args.rules as Array<{ action?: string }>) : existing?.rules;
        const couldSend = deps.canSend && (mode !== "draft" || (rules ?? []).some((rule) => rule.action === "reply"));
        if (couldSend) {
          ensureDestructiveConfirmed(config.runtime, normalizeBoolean(args.confirmed, false), `Switch on the automatic reply of ${target.account.address}: it will send mail without asking each time`);
        }
      }
      // The person was asked about the reply this makes of the stored one: refused if it makes another one now.
      const rule = await withAudit(target.auditService, name, args, async () =>
        target.autoresponderService.set(autoresponderPatch(args), Date.now(), (next) => assertApprovedContentUnchanged(args, "autoresponder", autoresponderApprovalDigest(next), name)),
      );
      const sync = target.backgroundSyncService.getStatus();
      const warnings: string[] = [];
      if (rule.enabled && !sync.enabled) warnings.push("Background sync is off (PROTONMAIL_AUTO_SYNC), so nothing is answered until it runs.");
      if (rule.enabled && !rule.body && !rule.bodies && !rule.rules?.some((candidate) => candidate.body)) warnings.push("There is no reply text; only the outgoing note is active.");
      if (rule.enabled && !rule.body && rule.bodies) warnings.push(`There is no default body, so only mail in ${Object.keys(rule.bodies).join(", ")} (or matching a rule with its own text) gets a reply.`);
      if (rule.enabled && !deps.canSend) warnings.push("This server may not send mail, so matching mail gets a draft for you to review instead of a reply.");
      return createTextResult({ account: target.account.address, rule, ...(warnings.length ? { warnings } : {}) });
    }

    case "get_autoresponder": {
      const target = resolveAccountArg(args) ?? primaryBundle;
      const state = await target.autoresponderService.get();
      const sync = target.backgroundSyncService.getStatus();
      const deps = target.autoresponderDeps();
      return createTextResult({
        account: target.account.address,
        ...state,
        serverCan: { send: deps.canSend === true, draft: deps.canDraft === true },
        backgroundSync: { enabled: sync.enabled, thisInstanceRunsIt: sync.leader !== false },
      });
    }

    case "preview_autoresponder": {
      const target = resolveAccountArg(args) ?? primaryBundle;
      const days = optionalInteger(args.days, 1, 14) ?? 3;
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const found = await target.localIndexService.search({ folder: "INBOX", dateFrom: since, limit: 200 });
      const decisions = await target.autoresponderService.preview(found.emails, target.ownAddresses, target.autoresponderDeps());
      const counts = { reply: 0, draft: 0, skip: 0 } as Record<string, number>;
      const skippedBy: Record<string, number> = {};
      for (const decision of decisions) {
        counts[decision.outcome] += 1;
        if (decision.outcome === "skip") skippedBy[decision.reason ?? "other"] = (skippedBy[decision.reason ?? "other"] ?? 0) + 1;
      }
      return createTextResult({
        account: target.account.address,
        lookedAt: { days, messages: found.emails.length, note: found.emails.length >= 200 ? "Only the newest 200 were judged." : undefined },
        configured: (await target.autoresponderService.get()).rule !== undefined,
        counts,
        skippedBy,
        messages: decisions.slice(0, 50).map((decision) => ({
          from: decision.from,
          subject: decision.subject,
          would: decision.outcome,
          reason: decision.reason,
          rule: decision.rule,
          ...(decision.reply
            ? { language: decision.language ?? "unknown", textFrom: decision.textFrom, styled: decision.styled === true, replySubject: decision.reply.subject, replyBody: decision.reply.body.slice(0, 300) }
            : {}),
        })),
      });
    }

    case "set_reply_reminder": {
      ensureMailboxWriteAllowed(config.runtime);
      const { bundle: reminderBundle, rest: reminderEmailId } = resolveAccountForEmailId(requireString(args, "emailId"));
      const afterDays = optionalNumber(args.afterDays, 1, 365);
      const remindAtArg = optionalString(args, "remindAt");
      if (afterDays !== undefined && remindAtArg !== undefined) {
        throw new McpError(ErrorCode.InvalidParams, "Give afterDays or remindAt, not both.");
      }
      const now = new Date();
      const remindAt = remindAtArg !== undefined ? new Date(remindAtArg) : new Date(now.getTime() + (afterDays ?? 3) * 24 * 60 * 60 * 1000);
      if (Number.isNaN(remindAt.getTime())) {
        throw new McpError(ErrorCode.InvalidParams, "remindAt must be a date and time such as 2026-10-20T09:00:00Z.");
      }
      const reminderDetail = await reminderBundle.imapService.getEmailById(reminderEmailId);
      if (!reminderDetail.messageId) {
        throw new McpError(ErrorCode.InvalidParams, "This message has no Message-ID header, so replies to it cannot be recognised.");
      }
      const record = await withAudit(reminderBundle.auditService, name, args, () =>
        reminderBundle.replyReminderService.set({
          emailId: reminderEmailId,
          messageId: reminderDetail.messageId as string,
          subject: reminderDetail.subject,
          to: reminderDetail.to.map((address) => address.address ?? "").filter(Boolean),
          remindAt,
          note: optionalString(args, "note"),
          now,
        }),
      );
      return createTextResult({ ...presentReminder(reminderBundle, record), state: "waiting" });
    }

    case "list_reply_reminders": {
      const status = optionalString(args, "status") ?? "open";
      if (!["open", "due", "answered", "all"].includes(status)) {
        throw new McpError(ErrorCode.InvalidParams, "status must be open, due, answered or all.");
      }
      const limit = normalizeLimit(args.limit, 50, 1, 500);
      const bundles = selectedBundles(args);
      await Promise.all(bundles.map((bundle) => maybeRefreshLocalIndex(bundle.imapService, bundle.localIndexService, { force: false, folder: "INBOX", limitPerFolder: 100 })));
      const all = await evaluateReminders(bundles);
      const wanted = all.filter((reminder) => (status === "all" ? true : status === "open" ? reminder.state !== "answered" : reminder.state === status));
      const rank = { due: 0, waiting: 1, answered: 2 } as const;
      wanted.sort((left, right) => rank[left.state] - rank[right.state] || left.remindAt.localeCompare(right.remindAt));
      return createTextResult({
        total: wanted.length,
        due: all.filter((reminder) => reminder.state === "due").length,
        reminders: wanted.slice(0, limit),
      });
    }

    case "cancel_reply_reminder": {
      ensureMailboxWriteAllowed(config.runtime);
      const { bundle: cancelBundle, rest: reminderId } = resolveAccountForEmailId(requireString(args, "id"));
      const result = await withAudit(cancelBundle.auditService, name, args, () => cancelBundle.replyReminderService.cancel(reminderId));
      return createTextResult({ id: requireString(args, "id"), canceled: result.canceled });
    }

    case "snooze_email": {
      ensureEmailActionAllowed(config.runtime, "archive");
      const wakeAt = requireString(args, "wakeAt");
      // A date-time with no zone ("2026-03-05T09:30:00") is read by JavaScript in the server's local time,
      // which is not what a caller reading "ISO 8601" expects and changes with the machine. Read it as UTC.
      const wakeAtTime = new Date(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(wakeAt.trim()) ? `${wakeAt.trim()}Z` : wakeAt).getTime();
      if (Number.isNaN(wakeAtTime)) {
        throw new McpError(ErrorCode.InvalidParams, `wakeAt is not a valid ISO 8601 timestamp: ${wakeAt}`);
      }
      if (wakeAtTime <= Date.now()) {
        throw new McpError(ErrorCode.InvalidParams, "wakeAt must be in the future.");
      }
      if (wakeAtTime > Date.now() + 10 * 365 * 24 * 60 * 60 * 1000) {
        throw new McpError(ErrorCode.InvalidParams, "wakeAt is more than ten years away.");
      }
      // emailId carries the same "<slug>::" prefix as everywhere else — resolve it
      // to that account's own snoozeService instead of always the primary's, and
      // prefix the returned ids (the snooze's own id, and the email id) the same
      // way so cancel_snooze/list_snoozed can find them again by account.
      const { bundle: snoozeBundle, rest: snoozeEmailIdRest } = resolveAccountForSnoozeId(
        requireString(args, "emailId"),
      );
      const snoozed = await withAudit(auditService, name, args, async () =>
        snoozeBundle.snoozeService.snooze(snoozeEmailIdRest, new Date(wakeAtTime).toISOString()),
      );
      return createTextResult({
        id: withAccountPrefix(responseSlug(snoozeBundle), snoozed.id),
        emailId: withAccountPrefix(responseSlug(snoozeBundle), snoozed.currentEmailId),
        wakeAt: snoozed.wakeAt,
        note: "This server must stay running for the wake to fire at wakeAt — if restarted first, it wakes on next startup instead. Cancelable via cancel_snooze.",
      });
    }

    case "cancel_snooze": {
      // cancel moves the mailbox back to its original folder, same as
      // snooze_email's own move — gate it the same way.
      ensureEmailActionAllowed(config.runtime, "archive");
      const { bundle: cancelSnoozeBundle, rest: cancelSnoozeIdRest } = resolveAccountForSnoozeId(
        requireString(args, "id"),
      );
      const result = await withAudit(auditService, name, args, async () =>
        cancelSnoozeBundle.snoozeService.cancel(cancelSnoozeIdRest),
      );
      return createTextResult({
        ...result,
        id: withAccountPrefix(responseSlug(cancelSnoozeBundle), result.id),
        currentEmailId: withAccountPrefix(responseSlug(cancelSnoozeBundle), result.currentEmailId),
      });
    }

    case "list_snoozed": {
      const statusFilter = optionalString(args, "status");
      // Same fan-out pattern as list_scheduled_sends — each account has its own
      // independent snoozeService/JSON file. Single-account guard keeps
      // byte-identical output for the common case.
      if (accountManager.all().length === 1) {
        resolveAccountArg(args);
        const all = await withAudit(auditService, name, args, async () => snoozeService.list());
        const filtered = statusFilter ? all.filter((item) => item.status === statusFilter) : all;
        return createTextResult(filtered);
      }
      const perAccount = await withAudit(auditService, name, args, async () =>
        Promise.all(
          selectedBundles(args).map(async (bundle) => ({
            bundle,
            items: await bundle.snoozeService.list(),
          })),
        ),
      );
      const tagged = perAccount.flatMap(({ bundle, items }) =>
        items.map((item) => ({
          ...item,
          id: withAccountPrefix(responseSlug(bundle), item.id),
          currentEmailId: withAccountPrefix(responseSlug(bundle), item.currentEmailId),
        })),
      );
      const filtered = statusFilter ? tagged.filter((item) => item.status === statusFilter) : tagged;
      return createTextResult(filtered);
    }

    default:
      throw new Error(`handleTemplateAndReminderTool: unexpected tool ${name}`);
  }
}
