import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EmailSummary, ProtonMailConfig } from "../types/index.js";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { isFileNotFound, setAsideCorruptStore } from "../utils/corrupt-store.js";
import { withFileLock } from "../utils/file-lock.js";
import { InvalidArgumentError, isValidEmail } from "../utils/helpers.js";
import { logger, type Logger } from "../utils/logger.js";

// Mailbox rules for one account, the way Proton's own filters work but also on mail that is already there, with a
// scan that PROPOSES rules instead of waiting to be told: newsletters nobody opens, senders whose mail you always
// file in the same folder, a Trash that has not been emptied. A proposal changes nothing until it is accepted, and a
// rule that deletes or moves to Trash never runs by itself on new mail: it runs when asked, after a preview.
//
// A rule is "when mail matches X, do Y". Y can also forward the message: that sends mail out, so it is held to the
// same rules as any send (sending allowed, recipients allowed, confirmed when set up) and to a few of its own
// (only mail that arrives after the rule was switched on, once per message, a cap per day, never a list or an
// automatic message unless the rule says so).

export interface RuleWhen {
  /** Addresses, or "*@example.com" / "@example.com" for a whole domain. Any of them matches. */
  from?: string[];
  /** The subject contains any of these (case-insensitive). */
  subjectContains?: string[];
  /** The folder the message is in. Default INBOX. */
  folder?: string;
  /** Arrived more than this many days ago. */
  olderThanDays?: number;
  hasAttachment?: boolean;
  /** true: only list/automatic mail (newsletters); false: only mail from people. Unset: both. */
  automated?: boolean;
  /** Only mail that has not been read. */
  unread?: boolean;
}

export interface RuleThen {
  markRead?: boolean;
  /** Move to the Archive folder. */
  archive?: boolean;
  moveTo?: string;
  /** Add this label. */
  label?: string;
  /** Move to Trash (recoverable). Runs only when asked, never by itself on new mail. */
  trash?: boolean;
  /** Delete for good. Runs only when asked, with confirmation. */
  delete?: boolean;
  /** Send a copy to these addresses (at most 3). */
  forwardTo?: string[];
  /** Text added above the forwarded message. */
  forwardNote?: string;
}

export interface MailRule {
  id: string;
  name: string;
  enabled: boolean;
  when: RuleWhen;
  actions: RuleThen;
  createdAt: string;
  /** When the rule was last switched on; only mail that arrived after it is forwarded or handled automatically. */
  activatedAt?: string;
  /** The proposal this rule came from. */
  source?: string;
}

export type ProposalKind = "newsletter-archive" | "newsletter-cleanup" | "sender-folder" | "trash-cleanup";

export interface RuleProposal {
  id: string;
  kind: ProposalKind;
  title: string;
  rule: { name: string; when: RuleWhen; actions: RuleThen };
  evidence: { messages: number; unreadPercent?: number; firstSeen?: string; lastSeen?: string; examples: string[]; folder?: string };
  /** low: only moves and marks; recoverable: moves to Trash; permanent: deletes for good. */
  risk: "low" | "recoverable" | "permanent";
  createdAt: string;
}

export interface RuleLogEntry {
  at: string;
  ruleId: string;
  ruleName: string;
  messageId: string;
  from: string;
  subject?: string;
  did: string[];
  error?: string;
}

interface RulesState {
  version: number;
  rules: MailRule[];
  proposals: RuleProposal[];
  dismissed: string[];
  /** Message ids a rule has already handled automatically, per rule. */
  handled: Record<string, string[]>;
  forwarded: { date: string; count: number };
  log: RuleLogEntry[];
}

export const MAX_RULES = 50;
export const MAX_FORWARD_RECIPIENTS = 3;
export const FORWARD_DAILY_LIMIT = 50;
const HANDLED_LIMIT = 2000;
const LOG_LIMIT = 300;
const MAX_PROPOSALS = 20;

function emptyState(): RulesState {
  return { version: 1, rules: [], proposals: [], dismissed: [], handled: {}, forwarded: { date: "", count: 0 }, log: [] };
}

// ---- matching -------------------------------------------------------------------------------------------------

function matchesAddress(pattern: string, address: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (p.startsWith("*@") || p.startsWith("@")) return address.endsWith(p.slice(p.indexOf("@")));
  return address === p;
}

function arrival(email: EmailSummary): number {
  return Date.parse(email.internalDate ?? email.date ?? "");
}

