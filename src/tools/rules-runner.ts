import type { AccountBundle } from "../services/account-manager.js";
import type { MailRule, PlannedChange, RuleLogEntry } from "../services/rules-service.js";
import { planChanges } from "../services/rules-service.js";
import type { EmailSummary, SendEmailInput } from "../types/index.js";
import { parseEmailId } from "../utils/helpers.js";
import { logger } from "../utils/logger.js";
import { ensureEmailActionAllowed, ensureMailboxWriteAllowed, ensureOutboundRecipientsAllowed, ensureSendAllowed } from "../utils/runtime-policy.js";
import { buildForwardText, prefixedSubject } from "./compose.js";

// Carrying out what the rules planned: markers, labels, moves and forwards, through the same service methods the
// tools use and under the same runtime policy. A run by itself on new mail only does what is safe (never trash or
// delete, and a forward only where sending is allowed); a run that was asked for checks everything first.

export interface RunOptions {
  /** A run after a sync: each action the policy does not allow is skipped quietly instead of failing the run. */
  automatic: boolean;
  dryRun: boolean;
  /** At most this many messages. */
  limit: number;
}

export interface ChangeResult {
  id: string;
  from: string;
  subject: string;
  rules: string[];
  actions: string[];
  error?: string;
}

export interface RunResult {
  dryRun: boolean;
  messages: number;
  changed: number;
  failed: number;
  forwarded: number;
  skippedByPolicy: string[];
  results: ChangeResult[];
}

/** What a planned change would do; empty when the message is already as the rules want it. */
export function describe(change: PlannedChange): string[] {
  const did: string[] = [];
  for (const forward of change.forwardTo) did.push(`forward to ${forward.to.join(", ")}`);
  for (const label of change.label) did.push(`label ${label}`);
  if (change.markRead && !change.email.isRead) did.push("mark read");
  const d = change.disposition;
  if (d) did.push(d.kind === "move" ? `move to ${d.target}` : d.kind === "trash" ? "move to Trash" : d.kind === "delete" ? "delete for good" : "archive");
  return did;
}

/** The kinds of action a plan needs the policy to allow. */
export function requiredActions(plan: PlannedChange[]): Array<"mark_read" | "archive" | "move" | "trash" | "delete" | "label" | "forward"> {
  const needed = new Set<"mark_read" | "archive" | "move" | "trash" | "delete" | "label" | "forward">();
  for (const change of plan) {
    if (change.markRead && !change.email.isRead) needed.add("mark_read");
    if (change.label.length) needed.add("label");
    if (change.forwardTo.length) needed.add("forward");
    if (change.disposition) needed.add(change.disposition.kind === "move" ? "move" : change.disposition.kind);
  }
  return [...needed];
}

/** Throws the policy's own message when one of the needed actions is not allowed. */
export function assertPlanAllowed(bundle: AccountBundle, plan: PlannedChange[]): void {
  const runtime = bundle.config.runtime;
  for (const action of requiredActions(plan)) {
    if (action === "label") ensureMailboxWriteAllowed(runtime);
    else if (action === "forward") {
      ensureSendAllowed(runtime);
      for (const change of plan) {
        for (const forward of change.forwardTo) ensureOutboundRecipientsAllowed(runtime, bundle.config.smtp.username, forward.to);
      }
    } else ensureEmailActionAllowed(runtime, action);
  }
}

function allowed(bundle: AccountBundle, action: ReturnType<typeof requiredActions>[number], recipients?: string[]): boolean {
  try {
    const runtime = bundle.config.runtime;
    if (action === "label") ensureMailboxWriteAllowed(runtime);
    else if (action === "forward") {
      ensureSendAllowed(runtime);
      ensureOutboundRecipientsAllowed(runtime, bundle.config.smtp.username, recipients ?? []);
    } else ensureEmailActionAllowed(runtime, action);
    return true;
  } catch {
    return false;
  }
}

/** Forwards one message to `to`, with its attachments, the way forward_email does. */
export async function forwardMessage(bundle: AccountBundle, emailId: string, to: string[], note?: string): Promise<void> {
  const detail = await bundle.imapService.getEmailById(emailId);
  const attachments = await Promise.all(
    detail.attachments.filter((attachment) => attachment.id).map((attachment) => bundle.imapService.getAttachmentForForward(detail.id, attachment.id as string)),
  );
  const payload: SendEmailInput = {
    to,
    subject: prefixedSubject(detail.subject, "Fwd:"),
    body: buildForwardText(detail, note ?? ""),
    isHtml: false,
    attachments,
    appendSignature: false,
    // Marks the copy as machine-made, so an autoresponder at the other end stays quiet and a loop through a second
    // forwarding rule is recognisable.
    headers: { "Auto-Submitted": "auto-generated", "X-Forwarded-By": "proton-mail-bridge-client" },
  };
  await bundle.smtpService.sendEmail(payload);
  try {
    await bundle.auditService.record({
      timestamp: new Date().toISOString(),
      tool: "rule_forward",
      status: "success",
      input: { to, subject: detail.subject },
    });
  } catch {
    // bookkeeping only
  }
}

