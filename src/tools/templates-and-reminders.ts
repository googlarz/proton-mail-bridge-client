import { maybeRefreshLocalIndex } from "./index-refresh.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { createTextResult } from "./results.js";
import { normalizeBoolean, optionalBoolean, optionalInteger, optionalNumber, normalizeLimit, withAccountPrefix } from "../utils/helpers.js";
import { requireString, optionalString } from "./args.js";
import { withAudit } from "./audit.js";
import { ensureMailboxWriteAllowed, ensureDestructiveConfirmed, ensureSendAllowed, ensureEmailActionAllowed } from "../utils/runtime-policy.js";
import type { ToolContext } from "./context.js";
import type { ToolResult } from "./results.js";

// Templates, the autoresponder, reply reminders and snoozing: small local stores that belong to one account.

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
      if (enabled === true) {
        // It sends mail nobody looks at: it needs everything a send needs, and a confirmation like one.
        ensureSendAllowed(config.runtime);
        if (config.runtime.restrictOutboundToSelf) {
          throw new McpError(ErrorCode.InvalidParams, "Outbound mail is confined to your own addresses (PROTONMAIL_RESTRICT_OUTBOUND_TO_SELF), and an automatic reply goes to whoever wrote.");
        }
        ensureDestructiveConfirmed(config.runtime, normalizeBoolean(args.confirmed, false), `Switch on the automatic reply of ${target.account.address}: it will send mail without asking each time`);
      }
      const rule = await withAudit(target.auditService, name, args, async () =>
        target.autoresponderService.set({
          enabled,
          subject: optionalString(args, "subject"),
          body: optionalString(args, "body"),
          startsAt: optionalString(args, "startsAt"),
          endsAt: optionalString(args, "endsAt"),
          replyEveryDays: optionalInteger(args.replyEveryDays, 1, 90),
          outgoingNote: optionalString(args, "outgoingNote"),
        }),
      );
      const sync = target.backgroundSyncService.getStatus();
      const warnings: string[] = [];
      if (rule.enabled && !sync.enabled) warnings.push("Background sync is off (PROTONMAIL_AUTO_SYNC), so no reply is sent until it runs.");
      if (rule.enabled && rule.body === "") warnings.push("There is no reply text; only the outgoing note is active.");
      return createTextResult({ account: target.account.address, rule, ...(warnings.length ? { warnings } : {}) });
    }

    case "get_autoresponder": {
      const target = resolveAccountArg(args) ?? primaryBundle;
      const state = await target.autoresponderService.get();
      const sync = target.backgroundSyncService.getStatus();
      let canSend = true;
      try {
        ensureSendAllowed(config.runtime);
      } catch {
        canSend = false;
      }
      return createTextResult({
        account: target.account.address,
        ...state,
        serverCanSend: canSend && !config.runtime.restrictOutboundToSelf,
        backgroundSync: { enabled: sync.enabled, thisInstanceRunsIt: sync.leader !== false },
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