export function ruleMatches(when: RuleWhen, email: EmailSummary, now: number): boolean {
  if (email.folder.toLowerCase() !== (when.folder ?? "INBOX").toLowerCase()) return false;
  const sender = email.from[0]?.address?.trim().toLowerCase() ?? "";
  if (when.from?.length && !when.from.some((pattern) => matchesAddress(pattern, sender))) return false;
  if (when.subjectContains?.length && !when.subjectContains.some((text) => email.subject.toLowerCase().includes(text.toLowerCase()))) return false;
  if (when.olderThanDays !== undefined) {
    const at = arrival(email);
    if (!Number.isFinite(at) || now - at < when.olderThanDays * 24 * 60 * 60 * 1000) return false;
  }
  if (when.hasAttachment !== undefined && email.hasAttachments !== when.hasAttachment) return false;
  // Unknown (headers not read) matches neither side of "automated".
  if (when.automated !== undefined && email.isAutomated !== when.automated) return false;
  if (when.unread && email.isRead) return false;
  return true;
}

/** True when a rule can run by itself on new mail: it neither trashes nor deletes. */
export function runsAutomatically(actions: RuleThen): boolean {
  return !actions.trash && !actions.delete;
}

export interface PlannedChange {
  email: EmailSummary;
  rules: Array<{ id: string; name: string }>;
  markRead: boolean;
  label: string[];
  forwardTo: Array<{ to: string[]; note?: string; ruleId: string }>;
  /** The one thing that moves or removes the message; the first rule that asks for one decides. */
  disposition?: { kind: "archive" | "move" | "trash" | "delete"; target?: string; ruleId: string };
}

/**
 * What the enabled rules would do to each message. `automatic` limits it to new mail that arrived after each rule
 * was switched on, to rules that neither trash nor delete, and to messages a rule has not handled before.
 */
export function planChanges(
  rules: MailRule[],
  emails: EmailSummary[],
  now: number,
  options: { automatic?: boolean; handled?: Record<string, string[]>; ownAddresses?: string[] } = {},
): PlannedChange[] {
  const own = new Set((options.ownAddresses ?? []).map((address) => address.trim().toLowerCase()));
  const planned: PlannedChange[] = [];
  for (const email of emails) {
    const sender = email.from[0]?.address?.trim().toLowerCase() ?? "";
    if (own.has(sender)) continue;
    const change: PlannedChange = { email, rules: [], markRead: false, label: [], forwardTo: [] };
    for (const rule of rules) {
      if (!rule.enabled) continue;
      if (options.automatic) {
        if (!runsAutomatically(rule.actions)) continue;
        if (rule.activatedAt && !(arrival(email) >= Date.parse(rule.activatedAt))) continue;
        if (email.messageId && options.handled?.[rule.id]?.includes(email.messageId)) continue;
      }
      if (!ruleMatches(rule.when, email, now)) continue;
      // Forwarding is only ever for mail that arrived after the rule was switched on, and by default only mail from people.
      if (rule.actions.forwardTo?.length) {
        const fresh = !rule.activatedAt || arrival(email) >= Date.parse(rule.activatedAt);
        if (fresh && (rule.when.automated === true || email.isAutomated === false)) {
          change.forwardTo.push({ to: rule.actions.forwardTo, note: rule.actions.forwardNote, ruleId: rule.id });
        }
      }
      change.rules.push({ id: rule.id, name: rule.name });
      if (rule.actions.markRead) change.markRead = true;
      if (rule.actions.label && !change.label.includes(rule.actions.label)) change.label.push(rule.actions.label);
      if (!change.disposition) {
        if (rule.actions.delete) change.disposition = { kind: "delete", ruleId: rule.id };
        else if (rule.actions.trash) change.disposition = { kind: "trash", ruleId: rule.id };
        else if (rule.actions.moveTo) change.disposition = { kind: "move", target: rule.actions.moveTo, ruleId: rule.id };
        else if (rule.actions.archive) change.disposition = { kind: "archive", ruleId: rule.id };
      }
    }
    if (change.rules.length > 0) planned.push(change);
  }
  return planned;
}

// ---- proposals ------------------------------------------------------------------------------------------------

// What a rule does, without its name or id: two rules with the same conditions and actions are the same rule.
function canonical(rule: { when: RuleWhen; actions: RuleThen }): string {
  return JSON.stringify({ when: rule.when, actions: rule.actions }, (_, value) => (value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value));
}

