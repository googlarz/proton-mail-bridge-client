import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EmailSummary, ProtonMailConfig } from "../types/index.js";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { isFileNotFound, setAsideCorruptStore } from "../utils/corrupt-store.js";
import { withFileLock } from "../utils/file-lock.js";
import { InvalidArgumentError } from "../utils/helpers.js";
import { logger, type Logger } from "../utils/logger.js";
import { assessMail } from "../utils/mail-security.js";
import { detectLanguage, greetingAndClosing, hasClosing, hasGreeting, STYLE_LANGUAGES, type StyleProfile } from "../utils/style-profile.js";

// An automatic reply for one address, plus a note that address appends to what it sends. It sends mail without anyone
// looking, so every default is the cautious one: off, only to a human sender who wrote to this address, once per
// sender for a number of days, never to a list or an automatic message, never for mail that arrived before it was
// switched on, never to someone you have already answered, and a cap per day. A reply is recorded before it is sent,
// so a crash cannot cause a second one.
//
// What it does beyond a plain away message:
//  - rules, first match wins: a VIP or a domain can get another text, a draft for you to approve, or nothing;
//  - it can prepare a DRAFT instead of sending (and does so by itself when the server may not send);
//  - it can answer only outside working hours, in a time zone;
//  - the text can use {senderName}, {senderFirstName}, {subject}, {startsAt}, {endsAt}, {returnDate}, {backupContact};
//  - it can answer in the sender's language (en, pl, de) when a text in that language is given, dates included;
//  - a draft opens and closes the way you do (from your style profile), so it reads as yours when you approve it;
//  - it can tell people you have written to from people you have not;
//  - it keeps a log, and `preview` shows what it would do to the mail already in the index without doing it.

export type AutoresponderAction = "reply" | "draft" | "skip";

export interface AutoresponderMatchRule {
  name?: string;
  /** Addresses, "*@example.com" / "@example.com" for a whole domain, or "tag:vip" for people with that contact tag (set_contact). Any of them matches. */
  from?: string[];
  /** The subject contains any of these (case-insensitive). */
  subjectContains?: string[];
  /** "yes": the sender is someone you have written to; "no": you have not. */
  known?: "yes" | "no";
  action: AutoresponderAction;
  /** Overrides the rule's subject / body for this match. */
  subject?: string;
  body?: string;
}

export interface AutoresponderRule {
  enabled: boolean;
  /** Subject of the reply; {subject} is replaced by the subject of the message answered. */
  subject: string;
  body: string;
  /** Subject and body by language code (en, pl, de), used when the message answered is in that language. */
  subjects?: Record<string, string>;
  bodies?: Record<string, string>;
  /** Plain text for {returnDate} (a YYYY-MM-DD date is written out in the reply's language) and {backupContact}. */
  returnDate?: string;
  backupContact?: string;
  /** Only mail that arrived inside this window is answered, and the outgoing note shows only inside it. */
  startsAt?: string;
  endsAt?: string;
  /** A sender gets at most one reply in this many days. */
  replyEveryDays: number;
  /** Appended to every mail sent from this address while the rule is active. */
  outgoingNote?: string;
  updatedAt: string;
  /** When the rule was last switched on; mail from before that moment is never answered. */
  activatedAt?: string;
  /** What the default reply does: send it (default) or leave a draft for approval. */
  mode?: "send" | "draft";
  /** IANA time zone for outsideHours and for dates in the text. Default: the server's. */
  timezone?: string;
  /** Active only OUTSIDE these hours (days 0=Sunday..6, times HH:MM): the reply is for when you are not at work. */
  outsideHours?: { days: number[]; from: string; to: string };
  /** At most this many replies and drafts a day (default 50). */
  dailyLimit?: number;
  /** Do not answer a sender you have already written to since their message (default true). */
  skipIfAnswered?: boolean;
  /** Checked in order; the first that matches decides. Mail that matches none gets the default reply. */
  rules?: AutoresponderMatchRule[];
}

export interface AutoresponderLogEntry {
  at: string;
  messageId?: string;
  id: string;
  from: string;
  subject?: string;
  outcome: "replied" | "drafted" | "skipped" | "failed";
  reason?: string;
  rule?: string;
}

export interface AutoresponderState {
  version: number;
  rule?: AutoresponderRule;
  /** Last reply per sender address (lower case). */
  replies: Record<string, string>;
  /** Message-Ids already dealt with, newest last. */
  handled: string[];
  daily: { date: string; count: number };
  sentTotal: number;
  draftedTotal?: number;
  log?: AutoresponderLogEntry[];
}

export const AUTORESPONDER_MAX_PER_DAY = 50;
const MAX_DAILY_LIMIT = 200;
const MAX_RULES = 20;
const HANDLED_LIMIT = 2000;
const LOG_LIMIT = 200;
const DEFAULT_SUBJECT = "Automatic reply: {subject}";
const NO_REPLY_SENDER = /(^|[._+-])(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|mailer[-_.]?daemon|postmaster|bounces?|notifications?|alerts?|automated?|daemon)([._+-]|@)/i;

