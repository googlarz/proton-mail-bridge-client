import { AnalyticsService } from "../services/analytics-service.js";
// What a tool handler needs from the server beyond its arguments: the configuration, the account manager, and the
// helpers that route an id, a folder path or an `account` argument to the right account and present results the way
// a caller sees them (ids prefixed for every account but the primary). Built once per server; handlers that live
// outside createServer() receive it as their third argument.

import { createTextResult } from "./results.js";
import { withAudit } from "./audit.js";
import { type SendEmailInput, type DraftRecord } from "../types/index.js";
import { type ReplyReminderRecord } from "../services/reply-reminder-service.js";
import { splitAccountPrefix, withAccountPrefix } from "../utils/helpers.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { optionalString } from "./args.js";
import { MailTaint } from "../utils/mail-security.js";
import { Delegation } from "./delegation.js";
import type { AccountBundle, AccountManager } from "../services/account-manager.js";
import type { ProtonMailConfig } from "../types/index.js";

export function createToolContext(config: ProtonMailConfig, accountManager: AccountManager) {
  const primaryBundle = accountManager.primary();
  const smtpService = primaryBundle.smtpService;
  const imapService = primaryBundle.imapService;
  const analyticsService = new AnalyticsService();
  const auditService = primaryBundle.auditService;
  const localIndexService = primaryBundle.localIndexService;
  const draftStore = primaryBundle.draftStore;
  const backgroundSyncService = primaryBundle.backgroundSyncService;
  const deliveryQueueService = primaryBundle.deliveryQueueService;
  const snoozeService = primaryBundle.snoozeService;
  const templateService = primaryBundle.templateService;

  // Resolves an emailId's optional account-slug prefix (see splitAccountPrefix) to its
  // owning AccountBundle, defaulting to the primary account for a plain, unprefixed id —
  // which covers every id that existed before multi-account support, unchanged.
  // Resolves an optional `account` tool argument (address or slug, case-insensitive) to
  // its bundle; undefined when omitted. Unknown values are a clear InvalidParams error.
  function resolveAccountArg(args: Record<string, unknown>): AccountBundle | undefined {
    const raw = optionalString(args, "account");
    if (raw === undefined) {
      return undefined;
    }
    const wanted = raw.trim().toLowerCase();
    const found = accountManager
      .all()
      .find((bundle) => bundle.account.slug.toLowerCase() === wanted || bundle.account.address.toLowerCase() === wanted);
    if (!found) {
      const known = accountManager.all().map((bundle) => `${bundle.account.address} (${bundle.account.slug})`).join(", ");
      throw new McpError(ErrorCode.InvalidParams, `Unknown account "${raw}". Configured accounts: ${known}.`);
    }
    return found;
  }

  // The account a folder tool acts on, and its paths without the account prefix. A path may carry the "<slug>::"
  // prefix get_folders puts on non-primary folders, or the `account` argument names it; with neither it is the
  // primary account. Two different accounts in one call (a prefix against `account`, or two prefixes) are refused.
  function resolveFolderTarget(args: Record<string, unknown>, ...paths: string[]): { bundle: AccountBundle; paths: string[] } {
    let bundle = resolveAccountArg(args);
    const rests = paths.map((path) => {
      const { accountSlug, rest } = splitAccountPrefix(path, accountManager.additionalSlugs());
      if (accountSlug) {
        const named = accountManager.bySlugOrPrimary(accountSlug);
        if (bundle && bundle !== named) {
          throw new McpError(ErrorCode.InvalidParams, "The folder paths and the account argument name different accounts.");
        }
        bundle = named;
      }
      return rest;
    });
    return { bundle: bundle ?? primaryBundle, paths: rests };
  }

  // The accounts a triage or statistics tool covers: the one named by `account`, else all of them.
  function selectedBundles(args: Record<string, unknown>): AccountBundle[] {
    const one = resolveAccountArg(args);
    return one ? [one] : accountManager.all();
  }

  // A reminder as a caller sees it: ids carry the account's prefix, like every other id.
  function presentReminder(bundle: AccountBundle, record: ReplyReminderRecord) {
    const slug = responseSlug(bundle);
    return { ...record, id: withAccountPrefix(slug, record.id), emailId: withAccountPrefix(slug, record.emailId) };
  }

  // Each open reminder with its state, from the local index: answered (somebody else wrote in the thread since it
  // was set), due (the date has passed) or waiting.
  async function evaluateReminders(bundles: AccountBundle[]) {
    const own = allAccountAddresses();
    const now = Date.now();
    const perAccount = await Promise.all(
      bundles.map(async (bundle) => {
        const records = await bundle.replyReminderService.list();
        return Promise.all(
          records.map(async (record) => {
            const replies = await bundle.localIndexService.getRepliesSince(record.messageId, record.createdAt, own, record.to);
            const first = [...replies].sort((left, right) => (left.internalDate || left.date || "").localeCompare(right.internalDate || right.date || ""))[0];
            const state: "waiting" | "due" | "answered" = first ? "answered" : new Date(record.remindAt).getTime() <= now ? "due" : "waiting";
            return {
              ...presentReminder(bundle, record),
              state,
              ...(state === "due" ? { daysOverdue: Math.floor((now - new Date(record.remindAt).getTime()) / 86_400_000) } : {}),
              ...(first ? { answeredAt: first.internalDate || first.date, answeredBy: first.from[0]?.address } : {}),
            };
          }),
        );
      }),
    );
    return perAccount.flat();
  }

  // Every configured account address — reply helpers treat all of them as "self".
  function allAccountAddresses(): string[] {
    return accountManager.all().map((bundle) => bundle.account.address);
  }

  function resolveAccountForEmailId(emailId: string): { bundle: AccountBundle; rest: string } {
    const { accountSlug, rest } = splitAccountPrefix(emailId, accountManager.additionalSlugs());
    return { bundle: accountManager.bySlugOrPrimary(accountSlug), rest };
  }

  // Re-applies a bundle's account-slug prefix to an id that came back bare from that
  // bundle's own imapService (which only ever understands unprefixed ids) — so a
  // caller acting on a non-primary account gets back an id that resolveAccountForEmailId
  // will route to the same account next time. The primary account's ids stay unprefixed,
  // exactly as before multi-account support existed.
  function prefixedIdFor(bundle: AccountBundle, rawId: string): string {
    return withAccountPrefix(
      bundle.account.slug === accountManager.primary().account.slug ? undefined : bundle.account.slug,
      rawId,
    );
  }

  // A result that names messages: every id it carries gets the account's prefix, so the caller can pass it straight
  // back (an id of a non-primary account is only valid with its "<slug>::").
  function withPrefixedIds<T extends object>(bundle: AccountBundle, result: T): T {
    const copy = { ...result } as Record<string, unknown>;
    for (const key of ["emailId", "sourceEmailId", "targetEmailId", "existingEmailId"]) {
      if (typeof copy[key] === "string" && copy[key] !== "") copy[key] = prefixedIdFor(bundle, copy[key] as string);
    }
    return copy as T;
  }

  // draftId and emailId share the exact same "<slug>::" prefixing scheme (plain
  // string-prefix stripping over the non-primary slugs), so draftId resolution reuses
  // resolveAccountForEmailId itself rather than a second, parallel mechanism.
  const resolveAccountForDraftId = resolveAccountForEmailId;
  // Same scheme again for delivery-queue ids (cancel_send/list_scheduled_sends) and
  // snooze ids (cancel_snooze/list_snoozed) — both are per-account services (their own
  // JSON file under that account's dataDir), so a queued/snoozed item's id needs the
  // same slug-prefix round-trip as an emailId/draftId to be found again by account.
  const resolveAccountForQueueId = resolveAccountForEmailId;
  const resolveAccountForSnoozeId = resolveAccountForEmailId;

  // The slug to prefix a response id with for this bundle — undefined for the
  // primary account, so a primary-account id round-trips with NO prefix at all,
  // exactly as it did before multi-account support existed.
  function responseSlug(bundle: AccountBundle): string | undefined {
    return bundle.account.slug === accountManager.primary().account.slug ? undefined : bundle.account.slug;
  }

  // Undo-send window for one send: the server default (PROTONMAIL_SEND_DELAY_SECONDS),
  // overridable per call with undoWindowSeconds (0 = send immediately). Shared by
  // send_email, reply_to_email, reply_all_email and forward_email.
  function resolveUndoWindowSeconds(args: Record<string, unknown>): number {
    if (args.undoWindowSeconds === undefined) {
      return config.runtime.sendDelaySeconds ?? 0;
    }
    const requested = Number(args.undoWindowSeconds);
    if (!Number.isInteger(requested) || requested < 0 || requested > 300) {
      throw new McpError(ErrorCode.InvalidParams, "undoWindowSeconds must be an integer between 0 and 300.");
    }
    return requested;
  }

  // Queues a send on the SENDING account's own delivery queue (so it fires through that
  // account's SMTP) and returns the tool result. The id carries that account's slug so
  // cancel_send/list_scheduled_sends can find it again.
  async function queueUndoSend(
    bundle: AccountBundle,
    payload: SendEmailInput,
    undoWindowSeconds: number,
    toolName: string,
    toolArgs: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) {
    const sendAt = new Date(Date.now() + undoWindowSeconds * 1000).toISOString();
    const queued = await withAudit(auditService, toolName, toolArgs, async () =>
      bundle.deliveryQueueService.enqueue(payload, sendAt, "undo_send"),
    );
    return createTextResult({
      queued: true,
      id: withAccountPrefix(responseSlug(bundle), queued.id),
      sendAt: queued.sendAt,
      ...extra,
      note: `Not sent yet — will send in ~${undoWindowSeconds}s unless canceled with cancel_send. This server must stay running for the send to fire; if it's restarted before sendAt, the send fires on next startup instead.`,
    });
  }

  // Alias for responseSlug — tagAccountIds (added alongside the digest/follow-up
  // multi-account fan-out) was written against this name; kept as a thin alias rather
  // than rewriting every call site to the other name.
  const slugForBundle = responseSlug;

  // A draft created/updated through a non-primary account's own draftStore needs its
  // id wrapped with that account's slug prefix in the RESPONSE (so get_draft/
  // update_draft/send_draft/delete_draft/list_drafts can find it again via
  // resolveAccountForDraftId) — but every internal draftStore/imapService call for
  // that account keeps using the bundle's own unprefixed id, exactly as stored on
  // disk under that account's own dataDir. remoteDraft.emailId is a real emailId (not
  // a draftId) for a remote copy living in that same account's mailbox, so it gets
  // the identical prefix treatment for the identical reason.
  function presentDraft<T extends DraftRecord>(bundle: AccountBundle, draft: T): T {
    const slug = responseSlug(bundle);
    if (!slug) {
      return draft;
    }
    return {
      ...draft,
      id: withAccountPrefix(slug, draft.id),
      remoteDraft: draft.remoteDraft?.emailId
        ? { ...draft.remoteDraft, emailId: withAccountPrefix(slug, draft.remoteDraft.emailId) }
        : draft.remoteDraft,
    };
  }

  const taint = new MailTaint();
  const delegation = new Delegation({ config, accountManager, taint, resolveAccountForEmailId, allAccountAddresses });

  return {
    taint,
    delegation,
    config,
    accountManager,
    primaryBundle,
    smtpService,
    imapService,
    analyticsService,
    auditService,
    localIndexService,
    draftStore,
    backgroundSyncService,
    deliveryQueueService,
    snoozeService,
    templateService,
    resolveAccountArg,
    resolveFolderTarget,
    selectedBundles,
    presentReminder,
    evaluateReminders,
    allAccountAddresses,
    resolveAccountForEmailId,
    prefixedIdFor,
    withPrefixedIds,
    resolveAccountForDraftId,
    resolveAccountForQueueId,
    resolveAccountForSnoozeId,
    responseSlug,
    resolveUndoWindowSeconds,
    queueUndoSend,
    slugForBundle,
    presentDraft,
  };
}

export type ToolContext = ReturnType<typeof createToolContext>;