export function proposalId(rule: { when: RuleWhen; actions: RuleThen }): string {
  return `p-${createHash("sha1").update(canonical(rule)).digest("hex").slice(0, 10)}`;
}

const TRASH_LIKE = /^(trash|bin|deleted( items| messages)?)$/i;
const SPAM_LIKE = /^(spam|junk)$/i;

export interface SuggestOptions {
  now?: number;
  ownAddresses?: string[];
  /** How far back to look, in days. */
  days?: number;
  /** A sender needs at least this many messages in that time to be proposed. */
  minMessages?: number;
}

/** Looks through messages already in the index and proposes rules. Pure: nothing is stored or changed here. */
export function suggestRules(emails: EmailSummary[], existing: MailRule[], dismissed: string[], options: SuggestOptions = {}): RuleProposal[] {
  const now = options.now ?? Date.now();
  const days = options.days ?? 90;
  const min = options.minMessages ?? 5;
  const own = new Set((options.ownAddresses ?? []).map((address) => address.trim().toLowerCase()));
  const since = now - days * 24 * 60 * 60 * 1000;
  const recent = emails.filter((email) => {
    const at = arrival(email);
    return Number.isFinite(at) && at >= since;
  });
  const known = new Set(existing.map((rule) => canonical(rule)));
  const proposals: RuleProposal[] = [];
  const add = (kind: ProposalKind, title: string, rule: RuleProposal["rule"], evidence: RuleProposal["evidence"], risk: RuleProposal["risk"]) => {
    const id = proposalId(rule);
    if (dismissed.includes(id) || known.has(canonical(rule))) return;
    if (proposals.some((entry) => entry.id === id)) return;
    proposals.push({ id, kind, title, rule, evidence, risk, createdAt: new Date(now).toISOString() });
  };
  const evidenceOf = (group: EmailSummary[], folder?: string): RuleProposal["evidence"] => {
    const times = group.map(arrival).filter(Number.isFinite).sort((a, b) => a - b);
    const unread = group.filter((email) => !email.isRead).length;
    return {
      messages: group.length,
      unreadPercent: Math.round((unread / group.length) * 100),
      firstSeen: times.length ? new Date(times[0]).toISOString().slice(0, 10) : undefined,
      lastSeen: times.length ? new Date(times.at(-1) as number).toISOString().slice(0, 10) : undefined,
      examples: [...new Set(group.map((email) => email.subject.trim()).filter(Boolean))].slice(0, 3),
      folder,
    };
  };

  // By sender.
  const bySender = new Map<string, EmailSummary[]>();
  for (const email of recent) {
    const sender = email.from[0]?.address?.trim().toLowerCase();
    if (!sender || own.has(sender)) continue;
    bySender.set(sender, [...(bySender.get(sender) ?? []), email]);
  }
  for (const [sender, group] of bySender) {
    if (group.length < min) continue;
    const automated = group.filter((email) => email.isAutomated === true).length / group.length;
    const inbox = group.filter((email) => email.folder.toLowerCase() === "inbox");
    if (automated >= 0.8) {
      const unreadShare = group.filter((email) => !email.isRead).length / group.length;
      if (inbox.length >= min && unreadShare >= 0.8) {
        add(
          "newsletter-archive",
          `Archive and mark as read mail from ${sender} (${group.length} messages, ${Math.round(unreadShare * 100)}% never opened)`,
          { name: `Archive ${sender}`, when: { from: [sender], automated: true, unread: true }, actions: { markRead: true, archive: true } },
          evidenceOf(group),
          "low",
        );
      }
      const times = group.map(arrival).filter(Number.isFinite);
      const oldest = times.length ? Math.min(...times) : now;
      if (group.length >= min + 3 && unreadShare >= 0.95 && now - oldest > 60 * 24 * 60 * 60 * 1000) {
        add(
          "newsletter-cleanup",
          `Move to Trash mail from ${sender} older than 30 days (${group.length} messages, almost none opened)`,
          { name: `Clean up ${sender}`, when: { from: [sender], automated: true, olderThanDays: 30, unread: true }, actions: { trash: true } },
          evidenceOf(group),
          "recoverable",
        );
      }
      continue;
    }
    // Mail from a person that you always file in the same folder.
    const byFolder = new Map<string, number>();
    for (const email of group) byFolder.set(email.folder, (byFolder.get(email.folder) ?? 0) + 1);
    const [topFolder, topCount] = [...byFolder.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topFolder.toLowerCase() !== "inbox" && !TRASH_LIKE.test(topFolder) && !SPAM_LIKE.test(topFolder) && topCount / group.length >= 0.8) {
      add(
        "sender-folder",
        `Move mail from ${sender} to ${topFolder} (${topCount} of ${group.length} messages are already there)`,
        { name: `${sender} to ${topFolder}`, when: { from: [sender], automated: false }, actions: { moveTo: topFolder } },
        evidenceOf(group, topFolder),
        "low",
      );
    }
  }

  // Trash and Spam that have not been emptied.
  for (const [pattern, label] of [[TRASH_LIKE, "Trash"], [SPAM_LIKE, "Spam"]] as const) {
    const folderNames = [...new Set(emails.map((email) => email.folder).filter((name) => pattern.test(name)))];
    for (const folder of folderNames) {
      const old = emails.filter((email) => email.folder === folder && now - arrival(email) > 30 * 24 * 60 * 60 * 1000);
      if (old.length >= 20) {
        add(
          "trash-cleanup",
          `Delete for good what has been in ${label} for more than 30 days (${old.length} messages)`,
          { name: `Empty old ${label}`, when: { folder, olderThanDays: 30 }, actions: { delete: true } },
          evidenceOf(old, folder),
          "permanent",
        );
      }
    }
  }
  return proposals.sort((a, b) => b.evidence.messages - a.evidence.messages).slice(0, MAX_PROPOSALS);
}

