import type { ActionableThreadSummary, EmailSummary } from "../types/index.js";
import { BriefStore, briefLines } from "../services/brief-service.js";
import { assessMail } from "../utils/mail-security.js";
import { normalizeBoolean, normalizeLimit, withAccountPrefix } from "../utils/helpers.js";
import { optionalString } from "./args.js";
import { evaluateCommitments } from "./commitments.js";
import { maybeRefreshLocalIndex } from "./index-refresh.js";
import { tagAccountIds } from "./merge.js";
import { createTextResult } from "./results.js";
import type { ToolContext } from "./context.js";
import type { ToolResult } from "./results.js";

// get_brief: what changed since the last brief, from the local index: new mail (people against automatic), what waits
// for your reply, replies you wait for, and mail that looks written to steer an AI. Taking it with markSeen moves
// the "since" mark, so a daily run only reports the day.

export async function handleBriefTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (name !== "get_brief") throw new Error(`Unknown brief tool: ${name}`);
  const { primaryBundle, selectedBundles, slugForBundle, evaluateReminders } = ctx;
  const store = new BriefStore(primaryBundle.account.dataDir);
  const state = await store.read();
  const now = new Date();
  const sinceArg = optionalString(args, "since");
  if (sinceArg !== undefined && Number.isNaN(Date.parse(sinceArg))) throw new Error("since must be a date or a time, for example 2026-10-22T08:00:00Z.");
  const fallback = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const limit = normalizeLimit(args.limit, 5, 1, 50);

  const bundles = selectedBundles(args);
  const perAccount = await Promise.all(
    bundles.map(async (bundle) => {
      await maybeRefreshLocalIndex(bundle.imapService, bundle.localIndexService, { force: normalizeBoolean(args.syncBefore, false), folder: "INBOX", limitPerFolder: 100 });
      const slug = slugForBundle(bundle);
      const digest = await bundle.localIndexService.getInboxDigest({ limit });
      const bundleSince = sinceArg ?? store.sinceFor(state, bundle.account.slug) ?? fallback;
      const fresh = await bundle.localIndexService.search({ folder: "INBOX", dateFrom: bundleSince, limit: 200 });
      return {
        slug,
        key: bundle.account.slug,
        since: bundleSince,
        capped: fresh.emails.length >= 200,
        needsReply: tagAccountIds(slug, (digest.staleAwaitingYou ?? []) as ActionableThreadSummary[]).concat(tagAccountIds(slug, (digest.topThreads ?? []) as ActionableThreadSummary[]).filter((t) => t.pendingOn === "you")),
        emails: fresh.emails.map((email) => ({ ...email, id: withAccountPrefix(slug, email.id) })) as EmailSummary[],
      };
    }),
  );

  const needsReply = [...new Map(perAccount.flatMap((entry) => entry.needsReply).map((thread) => [thread.id, thread])).values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const emails = perAccount.flatMap((entry) => entry.emails);
  const people = emails.filter((email) => email.isAutomated !== true);
  const senderCounts = new Map<string, number>();
  for (const email of people) {
    const sender = email.from[0]?.address ?? "";
    if (sender) senderCounts.set(sender, (senderCounts.get(sender) ?? 0) + 1);
  }
  const flagged = emails
    .map((email) => ({ email, risk: assessMail({ from: email.from, replyTo: email.replyTo, subject: email.subject, text: email.preview, automated: email.isAutomated }) }))
    .filter((entry) => entry.risk.level === "high")
    .map(({ email, risk }) => {
      // Previews in a brief are read by the model like any other: the session is tainted by them.
      ctx.taint.mark(email.id, risk);
      return { id: email.id, from: email.from[0]?.address ?? "", subject: email.subject, level: risk.level, reasons: risk.reasons };
    });
  const own = ctx.accountManager.all().map((entry) => entry.account.address);
  const commitments = (
    await Promise.all(bundles.map(async (bundle) => (await evaluateCommitments(bundle, own, "open", (id) => withAccountPrefix(slugForBundle(bundle), id))).filter((item) => item.state === "overdue" || item.state === "due-today")))
  ).flat();
  const reminders = (await evaluateReminders(bundles)).filter((reminder) => reminder.state === "due");

  const since = perAccount.map((entry) => entry.since).sort()[0] ?? fallback;
  const brief = {
    since,
    generatedAt: now.toISOString(),
    newMail: {
      total: emails.length,
      fromPeople: people.length,
      automated: emails.length - people.length,
      ...(perAccount.some((entry) => entry.capped) ? { capped: true } : {}),
      topSenders: [...senderCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([sender]) => sender),
    },
    needsReply: needsReply.map((thread) => ({ id: thread.latestEmailId, threadId: thread.id, subject: thread.subject, from: thread.latestFrom?.[0]?.address ?? "", ageHours: undefined as number | undefined })),
    waitingOnOthers: reminders.map((reminder) => ({ id: reminder.emailId, subject: reminder.subject, to: reminder.to?.[0], daysOverdue: reminder.daysOverdue })),
    flagged,
    commitments: commitments.map((item) => ({ text: item.text, direction: item.direction, due: item.due, overdue: item.state === "overdue" })),
  };
  const lines = briefLines(brief);
  if (normalizeBoolean(args.markSeen, false)) await store.markSeen(brief.generatedAt, optionalString(args, "account") ? perAccount.map((entry) => entry.key) : undefined);
  return createTextResult({ ...brief, text: lines });
}