/** Carries out `plan`. With dryRun it only describes. Records handled messages and a log unless it is a dry run. */
export async function executePlan(bundle: AccountBundle, plan: PlannedChange[], options: RunOptions): Promise<RunResult> {
  // A message the rules would leave as it is (already read, say) is not a change.
  const limited = plan.filter((change) => describe(change).length > 0).slice(0, options.limit);
  const result: RunResult = { dryRun: options.dryRun, messages: limited.length, changed: 0, failed: 0, forwarded: 0, skippedByPolicy: [], results: [] };
  if (!options.dryRun && !options.automatic) assertPlanAllowed(bundle, limited);
  const log: RuleLogEntry[] = [];
  const handled: Array<{ ruleId: string; messageId: string }> = [];
  let forwards = 0;
  const skipped = new Set<string>();

  for (const change of limited) {
    const email = change.email;
    const entry: ChangeResult = {
      id: email.id,
      from: email.from[0]?.address ?? "",
      subject: email.subject,
      rules: change.rules.map((rule) => rule.name),
      actions: describe(change),
    };
    if (options.dryRun) {
      result.results.push(entry);
      continue;
    }
    const did: string[] = [];
    try {
      const uidValidity = parseEmailId(email.id).uidValidity;
      for (const forward of change.forwardTo) {
        if (!allowed(bundle, "forward", forward.to)) {
          skipped.add("forward");
          continue;
        }
        if ((await bundle.rulesService.reserveForwards(1)) < 1) {
          skipped.add("forward (daily limit)");
          continue;
        }
        await forwardMessage(bundle, email.id, forward.to, forward.note);
        did.push(`forwarded to ${forward.to.join(", ")}`);
        forwards += 1;
      }
      for (const label of change.label) {
        if (!allowed(bundle, "label")) {
          skipped.add("label");
          continue;
        }
        await bundle.imapService.updateMessageLabels(email.id, [label], [], uidValidity);
        did.push(`label ${label}`);
      }
      if (change.markRead && !email.isRead) {
        if (!allowed(bundle, "mark_read")) skipped.add("mark read");
        else {
          await bundle.imapService.markEmailRead(email.id, true, uidValidity);
          did.push("marked read");
        }
      }
      const d = change.disposition;
      if (d) {
        const action = d.kind === "move" ? "move" : d.kind;
        if (!allowed(bundle, action)) skipped.add(action);
        else if (d.kind === "archive") {
          await bundle.imapService.archiveEmail(email.id, uidValidity);
          did.push("archived");
        } else if (d.kind === "move") {
          await bundle.imapService.moveEmail(email.id, d.target as string, uidValidity);
          did.push(`moved to ${d.target}`);
        } else if (d.kind === "trash") {
          await bundle.imapService.trashEmail(email.id, uidValidity);
          did.push("moved to Trash");
        } else {
          await bundle.imapService.deleteEmail(email.id, uidValidity);
          did.push("deleted");
        }
      }
      if (did.length) result.changed += 1;
      entry.actions = did;
    } catch (error) {
      result.failed += 1;
      entry.error = error instanceof Error ? error.message : String(error);
      logger.warn("A rule could not be applied to a message", "RulesRunner", { id: email.id, error });
    }
    result.results.push(entry);
    for (const rule of change.rules) {
      if (options.automatic && email.messageId) handled.push({ ruleId: rule.id, messageId: email.messageId });
      if (did.length || entry.error) {
        log.push({
          at: new Date().toISOString(),
          ruleId: rule.id,
          ruleName: rule.name,
          messageId: email.id,
          from: entry.from,
          subject: email.subject.slice(0, 120),
          did,
          ...(entry.error ? { error: entry.error } : {}),
        });
      }
    }
  }
  result.forwarded = forwards;
  result.skippedByPolicy = [...skipped];
  if (!options.dryRun) {
    // reserveForwards already counted the forwards against the day; only the handled messages and the log remain.
    await bundle.rulesService.record(log, handled, 0);
  }
  return result;
}

/** What runs after a sync: the enabled rules that are safe to run by themselves, on the mail that just arrived. */
export async function runRulesOnNewMail(bundle: AccountBundle, emails: EmailSummary[]): Promise<RunResult | undefined> {
  const rules: MailRule[] = await bundle.rulesService.enabledRules();
  if (rules.length === 0) return undefined;
  const handled = await bundle.rulesService.handledMap();
  const plan = planChanges(rules, emails, Date.now(), { automatic: true, handled, ownAddresses: bundle.ownAddresses });
  if (plan.length === 0) return undefined;
  return executePlan(bundle, plan, { automatic: true, dryRun: false, limit: 200 });
}