// ---- validation -----------------------------------------------------------------------------------------------

function stringList(value: unknown, name: string, max: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > max || value.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 200)) {
    throw new InvalidArgumentError(`${name} must be a list of 1 to ${max} non-empty strings.`);
  }
  return value.map((entry) => (entry as string).trim());
}

export function validateWhen(raw: unknown): RuleWhen {
  if (!raw || typeof raw !== "object") throw new InvalidArgumentError("when must be an object, for example {\"from\":[\"news@example.com\"]}.");
  const value = raw as Record<string, unknown>;
  const known = new Set(["from", "subjectContains", "folder", "olderThanDays", "hasAttachment", "automated", "unread"]);
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length) throw new InvalidArgumentError(`Unknown condition ${unknown.join(", ")}. Valid: ${[...known].join(", ")}.`);
  const when: RuleWhen = {};
  const from = stringList(value.from, "when.from", 50);
  if (from) when.from = from;
  const subject = stringList(value.subjectContains, "when.subjectContains", 20);
  if (subject) when.subjectContains = subject;
  if (value.folder !== undefined) {
    if (typeof value.folder !== "string" || !value.folder.trim()) throw new InvalidArgumentError("when.folder must be a folder name.");
    when.folder = value.folder.trim();
  }
  if (value.olderThanDays !== undefined) {
    if (!Number.isInteger(value.olderThanDays) || (value.olderThanDays as number) < 1 || (value.olderThanDays as number) > 3650) {
      throw new InvalidArgumentError("when.olderThanDays must be a whole number of days from 1 to 3650.");
    }
    when.olderThanDays = value.olderThanDays as number;
  }
  for (const key of ["hasAttachment", "automated", "unread"] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "boolean") throw new InvalidArgumentError(`when.${key} must be true or false.`);
      when[key] = value[key] as boolean;
    }
  }
  // A rule that names nothing but a folder would touch the whole folder.
  if (!when.from && !when.subjectContains && when.olderThanDays === undefined && when.hasAttachment === undefined && when.automated === undefined && !when.unread) {
    throw new InvalidArgumentError("A rule needs at least one condition besides the folder: from, subjectContains, olderThanDays, hasAttachment, automated or unread.");
  }
  return when;
}