export type AutoresponderSkipReason =
  | "not-active"
  | "wrong-folder"
  | "before-activation"
  | "outside-window"
  | "not-human"
  | "suspicious"
  | "no-sender"
  | "own-address"
  | "no-reply-sender"
  | "not-addressed-to-us"
  | "already-handled"
  | "replied-recently"
  | "daily-limit"
  | "rule-skip"
  | "answered-already"
  | "no-text"
  | "cannot-send-or-draft"
  | "lookup-failed";

// Skips that will not change on a later sync: the message is marked dealt with, so it is neither judged nor logged again.
const PERMANENT_SKIPS = new Set<string>([
  "not-human", "no-sender", "own-address", "no-reply-sender", "not-addressed-to-us", "replied-recently",
  "rule-skip", "answered-already", "no-text", "cannot-send-or-draft",
]);

// Skips that are the ordinary case on every sync and are neither returned nor logged.
const QUIET_SKIPS = new Set<string>(["not-active", "wrong-folder", "before-activation", "already-handled", "outside-window"]);

function emptyState(): AutoresponderState {
  return { version: 2, replies: {}, handled: [], daily: { date: "", count: 0 }, sentTotal: 0 };
}

function parseDate(value: string | undefined, name: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new InvalidArgumentError(`${name} must be a date, for example 2026-12-24 or 2026-12-24T18:00:00+01:00.`);
  return new Date(time).toISOString();
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function minutesOf(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/** The weekday (0=Sunday) and minutes since midnight at `now` in `timezone`. */
export function localClock(now: number, timezone?: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { day: WEEKDAYS[get("weekday")] ?? 0, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** True when `now` falls inside the working hours (so an outsideHours rule is not active). */
export function insideWorkingHours(hours: NonNullable<AutoresponderRule["outsideHours"]>, now: number, timezone?: string): boolean {
  const { day, minutes } = localClock(now, timezone);
  if (!hours.days.includes(day)) return false;
  const from = minutesOf(hours.from);
  const to = minutesOf(hours.to);
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

export function isActive(rule: AutoresponderRule | undefined, now: number): boolean {
  if (!rule?.enabled) return false;
  if (rule.startsAt && now < Date.parse(rule.startsAt)) return false;
  if (rule.endsAt && now > Date.parse(rule.endsAt)) return false;
  if (rule.outsideHours && insideWorkingHours(rule.outsideHours, now, rule.timezone)) return false;
  return true;
}

export interface AutoresponderChecks {
  /** The activation / window / "not active" checks are skipped (a preview judges mail as if the rule were on). */
  ignoreActivation?: boolean;
}

/** Why a message must not get a reply, or undefined when it may. Pure: nothing is recorded here. */
export function skipReason(
  email: EmailSummary,
  state: AutoresponderState,
  ownAddresses: string[],
  now: number,
  checks: AutoresponderChecks = {},
): AutoresponderSkipReason | undefined {
  const rule = state.rule;
  if (!rule) return "not-active";
  if (!checks.ignoreActivation && !isActive(rule, now)) return "not-active";
  if (email.folder.toUpperCase() !== "INBOX") return "wrong-folder";
  // Judged once: a message already dealt with (answered, or skipped for good) is not judged or logged again.
  if (email.messageId && state.handled.includes(email.messageId)) return "already-handled";
  const arrived = Date.parse(email.internalDate ?? email.date ?? "");
  if (!checks.ignoreActivation && rule.activatedAt && !(arrived >= Date.parse(rule.activatedAt))) return "before-activation";
  if (rule.startsAt && arrived < Date.parse(rule.startsAt)) return "outside-window";
  if (rule.endsAt && arrived > Date.parse(rule.endsAt)) return "outside-window";
  // Only a message positively known to be from a person: automatic and list mail, and mail whose headers were not
  // read, are left alone.
  if (email.isAutomated !== false) return "not-human";
  const sender = email.from[0]?.address?.trim().toLowerCase();
  if (!sender?.includes("@")) return "no-sender";
  const own = new Set(ownAddresses.map((address) => address.trim().toLowerCase()));
  if (own.has(sender)) return "own-address";
  if (NO_REPLY_SENDER.test(sender)) return "no-reply-sender";
  const direct = [...email.to, ...email.cc].some((entry) => entry.address && own.has(entry.address.trim().toLowerCase()));
  const delivered = email.deliveredTo ? own.has(email.deliveredTo.trim().toLowerCase()) : false;
  if (!direct && !delivered) return "not-addressed-to-us";
  const last = state.replies[sender];
  if (last && now - Date.parse(last) < rule.replyEveryDays * 24 * 60 * 60 * 1000) return "replied-recently";
  const today = new Date(now).toISOString().slice(0, 10);
  if (state.daily.date === today && state.daily.count >= (rule.dailyLimit ?? AUTORESPONDER_MAX_PER_DAY)) return "daily-limit";
  return undefined;
}

function matchesAddress(pattern: string, address: string, tags: string[] = []): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (p.startsWith("tag:")) return tags.includes(p.slice(4).trim());
  if (p.startsWith("*@") || p.startsWith("@")) return address.endsWith(p.slice(p.indexOf("@")));
  return address === p;
}

function firstName(display: string | undefined, address: string): string {
  const name = (display ?? "").replace(/["<>]/g, "").trim();
  if (name && !name.includes("@")) return name.split(/\s+/)[0];
  return address.split("@")[0].split(/[._+-]/)[0];
}

const DATE_LOCALES: Record<string, string> = { en: "en-GB", pl: "pl-PL", de: "de-DE" };
const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;

function formatDate(iso: string | undefined, timezone?: string, language?: string): string {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat(DATE_LOCALES[language ?? ""] ?? "en-GB", { timeZone: timezone, day: "numeric", month: "long", year: "numeric" }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

/**
 * Fills {subject}, {senderName}, {senderFirstName}, {senderAddress}, {startsAt}, {endsAt}, {returnDate}, {backupContact};
 * other braces stay as written. Values are inserted as they are, never read as a template. `language` writes the dates
 * in that language (default English).
 */
export function renderText(template: string, rule: AutoresponderRule, email: EmailSummary, language?: string): string {
  const address = email.from[0]?.address ?? "";
  const display = email.from[0]?.name;
  const returnDate = rule.returnDate ?? "";
  const values: Record<string, string> = {
    subject: email.subject.replace(/^(re|aw|odp)\s*:\s*/i, "").trim() || "(no subject)",
    senderName: (display ?? "").replace(/["<>]/g, "").trim() || address,
    senderFirstName: firstName(display, address),
    senderAddress: address,
    startsAt: formatDate(rule.startsAt, rule.timezone, language),
    endsAt: formatDate(rule.endsAt, rule.timezone, language),
    // A plain date names a day, not a moment, so it is not shifted by a time zone.
    returnDate: PLAIN_DATE.test(returnDate) ? formatDate(`${returnDate}T00:00:00Z`, "UTC", language) : returnDate,
    backupContact: rule.backupContact ?? "",
  };
  return template.replace(/\{(subject|senderName|senderFirstName|senderAddress|startsAt|endsAt|returnDate|backupContact)\}/g, (_, key: string) => values[key]);
}

export function replySubject(rule: AutoresponderRule, original: string, email?: EmailSummary, language?: string): string {
  const template = rule.subject || DEFAULT_SUBJECT;
  const stripped = original.replace(/^(re|aw|odp)\s*:\s*/i, "").trim() || "(no subject)";
  const subject = email ? renderText(template, rule, { ...email, subject: original }, language) : template.replace(/\{subject\}/g, stripped);
  return subject.replace(/[\r\n]+/g, " ").slice(0, 200);
}

export interface AutoresponderReply {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references: string[];
  headers: Record<string, string>;
  /** The id of the message this answers, for a draft's source. */
  sourceEmailId?: string;
  rule?: string;
}

/** What the server around the service can do and know. All optional: without them the rules that need them do not match. */
export interface AutoresponderDeps {
  send?: (reply: AutoresponderReply) => Promise<void>;
  draft?: (reply: AutoresponderReply) => Promise<void>;
  /** Whether the runtime lets this server send (a reply then degrades to a draft) and write drafts. Default: yes. */
  canSend?: boolean;
  canDraft?: boolean;
  isKnownContact?: (address: string) => Promise<boolean>;
  hasAnsweredSince?: (address: string, sinceIso: string) => Promise<boolean>;
  /** The contact tags of an address, for "tag:vip" in a rule's from. */
  contactTags?: (address: string) => Promise<string[]>;
  /** Your style profile, if one was made (get_style_profile); a draft then opens and closes the way you do. */
  styleProfile?: () => Promise<StyleProfile | undefined>;
}

export interface AutoresponderDecision {
  id: string;
  from: string;
  subject: string;
  outcome: "reply" | "draft" | "skip";
  reason?: AutoresponderSkipReason;
  rule?: string;
  reply?: AutoresponderReply;
  /** The language the message answered is in, when it could be told. */
  language?: string;
  /** Where the text came from: the matching rule's own text, the text for the sender's language, or the default. */
  textFrom?: "rule" | "language" | "default";
  /** A draft given your greeting and closing from the style profile. */
  styled?: boolean;
}

/** Judges one message. Pure apart from the lookups in `deps`; records nothing. */
export async function decide(
  email: EmailSummary,
  state: AutoresponderState,
  ownAddresses: string[],
  now: number,
  deps: AutoresponderDeps,
  checks: AutoresponderChecks = {},
): Promise<AutoresponderDecision> {
  const rule = state.rule as AutoresponderRule;
  const sender = (email.from[0]?.address ?? "").trim().toLowerCase();
  const base = { id: email.id, from: sender, subject: email.subject };
  const reason = skipReason(email, state, ownAddresses, now, checks);
  if (reason) return { ...base, outcome: "skip", reason };
  // A reply to mail written to steer an AI would confirm that the address is read.
  if (assessMail({ from: email.from, replyTo: email.replyTo, subject: email.subject, text: email.preview, automated: email.isAutomated }).level === "high") return { ...base, outcome: "skip", reason: "suspicious" };

  // Rules, in order.
  let action: AutoresponderAction = rule.mode === "draft" ? "draft" : "reply";
  let subjectTemplate = rule.subject;
  let bodyTemplate = rule.body;
  let ruleName: string | undefined;
  let ruleSubject = false;
  let ruleBody = false;
  const needsKnown = rule.rules?.some((candidate) => candidate.known) === true;
  // A lookup that throws is not an answer: a rule that depends on it cannot be judged, so it must not be skipped over.
  let knownFailed = false;
  let tagsFailed = false;
  const known = needsKnown && deps.isKnownContact ? await deps.isKnownContact(sender).catch(() => {
    knownFailed = true;
    return false;
  }) : undefined;
  const needsTags = rule.rules?.some((candidate) => candidate.from?.some((pattern) => pattern.trim().toLowerCase().startsWith("tag:"))) === true;
  const tags = needsTags && deps.contactTags ? await deps.contactTags(sender).catch(() => {
    tagsFailed = true;
    return [] as string[];
  }) : [];
  for (const [index, candidate] of (rule.rules ?? []).entries()) {
    let unsure = false;
    if (candidate.from?.length && !candidate.from.some((pattern) => matchesAddress(pattern, sender, tags))) {
      if (tagsFailed && candidate.from.some((pattern) => pattern.trim().toLowerCase().startsWith("tag:"))) unsure = true;
      else continue;
    }
    if (candidate.subjectContains?.length && !candidate.subjectContains.some((text) => email.subject.toLowerCase().includes(text.toLowerCase()))) continue;
    if (candidate.known && knownFailed) unsure = true;
    else if (candidate.known && (known === undefined || (candidate.known === "yes") !== known)) continue;
    // Whatever this rule says (skip, say) cannot be told, and the default reply is not what its author meant.
    if (unsure) return { ...base, outcome: "skip", reason: "lookup-failed", rule: candidate.name || `rule ${index + 1}` };
    action = candidate.action;
    ruleName = candidate.name || `rule ${index + 1}`;
    if (candidate.subject !== undefined) [subjectTemplate, ruleSubject] = [candidate.subject, true];
    if (candidate.body !== undefined) [bodyTemplate, ruleBody] = [candidate.body, true];
    break;
  }
  if (action === "skip") return { ...base, outcome: "skip", reason: "rule-skip", rule: ruleName };

  // The sender's language picks the text where the matching rule has none of its own.
  const language = detectLanguage(`${email.subject}\n${email.preview ?? ""}`.slice(0, 2000));
  let textFrom: AutoresponderDecision["textFrom"] = ruleBody ? "rule" : "default";
  let bodyLanguage: string | undefined;
  let subjectLanguage: string | undefined;
  if (language && !ruleBody && rule.bodies?.[language]) [bodyTemplate, bodyLanguage, textFrom] = [rule.bodies[language], language, "language"];
  if (language && !ruleSubject && rule.subjects?.[language]) [subjectTemplate, subjectLanguage] = [rule.subjects[language], language];
  if (!bodyTemplate?.trim()) return { ...base, outcome: "skip", reason: "no-text", rule: ruleName };

  // What the server may do: a reply it may not send becomes a draft; with neither, nothing.
  const canSend = deps.canSend !== false;
  const canDraft = deps.canDraft !== false;
  if (action === "reply" && !canSend) action = "draft";
  if (action === "draft" && !canDraft) return { ...base, outcome: "skip", reason: "cannot-send-or-draft", rule: ruleName };

  if (rule.skipIfAnswered !== false && deps.hasAnsweredSince) {
    const since = email.internalDate ?? email.date ?? new Date(now).toISOString();
    if (await deps.hasAnsweredSince(sender, since).catch(() => false)) return { ...base, outcome: "skip", reason: "answered-already", rule: ruleName };
  }

  let body = renderText(bodyTemplate, rule, email, bodyLanguage);
  let styled = false;
  // Only a draft: it is read before it goes, while a sent reply carries exactly the text that was set.
  const replyLanguage = bodyLanguage ?? detectLanguage(body);
  if (action === "draft" && deps.styleProfile && replyLanguage) {
    const profile = await deps.styleProfile().catch(() => undefined);
    if (profile) {
      const { greeting, closing } = greetingAndClosing(profile, sender, replyLanguage);
      const open = greeting && !hasGreeting(body) ? `${greeting.replace("{name}", () => firstName(email.from[0]?.name, email.from[0]?.address ?? sender))}\n\n` : "";
      const close = closing && !hasClosing(body) ? `\n\n${closing}` : "";
      if (open || close) [body, styled] = [`${open}${body}${close}`, true];
    }
  }

  const reply: AutoresponderReply = {
    to: sender,
    subject: replySubject({ ...rule, subject: subjectTemplate }, email.subject, email, subjectLanguage),
    body,
    inReplyTo: email.messageId,
    references: [...(email.references ?? []), ...(email.messageId ? [email.messageId] : [])],
    headers: { "Auto-Submitted": "auto-replied", Precedence: "bulk", "X-Auto-Response-Suppress": "All" },
    sourceEmailId: email.id,
    rule: ruleName,
  };
  return { ...base, outcome: action, reply, rule: ruleName, language, textFrom, ...(styled ? { styled } : {}) };
}

function validateRules(rules: unknown): AutoresponderMatchRule[] {
  if (!Array.isArray(rules)) throw new InvalidArgumentError("rules must be a list.");
  if (rules.length > MAX_RULES) throw new InvalidArgumentError(`At most ${MAX_RULES} rules.`);
  return rules.map((raw, index) => {
    const at = `rules[${index}]`;
    if (!raw || typeof raw !== "object") throw new InvalidArgumentError(`${at} must be an object.`);
    const rule = raw as Record<string, unknown>;
    if (rule.action !== "reply" && rule.action !== "draft" && rule.action !== "skip") {
      throw new InvalidArgumentError(`${at}.action must be "reply", "draft" or "skip".`);
    }
    const strings = (key: string, max: number): string[] | undefined => {
      const value = rule[key];
      if (value === undefined) return undefined;
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 200) || value.length > max) {
        throw new InvalidArgumentError(`${at}.${key} must be a list of up to ${max} non-empty strings.`);
      }
      return value.map((entry) => (entry as string).trim());
    };
    const out: AutoresponderMatchRule = { action: rule.action };
    if (typeof rule.name === "string" && rule.name.trim()) out.name = rule.name.trim().slice(0, 80);
    const from = strings("from", 50);
    if (from) out.from = from;
    const subjectContains = strings("subjectContains", 20);
    if (subjectContains) out.subjectContains = subjectContains;
    if (rule.known !== undefined) {
      if (rule.known !== "yes" && rule.known !== "no") throw new InvalidArgumentError(`${at}.known must be "yes" or "no".`);
      out.known = rule.known;
    }
    if (rule.subject !== undefined) {
      if (typeof rule.subject !== "string" || rule.subject.length > 200) throw new InvalidArgumentError(`${at}.subject must be text up to 200 characters.`);
      out.subject = rule.subject;
    }
    if (rule.body !== undefined) {
      if (typeof rule.body !== "string" || rule.body.length > 4000) throw new InvalidArgumentError(`${at}.body must be text up to 4000 characters.`);
      out.body = rule.body.trim();
    }
    return out;
  });
}

function validateOutsideHours(value: unknown): AutoresponderRule["outsideHours"] {
  if (value === null) return undefined;
  const hours = value as { days?: unknown; from?: unknown; to?: unknown };
  if (!hours || typeof hours !== "object") throw new InvalidArgumentError('outsideHours must be {days:[1,2,3,4,5], from:"09:00", to:"17:00"}, or null to remove it.');
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!Array.isArray(hours.days) || hours.days.length === 0 || hours.days.some((d) => !Number.isInteger(d) || (d as number) < 0 || (d as number) > 6)) {
    throw new InvalidArgumentError("outsideHours.days must be a list of weekdays 0 (Sunday) to 6 (Saturday).");
  }
  if (typeof hours.from !== "string" || typeof hours.to !== "string" || !time.test(hours.from) || !time.test(hours.to)) {
    throw new InvalidArgumentError('outsideHours.from and .to must be times like "09:00".');
  }
  return { days: [...new Set(hours.days as number[])].sort(), from: hours.from, to: hours.to };
}

// Only the languages the detector can tell apart: a text for any other could never be chosen.
function validateLanguageTexts(value: unknown, name: string, max: number): Record<string, string> | undefined {
  if (value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidArgumentError(`${name} must be an object keyed by language code (${STYLE_LANGUAGES.join(", ")}), or null to remove it.`);
  }
  const out: Record<string, string> = {};
  for (const [key, text] of Object.entries(value)) {
    const code = key.trim().toLowerCase();
    if (!STYLE_LANGUAGES.includes(code)) throw new InvalidArgumentError(`${name}: "${key.slice(0, 20)}" is not a language that can be recognised; use ${STYLE_LANGUAGES.join(", ")}.`);
    if (typeof text !== "string" || text.length > max) throw new InvalidArgumentError(`${name}.${code} must be text up to ${max} characters.`);
    if (text.trim()) out[code] = text.trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function validateLine(value: string, name: string, max: number): string | undefined {
  if (value.length > max || /[\r\n]/.test(value)) throw new InvalidArgumentError(`${name} must be one line of up to ${max} characters.`);
  return value.trim() || undefined;
}

export interface AutoresponderPatch {
  enabled?: boolean;
  subject?: string;
  body?: string;
  /** Replace the whole map ({} or null clears it); an empty text removes that language. */
  subjects?: unknown;
  bodies?: unknown;
  /** Empty string removes it. */
  returnDate?: string;
  backupContact?: string;
  startsAt?: string;
  endsAt?: string;
  replyEveryDays?: number;
  outgoingNote?: string;
  mode?: "send" | "draft";
  timezone?: string;
  /** null removes it. */
  outsideHours?: { days: number[]; from: string; to: string } | null;
  dailyLimit?: number;
  skipIfAnswered?: boolean;
  /** Replaces the whole list; [] clears it. */
  rules?: unknown;
}

export class AutoresponderService {
  private readonly storePath: string;

  constructor(
    config: ProtonMailConfig,
    private readonly log: Logger = logger,
  ) {
    this.storePath = join(config.dataDir, "autoresponder.json");
    void this.refreshCache();
  }

  // A mail is built synchronously, so the rule the outgoing note comes from is kept in memory and re-read now and
  // then (another process, such as the CLI, may have changed the file).
  private cache?: { rule?: AutoresponderRule; loadedAt: number };

  private async refreshCache(): Promise<void> {
    try {
      this.cache = { rule: (await this.loadUnlocked()).rule, loadedAt: Date.now() };
    } catch {
      this.cache = { rule: undefined, loadedAt: Date.now() };
    }
  }

  /** The note for a mail built right now. Never waits for the disk; an out-of-date cache is refreshed for the next one. */
  outgoingNoteNow(now = Date.now()): string | undefined {
    if (!this.cache || now - this.cache.loadedAt > 30_000) void this.refreshCache();
    return isActive(this.cache?.rule, now) ? this.cache?.rule?.outgoingNote : undefined;
  }

  /** The note a mail sent at `now` carries (reads the file). */
  async outgoingNote(now = Date.now()): Promise<string | undefined> {
    const state = await this.load();
    return isActive(state.rule, now) ? state.rule?.outgoingNote : undefined;
  }

  async get(): Promise<{
    rule?: AutoresponderRule;
    active: boolean;
    sentTotal: number;
    draftedTotal: number;
    repliedSenders: number;
    sentToday: number;
    summary: { replied: number; drafted: number; skipped: number; failed: number; skippedByReason: Record<string, number>; senders: string[] };
    recent: AutoresponderLogEntry[];
  }> {
    const state = await this.load();
    const today = new Date().toISOString().slice(0, 10);
    const log = state.log ?? [];
    const since = state.rule?.activatedAt ? Date.parse(state.rule.activatedAt) : 0;
    const inWindow = log.filter((entry) => Date.parse(entry.at) >= since);
    const skippedByReason: Record<string, number> = {};
    for (const entry of inWindow) {
      if (entry.outcome === "skipped") skippedByReason[entry.reason ?? "other"] = (skippedByReason[entry.reason ?? "other"] ?? 0) + 1;
    }
    return {
      rule: state.rule,
      active: isActive(state.rule, Date.now()),
      sentTotal: state.sentTotal,
      draftedTotal: state.draftedTotal ?? 0,
      repliedSenders: Object.keys(state.replies).length,
      sentToday: state.daily.date === today ? state.daily.count : 0,
      summary: {
        replied: inWindow.filter((entry) => entry.outcome === "replied").length,
        drafted: inWindow.filter((entry) => entry.outcome === "drafted").length,
        skipped: inWindow.filter((entry) => entry.outcome === "skipped").length,
        failed: inWindow.filter((entry) => entry.outcome === "failed").length,
        skippedByReason,
        senders: [...new Set(inWindow.map((entry) => entry.from))].slice(-30),
      },
      recent: log.slice(-20).reverse(),
    };
  }

  /** Create or change the rule. Switching it on (from off) restarts "mail from before this moment is not answered". */
  async set(patch: AutoresponderPatch, now = Date.now()): Promise<AutoresponderRule> {
    return this.withLock(async () => {
      const state = await this.loadUnlocked();
      const before = state.rule;
      const next: AutoresponderRule = {
        enabled: before?.enabled ?? false,
        subject: before?.subject ?? DEFAULT_SUBJECT,
        body: before?.body ?? "",
        subjects: before?.subjects,
        bodies: before?.bodies,
        returnDate: before?.returnDate,
        backupContact: before?.backupContact,
        startsAt: before?.startsAt,
        endsAt: before?.endsAt,
        replyEveryDays: before?.replyEveryDays ?? 7,
        outgoingNote: before?.outgoingNote,
        updatedAt: new Date(now).toISOString(),
        activatedAt: before?.activatedAt,
        mode: before?.mode,
        timezone: before?.timezone,
        outsideHours: before?.outsideHours,
        dailyLimit: before?.dailyLimit,
        skipIfAnswered: before?.skipIfAnswered,
        rules: before?.rules,
      };
      if (patch.enabled !== undefined) next.enabled = patch.enabled;
      if (patch.subject !== undefined) {
        if (patch.subject.length > 200) throw new InvalidArgumentError("subject is limited to 200 characters.");
        next.subject = patch.subject.trim() || DEFAULT_SUBJECT;
      }
      if (patch.body !== undefined) {
        if (patch.body.length > 4000) throw new InvalidArgumentError("body is limited to 4000 characters.");
        next.body = patch.body.trim();
      }
      if (patch.subjects !== undefined) next.subjects = validateLanguageTexts(patch.subjects, "subjects", 200);
      if (patch.bodies !== undefined) next.bodies = validateLanguageTexts(patch.bodies, "bodies", 4000);
      if (patch.returnDate !== undefined) {
        next.returnDate = validateLine(patch.returnDate, "returnDate", 100);
        const day = next.returnDate && PLAIN_DATE.test(next.returnDate) ? Date.parse(`${next.returnDate}T00:00:00Z`) : undefined;
        if (day !== undefined && (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== next.returnDate)) {
          throw new InvalidArgumentError(`returnDate "${next.returnDate}" is not a real date.`);
        }
      }
      if (patch.backupContact !== undefined) next.backupContact = validateLine(patch.backupContact, "backupContact", 200);
      if (patch.startsAt !== undefined) next.startsAt = parseDate(patch.startsAt, "startsAt");
      if (patch.endsAt !== undefined) next.endsAt = parseDate(patch.endsAt, "endsAt");
      if (patch.replyEveryDays !== undefined) {
        if (!Number.isInteger(patch.replyEveryDays) || patch.replyEveryDays < 1 || patch.replyEveryDays > 90) {
          throw new InvalidArgumentError("replyEveryDays must be a whole number from 1 to 90.");
        }
        next.replyEveryDays = patch.replyEveryDays;
      }
      if (patch.outgoingNote !== undefined) {
        if (patch.outgoingNote.length > 1000) throw new InvalidArgumentError("outgoingNote is limited to 1000 characters.");
        next.outgoingNote = patch.outgoingNote.trim() || undefined;
      }
      if (patch.mode !== undefined) {
        if (patch.mode !== "send" && patch.mode !== "draft") throw new InvalidArgumentError('mode must be "send" or "draft".');
        next.mode = patch.mode;
      }
      if (patch.timezone !== undefined) {
        if (patch.timezone === "") next.timezone = undefined;
        else {
          try {
            new Intl.DateTimeFormat("en-US", { timeZone: patch.timezone });
          } catch {
            throw new InvalidArgumentError(`timezone must be an IANA name such as Europe/Warsaw (got "${patch.timezone}").`);
          }
          next.timezone = patch.timezone;
        }
      }
      if (patch.outsideHours !== undefined) next.outsideHours = validateOutsideHours(patch.outsideHours);
      if (patch.dailyLimit !== undefined) {
        if (!Number.isInteger(patch.dailyLimit) || patch.dailyLimit < 1 || patch.dailyLimit > MAX_DAILY_LIMIT) {
          throw new InvalidArgumentError(`dailyLimit must be a whole number from 1 to ${MAX_DAILY_LIMIT}.`);
        }
        next.dailyLimit = patch.dailyLimit;
      }
      if (patch.skipIfAnswered !== undefined) next.skipIfAnswered = patch.skipIfAnswered;
      if (patch.rules !== undefined) next.rules = validateRules(patch.rules);
      if (next.rules && next.rules.length === 0) next.rules = undefined;
      if (next.startsAt && next.endsAt && Date.parse(next.endsAt) <= Date.parse(next.startsAt)) {
        throw new InvalidArgumentError("endsAt must be after startsAt.");
      }
      const hasText = Boolean(next.body) || Boolean(next.bodies) || Boolean(next.outgoingNote) || Boolean(next.rules?.some((rule) => rule.action !== "skip" && rule.body));
      if (next.enabled && !hasText) {
        throw new InvalidArgumentError("Give a body (the reply), a rule with a body, or an outgoingNote before switching the autoresponder on.");
      }
      if (next.enabled && !before?.enabled) next.activatedAt = new Date(now).toISOString();
      state.rule = next;
      await this.save(state);
      this.cache = { rule: next, loadedAt: Date.now() };
      return next;
    });
  }

  /** What it would do with `emails`, judged as if the rule were on now. Records nothing and sends nothing. */
  async preview(emails: EmailSummary[], ownAddresses: string[], deps: AutoresponderDeps = {}, now = Date.now()): Promise<AutoresponderDecision[]> {
    const state = await this.load();
    if (!state.rule) return [];
    const ordered = [...emails].sort((a, b) => Date.parse(b.internalDate ?? b.date ?? "") - Date.parse(a.internalDate ?? a.date ?? ""));
    const out: AutoresponderDecision[] = [];
    for (const email of ordered) out.push(await decide(email, state, ownAddresses, now, deps, { ignoreActivation: true }));
    return out;
  }

  /**
   * Answers what may be answered among `emails`. A reply or draft is recorded before it is made. A function as
   * `handlers` is the send function (the simple form); an object gives send, draft and the lookups. Returns what
   * happened to each message; a failing send is reported and not retried.
   */
  async process(
    emails: EmailSummary[],
    ownAddresses: string[],
    handlers: ((reply: AutoresponderReply) => Promise<void>) | AutoresponderDeps,
    now = Date.now(),
  ): Promise<{ replied: string[]; drafted: string[]; skipped: Array<{ id: string; reason: AutoresponderSkipReason }>; failed: Array<{ id: string; error: string }> }> {
    const deps: AutoresponderDeps = typeof handlers === "function" ? { send: handlers } : handlers;
    const outcome = {
      replied: [] as string[],
      drafted: [] as string[],
      skipped: [] as Array<{ id: string; reason: AutoresponderSkipReason }>,
      failed: [] as Array<{ id: string; error: string }>,
    };
    // Oldest first, so the daily limit and "once per sender" favour the first message of a burst.
    const ordered = [...emails].sort((a, b) => Date.parse(a.internalDate ?? a.date ?? "") - Date.parse(b.internalDate ?? b.date ?? ""));
    for (const email of ordered) {
      const decision = await this.withLock(async () => {
        const state = await this.loadUnlocked();
        const verdict = await decide(email, state, ownAddresses, now, deps);
        const entry = (partial: Pick<AutoresponderLogEntry, "outcome"> & Partial<AutoresponderLogEntry>): AutoresponderLogEntry => ({
          at: new Date(now).toISOString(),
          messageId: email.messageId,
          id: email.id,
          from: verdict.from,
          subject: email.subject.slice(0, 120),
          rule: verdict.rule,
          ...partial,
        });
        const markHandled = () => {
          if (!email.messageId) return;
          state.handled.push(email.messageId);
          if (state.handled.length > HANDLED_LIMIT) state.handled.splice(0, state.handled.length - HANDLED_LIMIT);
        };
        if (verdict.outcome === "skip") {
          const reason = verdict.reason as AutoresponderSkipReason;
          if (QUIET_SKIPS.has(reason)) return undefined;
          outcome.skipped.push({ id: email.id, reason });
          if (PERMANENT_SKIPS.has(reason)) {
            markHandled();
            state.log = [...(state.log ?? []), entry({ outcome: "skipped", reason })].slice(-LOG_LIMIT);
            await this.save(state);
          }
          return undefined;
        }
        const reply = verdict.reply as AutoresponderReply;
        const today = new Date(now).toISOString().slice(0, 10);
        state.replies[verdict.from] = new Date(now).toISOString();
        markHandled();
        state.daily = { date: today, count: (state.daily.date === today ? state.daily.count : 0) + 1 };
        if (verdict.outcome === "reply") state.sentTotal += 1;
        else state.draftedTotal = (state.draftedTotal ?? 0) + 1;
        state.log = [...(state.log ?? []), entry({ outcome: verdict.outcome === "reply" ? "replied" : "drafted" })].slice(-LOG_LIMIT);
        await this.save(state);
        return { verdict, reply };
      });
      if (!decision) continue;
      const { verdict, reply } = decision;
      try {
        if (verdict.outcome === "reply") {
          if (!deps.send) throw new Error("no way to send");
          await deps.send(reply);
          outcome.replied.push(email.id);
        } else {
          if (!deps.draft) throw new Error("no way to make a draft");
          await deps.draft(reply);
          outcome.drafted.push(email.id);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outcome.failed.push({ id: email.id, error: message });
        this.log.warn("Autoresponder reply could not be made", "AutoresponderService", { id: email.id, error });
        await this.withLock(async () => {
          const state = await this.loadUnlocked();
          const failed: AutoresponderLogEntry = {
            at: new Date(now).toISOString(),
            messageId: email.messageId,
            id: email.id,
            from: verdict.from,
            subject: email.subject.slice(0, 120),
            outcome: "failed",
            reason: message,
            rule: verdict.rule,
          };
          state.log = [...(state.log ?? []), failed].slice(-LOG_LIMIT);
          await this.save(state);
        });
      }
    }
    return outcome;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.storePath), { recursive: true, mode: 0o700 });
    return withFileLock(this.storePath, fn);
  }

  private async load(): Promise<AutoresponderState> {
    return this.loadUnlocked();
  }

  private async loadUnlocked(): Promise<AutoresponderState> {
    try {
      const parsed = JSON.parse(await readFile(this.storePath, "utf8")) as Partial<AutoresponderState>;
      return {
        ...emptyState(),
        ...parsed,
        replies: parsed.replies && typeof parsed.replies === "object" ? parsed.replies : {},
        handled: Array.isArray(parsed.handled) ? parsed.handled.filter((entry): entry is string => typeof entry === "string") : [],
        daily: parsed.daily && typeof parsed.daily.date === "string" ? parsed.daily : { date: "", count: 0 },
        log: Array.isArray(parsed.log) ? parsed.log : [],
      };
    } catch (error) {
      if (isFileNotFound(error)) return emptyState();
      setAsideCorruptStore(this.storePath, error, this.log, "AutoresponderService");
      return emptyState();
    }
  }

  private async save(state: AutoresponderState): Promise<void> {
    await writeFileAtomic(this.storePath, JSON.stringify(state, null, 2));
  }
}