export function validateThen(raw: unknown, when: RuleWhen): RuleThen {
  if (!raw || typeof raw !== "object") throw new InvalidArgumentError("actions must be an object, for example {\"markRead\":true,\"archive\":true}.");
  const value = raw as Record<string, unknown>;
  const known = new Set(["markRead", "archive", "moveTo", "label", "trash", "delete", "forwardTo", "forwardNote"]);
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length) throw new InvalidArgumentError(`Unknown action ${unknown.join(", ")}. Valid: ${[...known].join(", ")}.`);
  const actions: RuleThen = {};
  for (const key of ["markRead", "archive", "trash", "delete"] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "boolean") throw new InvalidArgumentError(`actions.${key} must be true or false.`);
      if (value[key]) actions[key] = true;
    }
  }
  for (const key of ["moveTo", "label", "forwardNote"] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "string" || !(value[key] as string).trim() || (value[key] as string).length > (key === "forwardNote" ? 1000 : 200)) {
        throw new InvalidArgumentError(`actions.${key} must be non-empty text.`);
      }
      actions[key] = (value[key] as string).trim();
    }
  }
  if (value.forwardTo !== undefined) {
    const to = stringList(value.forwardTo, "actions.forwardTo", MAX_FORWARD_RECIPIENTS);
    for (const address of to ?? []) if (!isValidEmail(address)) throw new InvalidArgumentError(`actions.forwardTo has an invalid address: ${address}.`);
    actions.forwardTo = to;
  }
  const dispositions = [actions.archive, actions.moveTo, actions.trash, actions.delete].filter(Boolean).length;
  if (dispositions > 1) throw new InvalidArgumentError("Choose only one of archive, moveTo, trash and delete.");
  if (!actions.markRead && !actions.label && !actions.forwardTo && dispositions === 0) throw new InvalidArgumentError("A rule needs an action: markRead, label, archive, moveTo, trash, delete or forwardTo.");
  if (actions.forwardNote && !actions.forwardTo) throw new InvalidArgumentError("actions.forwardNote needs actions.forwardTo.");
  if (actions.forwardTo && !when.from && !when.subjectContains && when.hasAttachment === undefined) {
    throw new InvalidArgumentError("A forwarding rule needs a condition on the sender, the subject or an attachment, so that it does not forward everything.");
  }
  return actions;
}

export interface RulePatch {
  id?: string;
  name?: string;
  enabled?: boolean;
  when?: unknown;
  actions?: unknown;
  source?: string;
}

export class RulesService {
  private readonly storePath: string;

  constructor(
    config: ProtonMailConfig,
    private readonly log: Logger = logger,
  ) {
    this.storePath = join(config.dataDir, "rules.json");
  }

  async get(): Promise<{ rules: MailRule[]; proposals: RuleProposal[]; recent: RuleLogEntry[]; dismissed: number }> {
    const state = await this.load();
    return { rules: state.rules, proposals: state.proposals, recent: state.log.slice(-30).reverse(), dismissed: state.dismissed.length };
  }

  /** Create a rule, or change the one with `id`. Switching one on (from off) restarts "only mail after this moment". */
  async set(patch: RulePatch, now = Date.now()): Promise<MailRule> {
    return this.withLock(async () => {
      const state = await this.loadUnlocked();
      const existing = patch.id ? state.rules.find((rule) => rule.id === patch.id) : undefined;
      if (patch.id && !existing) throw new InvalidArgumentError(`No rule with id ${patch.id}.`);
      if (!existing && state.rules.length >= MAX_RULES) throw new InvalidArgumentError(`At most ${MAX_RULES} rules.`);
      const when = patch.when !== undefined ? validateWhen(patch.when) : existing?.when;
      if (!when) throw new InvalidArgumentError("A new rule needs when.");
      const actions = patch.actions !== undefined ? validateThen(patch.actions, when) : existing?.actions;
      if (!actions) throw new InvalidArgumentError("A new rule needs actions.");
      // A changed condition must still suit a forwarding action already there.
      validateThen(actions, when);
      const name = (patch.name ?? existing?.name ?? "").trim().slice(0, 100);
      if (!name) throw new InvalidArgumentError("A rule needs a name.");
      const enabled = patch.enabled ?? existing?.enabled ?? true;
      const rule: MailRule = {
        id: existing?.id ?? `r-${createHash("sha1").update(`${name}${now}${Math.random()}`).digest("hex").slice(0, 8)}`,
        name,
        enabled,
        when,
        actions,
        createdAt: existing?.createdAt ?? new Date(now).toISOString(),
        activatedAt: existing?.activatedAt,
        source: patch.source ?? existing?.source,
      };
      if (enabled && !existing?.enabled) rule.activatedAt = new Date(now).toISOString();
      state.rules = existing ? state.rules.map((candidate) => (candidate.id === rule.id ? rule : candidate)) : [...state.rules, rule];
      if (rule.source) state.proposals = state.proposals.filter((proposal) => proposal.id !== rule.source);
      await this.save(state);
      return rule;
    });
  }

  /** Delete a rule, or dismiss a proposal (so it is not proposed again). */
  async remove(id: string): Promise<{ removed: "rule" | "proposal" | "none" }> {
    return this.withLock(async () => {
      const state = await this.loadUnlocked();
      if (state.rules.some((rule) => rule.id === id)) {
        state.rules = state.rules.filter((rule) => rule.id !== id);
        delete state.handled[id];
        await this.save(state);
        return { removed: "rule" as const };
      }
      if (state.proposals.some((proposal) => proposal.id === id)) {
        state.proposals = state.proposals.filter((proposal) => proposal.id !== id);
        if (!state.dismissed.includes(id)) state.dismissed.push(id);
        await this.save(state);
        return { removed: "proposal" as const };
      }
      return { removed: "none" as const };
    });
  }

  async findProposal(id: string): Promise<RuleProposal | undefined> {
    return (await this.load()).proposals.find((proposal) => proposal.id === id);
  }

  /** Scan `emails` and keep the proposals (replacing the earlier ones that were never accepted). */
  async suggest(emails: EmailSummary[], options: SuggestOptions & { save?: boolean } = {}): Promise<RuleProposal[]> {
    const state = await this.load();
    const proposals = suggestRules(emails, state.rules, state.dismissed, options);
    if (options.save !== false) {
      await this.withLock(async () => {
        const fresh = await this.loadUnlocked();
        fresh.proposals = proposals;
        await this.save(fresh);
      });
    }
    return proposals;
  }

  async enabledRules(): Promise<MailRule[]> {
    return (await this.load()).rules.filter((rule) => rule.enabled);
  }

  async allRules(): Promise<MailRule[]> {
    return (await this.load()).rules;
  }

  async handledMap(): Promise<Record<string, string[]>> {
    return (await this.load()).handled;
  }

  /** Record what was done: the messages each rule has handled, the forwards counted against the day, the log. */
  async record(entries: RuleLogEntry[], handled: Array<{ ruleId: string; messageId: string }>, forwards: number, now = Date.now()): Promise<void> {
    await this.withLock(async () => {
      const state = await this.loadUnlocked();
      for (const { ruleId, messageId } of handled) {
        const list = state.handled[ruleId] ?? [];
        if (!list.includes(messageId)) list.push(messageId);
        state.handled[ruleId] = list.slice(-HANDLED_LIMIT);
      }
      const today = new Date(now).toISOString().slice(0, 10);
      state.forwarded = { date: today, count: (state.forwarded.date === today ? state.forwarded.count : 0) + forwards };
      state.log = [...state.log, ...entries].slice(-LOG_LIMIT);
      await this.save(state);
    });
  }

  async forwardsToday(now = Date.now()): Promise<number> {
    const state = await this.load();
    return state.forwarded.date === new Date(now).toISOString().slice(0, 10) ? state.forwarded.count : 0;
  }

  /** Reserve forwards against the day's cap before sending; returns how many may go out. */
  async reserveForwards(wanted: number, now = Date.now()): Promise<number> {
    return this.withLock(async () => {
      const state = await this.loadUnlocked();
      const today = new Date(now).toISOString().slice(0, 10);
      const used = state.forwarded.date === today ? state.forwarded.count : 0;
      const allowed = Math.max(0, Math.min(wanted, FORWARD_DAILY_LIMIT - used));
      state.forwarded = { date: today, count: used + allowed };
      await this.save(state);
      return allowed;
    });
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.storePath), { recursive: true, mode: 0o700 });
    return withFileLock(this.storePath, fn);
  }

  private async load(): Promise<RulesState> {
    return this.loadUnlocked();
  }

  private async loadUnlocked(): Promise<RulesState> {
    try {
      const parsed = JSON.parse(await readFile(this.storePath, "utf8")) as Partial<RulesState>;
      return {
        ...emptyState(),
        ...parsed,
        rules: Array.isArray(parsed.rules) ? parsed.rules : [],
        proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
        dismissed: Array.isArray(parsed.dismissed) ? parsed.dismissed : [],
        handled: parsed.handled && typeof parsed.handled === "object" ? parsed.handled : {},
        forwarded: parsed.forwarded && typeof parsed.forwarded.date === "string" ? parsed.forwarded : { date: "", count: 0 },
        log: Array.isArray(parsed.log) ? parsed.log : [],
      };
    } catch (error) {
      if (isFileNotFound(error)) return emptyState();
      setAsideCorruptStore(this.storePath, error, this.log, "RulesService");
      return emptyState();
    }
  }

  private async save(state: RulesState): Promise<void> {
    await writeFileAtomic(this.storePath, JSON.stringify(state, null, 2));
  }
}
