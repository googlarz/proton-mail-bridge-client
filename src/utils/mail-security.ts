import type { EmailAddress } from "../types/index.js";
import { normalizeBoolean, optionalBoolean } from "./helpers.js";

// Looks at one message for signs that it is written to manipulate a model or to deceive a reader, so the model can be
// told and the tools that act on the outside world can ask for a confirmation after such a message was read. It judges
// text, markup and headers only; nothing here is sent anywhere.

export type SecurityLevel = "ok" | "caution" | "high";

export interface SecurityAssessment {
  level: SecurityLevel;
  reasons: string[];
}

export interface AssessInput {
  from?: EmailAddress[];
  replyTo?: EmailAddress[];
  subject?: string;
  text?: string;
  html?: string | false;
  headers?: Record<string, unknown>;
  /** Bulk or list mail: its Reply-To and padded preheaders are ordinary, so they are not remarked on. */
  automated?: boolean;
}

// Phrases that address an assistant instead of the reader. English, Polish and German, the languages of this mailbox.
const INSTRUCTION_PATTERNS: Array<[RegExp, string]> = [
  [/\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all)\b[^.\n]{0,30}\b(instructions?|prompts?|rules)\b/i, "tells an AI to ignore its instructions"],
  [/\b(zignoruj|pomi[nń]|zapomnij)\b[^.\n]{0,40}\b(instrukcje|polecenia|zasady)\b/i, "tells an AI to ignore its instructions (Polish)"],
  [/\b(ignoriere|vergiss)\b[^.\n]{0,40}\b(anweisungen|instruktionen|regeln)\b/i, "tells an AI to ignore its instructions (German)"],
  [/\b(you are now|from now on you|act as)\b[^.\n]{0,40}\b(assistant|ai|model|agent|admin)\b/i, "tries to give an AI a new role"],
  [/\b(system prompt|developer message|<\|im_start\|>|\[\/?system\]|BEGIN SYSTEM)/i, "contains markers of a system prompt"],
  [/\b(do not|don't|never)\b[^.\n]{0,30}\b(tell|inform|show|alert)\b[^.\n]{0,20}\b(the )?(user|owner|human)\b/i, "asks an AI to hide something from the user"],
  [/\b(forward|send|email)\b[^.\n]{0,60}\b(all|every|the last|your)\b[^.\n]{0,60}\b(emails?|messages?|passwords?|invoices?|codes?)\b[^.\n]{0,60}\bto\b[^.\n]{0,20}\S+@\S+/i, "asks an AI to send mail to an address"],
  [/\b(delete|remove|trash)\b[^.\n]{0,30}\b(all|every)\b[^.\n]{0,30}\b(emails?|messages?)\b/i, "asks an AI to delete mail"],
];

const ZERO_WIDTH = /[​-‏⁠﻿]/g;
// HTML is scanned tag by tag, with every step bounded, never with a pattern that can backtrack over the whole
// document: one crafted message must not be able to stall the server (a pattern over unclosed <a tags took seconds).
const MAX_HTML_SCANNED = 200_000;
const MAX_TAG_LENGTH = 1_500;
const MAX_BLOCK_LENGTH = 5_000;
const MAX_HIDDEN_BLOCKS = 50;
const MAX_ANCHORS = 300;
const HIDING_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px|pt|em|rem|%)?(?![\d.])|opacity\s*:\s*0(?:\.0+)?(?![\d.])|(?:left|top|text-indent|margin-left)\s*:\s*-\d{3,}|max-height\s*:\s*0(?:px)?(?![\d.])/i;
const WHITE_ON_WHITE = /(?:^|[;\s])color\s*:\s*(?:#fff(?:fff)?|white)\b[\s\S]{0,300}?background(?:-color)?\s*:\s*(?:#fff(?:fff)?|white)\b/i;
const VOID_TAGS = new Set(["img", "br", "hr", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"]);

function styleOf(attributes: string): string {
  const match = /style\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes);
  return match?.[1] ?? match?.[2] ?? "";
}

/** The text inside elements a reader cannot see (hidden by style or the hidden attribute). */
function hiddenTexts(html: string): string[] {
  const lower = html.toLowerCase();
  const found: string[] = [];
  for (const tag of html.matchAll(new RegExp(`<([a-z][a-z0-9]*)(\\s[^<>]{0,${MAX_TAG_LENGTH}})?>`, "gi"))) {
    if (found.length >= MAX_HIDDEN_BLOCKS) break;
    const name = tag[1].toLowerCase();
    const attributes = tag[2] ?? "";
    if (VOID_TAGS.has(name) || !attributes) continue;
    const style = styleOf(attributes);
    const hides = HIDING_STYLE.test(style) || WHITE_ON_WHITE.test(style) || /(?:^|\s)hidden(?:\s|=|$)/i.test(attributes);
    if (!hides) continue;
    const start = (tag.index ?? 0) + tag[0].length;
    const close = lower.indexOf(`</${name}`, start);
    const end = close === -1 ? Math.min(html.length, start + MAX_BLOCK_LENGTH) : Math.min(close, start + MAX_BLOCK_LENGTH);
    found.push(html.slice(start, end).replace(/<[^>]*>/g, " ").replace(/[ \t\n\r\f]+/g, " ").trim());
  }
  return found;
}

/** The first link whose visible text names another host than the one it goes to. */
function mismatchedLink(html: string): { shown: string; real: string } | undefined {
  const lower = html.toLowerCase();
  let seen = 0;
  for (const tag of html.matchAll(new RegExp(`<a\\s([^<>]{0,${MAX_TAG_LENGTH}})>`, "gi"))) {
    if (++seen > MAX_ANCHORS) break;
    const href = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag[1]);
    const target = href?.[1] ?? href?.[2];
    if (!target) continue;
    const start = (tag.index ?? 0) + tag[0].length;
    const close = lower.indexOf("</a", start);
    const text = html.slice(start, close === -1 ? start + 500 : Math.min(close, start + 500)).replace(/<[^>]*>/g, "").trim();
    const shownHost = text.match(/^(?:https?:\/\/)?([\w.-]+\.[a-z]{2,})(?:[/\s]|$)/i)?.[1]?.toLowerCase();
    const realHost = hostOf(target);
    if (shownHost && realHost && baseDomain(shownHost) !== baseDomain(realHost)) return { shown: shownHost, real: realHost };
  }
  return undefined;
}

function domainOf(address: string | undefined): string {
  return (address?.split("@")[1] ?? "").trim().toLowerCase();
}

// The last two labels: enough to tell mail.example.com from example.org without a public-suffix list.
function baseDomain(domain: string): string {
  return domain.split(".").slice(-2).join(".");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// Control and invisible characters that padding or splitting a word can use to slip past a pattern.
const HIDDEN_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g;
const NEEDS_NORMALISING = /[^\t\n\r\x20-\x7e]/;
const SPACE_RUN = /[ \t]{2,}/g;
const normalised = (text: string): string => text.normalize("NFKC").replace(/[ \t]{2,}/g, " ");

// The text with the hidden characters taken out and with them turned into spaces, each in NFKC form: a word split by one
// reads whole in the first, two words run together by one stay apart in the second, and look-alike forms (fullwidth
// letters, no-break spaces) read as plain ones, and runs of spaces count as one. Plain text with single spaces is matched as it is. Only the
// instruction patterns run on these, and they are bounded, so the cost stays linear.
function normalisedVariants(text: string): string[] {
  // Plain printable ASCII has no hidden characters and nothing for NFKC to change: only a run of spaces can differ.
  if (!NEEDS_NORMALISING.test(text)) return [text.includes("  ") || text.includes("\t") ? text.replace(SPACE_RUN, " ") : text];
  const variants = new Set([normalised(text), normalised(text.replace(HIDDEN_CHARS, "")), normalised(text.replace(HIDDEN_CHARS, " "))]);
  return [...variants];
}

function matchesInstruction(text: string): string | undefined {
  for (const variant of normalisedVariants(text)) {
    for (const [pattern, reason] of INSTRUCTION_PATTERNS) if (pattern.test(variant)) return reason;
  }
  return undefined;
}

// Adversarial text with hiding characters costs up to about 1.3 ms per KB (normalisation variants times patterns), so one
// text is not matched whole past MAX_WHOLE_TEXT: its two ends and a few evenly spaced windows between them are, each
// normalised on its own, and the assessment says it was only partly read.
const MAX_WHOLE_TEXT = 512_000;
const END_WINDOW = 48_000;
const MIDDLE_WINDOWS = 8;
const MIDDLE_WINDOW = 12_000;

function matchesInstructionBounded(text: string): { reason?: string; partial: boolean } {
  if (text.length <= MAX_WHOLE_TEXT) return { reason: matchesInstruction(text), partial: false };
  const span = text.length - 2 * END_WINDOW;
  const windows = [text.slice(0, END_WINDOW), text.slice(-END_WINDOW)];
  for (let i = 0; i < MIDDLE_WINDOWS; i += 1) {
    const start = END_WINDOW + Math.floor(((i + 0.5) * span) / MIDDLE_WINDOWS) - MIDDLE_WINDOW / 2;
    windows.push(text.slice(start, start + MIDDLE_WINDOW));
  }
  for (const window of windows) {
    const reason = matchesInstruction(window);
    if (reason) return { reason, partial: true };
  }
  return { partial: true };
}

function headerText(headers: Record<string, unknown> | undefined, name: string): string {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(" ");
  return typeof value === "string" ? value : "";
}

export function assessMail(input: AssessInput): SecurityAssessment {
  const high: string[] = [];
  const caution: string[] = [];
  const visible = `${input.subject ?? ""}\n${input.text ?? ""}`;

  const { reason: instruction, partial } = matchesInstructionBounded(visible);
  if (instruction) high.push(`The message ${instruction}.`);
  // Same fail-closed wording as the result scan: text that was not read in full may hide an instruction.
  else if (partial) high.push(`oversized-unscanned: this message is ${visible.length} characters long, so only parts of it were checked for instructions to an AI (partially assessed).`);

  const html = typeof input.html === "string" ? input.html.slice(0, MAX_HTML_SCANNED) : "";
  let hiddenSeen = false;
  for (const hidden of hiddenTexts(html)) {
    if (hidden.length < 20) continue;
    const hiddenInstruction = matchesInstruction(hidden);
    if (hiddenInstruction) {
      high.push(`Hidden text in the message ${hiddenInstruction}.`);
      break;
    }
    hiddenSeen = true;
  }
  if (hiddenSeen && high.length === 0) caution.push("The message has text the reader cannot see (hidden by its markup).");
  let zeroWidth = 0;
  for (const _ of visible.matchAll(ZERO_WIDTH)) if (++zeroWidth >= 5) break;
  if (zeroWidth >= 5 && input.automated !== true) caution.push("The text has invisible characters (zero-width), which can hide wording from the reader.");

  const fromAddress = input.from?.[0]?.address;
  const fromDomain = domainOf(fromAddress);
  const replyDomain = domainOf(input.replyTo?.[0]?.address);
  if (input.automated !== true && fromDomain && replyDomain && baseDomain(fromDomain) !== baseDomain(replyDomain)) {
    caution.push(`Replies go to ${replyDomain}, not to the sender's domain ${fromDomain}.`);
  }
  const shownName = input.from?.[0]?.name ?? "";
  const nameAddress = shownName.match(/[\w.+-]+@([\w.-]+\.[a-z]{2,})/i);
  if (nameAddress && fromDomain && baseDomain(nameAddress[1].toLowerCase()) !== baseDomain(fromDomain)) {
    caution.push(`The sender's name shows ${nameAddress[0]}, but the mail comes from ${fromDomain}.`);
  }
  if (fromDomain.split(".").some((label) => label.startsWith("xn--"))) caution.push("The sender's domain uses look-alike (punycode) characters.");

  const auth = headerText(input.headers, "authentication-results").toLowerCase();
  if (/\b(dkim|spf|dmarc)=fail\b/.test(auth)) caution.push("The sender failed an authentication check (SPF, DKIM or DMARC).");

  const link = mismatchedLink(html);
  if (link) caution.push(`A link reads ${link.shown} but goes to ${link.real}.`);

  const reasons = [...high, ...caution];
  return { level: high.length ? "high" : caution.length ? "caution" : "ok", reasons };
}

// What was read in this server's session: after a high-risk message the tools that reach outside (send, forward,
// delete, rules) ask for an explicit confirmation, whatever the confirmation setting says.
export class MailTaint {
  private last: { emailId: string; reasons: string[] } | undefined;

  mark(emailId: string, assessment: SecurityAssessment): void {
    if (assessment.level === "high") this.last = { emailId, reasons: assessment.reasons };
  }

  current(): { emailId: string; reasons: string[] } | undefined {
    return this.last;
  }
}

// Tools that send mail or change what happens to it without a person looking at each case.
export const TAINT_GATED_TOOLS = new Set([
  "send_email", "reply_to_email", "reply_all_email", "forward_email", "send_draft", "schedule_draft", "respond_to_invite",
  "unsubscribe_sender", "delete_email", "delete_thread", "bulk_delete", "empty_folder", "delete_folder", "set_rule", "set_autoresponder",
  // A vip tag changes the autoresponder text for that sender.
  "set_contact", "import_contacts",
]);

// Tools that only act for some arguments: apply_rules runs its rules when dryRun is false (it previews otherwise), and the
// batch tools are gated for the actions that destroy.
const DESTRUCTIVE_ACTIONS = new Set(["delete", "trash"]);

/**
 * Whether this call is one the confirmation gate applies to after a high-risk message was read. A preview or a switch-off
 * passes, but only through an argument the tool really declares: an undeclared `dryRun` is ignored by the tool, and honouring
 * it here would let a call skip the gate and still act. Each flag is read with the parser the handlers use (so "false",
 * "no", 0 and " FALSE " mean what they mean there), and the action is trimmed the way requireString trims it.
 */
export function isGatedAction(name: string, args: Record<string, unknown>, declared: ReadonlySet<string>): boolean {
  if (name === "apply_rules") return normalizeBoolean(args.dryRun, true) === false;
  if (name === "batch_email_action" || name === "apply_thread_action") {
    return typeof args.action === "string" && DESTRUCTIVE_ACTIONS.has(args.action.trim()) && !(declared.has("dryRun") && normalizeBoolean(args.dryRun, false));
  }
  if (!TAINT_GATED_TOOLS.has(name)) return false;
  if (declared.has("dryRun") && normalizeBoolean(args.dryRun, false)) return false;
  if (declared.has("enabled") && optionalBoolean(args.enabled) === false) return false;
  if (declared.has("active") && optionalBoolean(args.active) === false) return false;
  return true;
}

const ID_KEYS = ["id", "emailId", "primaryEmailId", "latestEmailId"] as const;
const MAX_SCAN_DEPTH = 7;
// A result is walked in full: every string in it is text to check, one node at a time (a list of ordinary previews is
// many small scans, not one big one). The work is capped two ways, so padding cannot buy a stall: a total of characters
// and a wall-clock deadline. Whatever the cap left unchecked taints the session ("oversized-unscanned") with the count in
// the reason, rather than the result passing unchecked. Clean text costs about 8 ms per MB, adversarial text up to about
// 0.3 s per MB per normalisation variant, so the deadline, not the character budget, is the CPU bound.
const SCAN_BUDGET = 24_000_000;
const SCAN_DEADLINE_MS = 1_000;
const SCAN_CHUNK = 32_768;
const SCAN_OVERLAP = 512;
// How much of the end of one node and the start of the next is read together, for an instruction split between them.
const SEAM = 250;
const MAX_FLAT_NODES = 1_000_000;
// Where the walk does not parse: a result that is not JSON or is too large to parse keeps a head and a tail window.
const MAX_SCAN_CHARS = 2_000_000;
const MAX_PARSE_CHARS = 32_000_000;
const SCAN_WINDOW = 100_000;
// Fields the server fills itself (ids, dates, counts, hashes). Skipped only while short and only if the value looks like what the
// key promises: a header-derived string (a Message-ID, a Date header, a Content-Type with parameters, a name used as an id) is text.
const DATE_KEYS = ["date", "receivedAt", "sentAt", "internalDate", "createdAt", "updatedAt", "expiresAt"];
const TOKEN_KEYS = [...ID_KEYS, "uid", "uids", "flags", "count", "total", "size", "hash", "sha256", "checksum", "account"];
const TOKEN_VALUE = /^[\w.:@<>+=~%/!$*\\-]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const RFC_DATE = /^(?:[A-Za-z]{3}, )?\d{1,2} [A-Za-z]{3} \d{2,4} \d{2}:\d{2}(?::\d{2})?(?: (?:[+-]\d{4}|[A-Z]{1,5}))?$/;
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const MACHINE_VALUE: Record<string, (value: string) => boolean> = {
  ...Object.fromEntries(TOKEN_KEYS.map((key) => [key, (value: string) => TOKEN_VALUE.test(value)])),
  ...Object.fromEntries(DATE_KEYS.map((key) => [key, (value: string) => ISO_DATE.test(value) || RFC_DATE.test(value)])),
  mimeType: (value) => MIME_TYPE.test(value),
};
const MACHINE_VALUE_MAX = 128;
const UNIDENTIFIED = "unidentified-result";
// Notes this module put on nodes, so a `risk` key that came with the data is never mistaken for one.
const RISK_NOTES = new WeakSet<object>();

type Node = Record<string, unknown>;
interface ScanContext {
  budget: number;
  deadline: number;
  unscanned: number;
  flatNodes: number;
  cut: boolean;
  firstShort?: { holder: Node | undefined; ownerId: string | undefined };
  orphan?: SecurityAssessment;
}
const newContext = (deadline: number): ScanContext => ({ budget: SCAN_BUDGET, deadline, unscanned: 0, flatNodes: 0, cut: false });

// Long runs of white space and invisible characters are cut to eight, so padding between two words cannot push them into
// different chunks; the variants in matchesInstruction read a shortened run the same way as the full one.

const PADDING_RUN = new RegExp(`[\\s${HIDDEN_CHARS.source.slice(1, -1)}]{9,}`, "g");

/** The first instruction pattern found in the text, reading it chunk by chunk within the context's budget and deadline. */
function scanText(text: string, ctx: ScanContext): string | undefined {
  const rest = text.length > SCAN_CHUNK ? text.replace(PADDING_RUN, (run) => run.slice(0, 8)) : text;
  for (let start = 0; start < rest.length; start += SCAN_CHUNK - SCAN_OVERLAP) {
    const piece = rest.slice(start, start + SCAN_CHUNK);
    if (piece.length > ctx.budget || performance.now() > ctx.deadline) {
      ctx.unscanned += rest.length - start;
      return undefined;
    }
    ctx.budget -= piece.length;
    const hit = matchesInstruction(piece);
    if (hit) return hit;
    if (start + SCAN_CHUNK >= rest.length) break;
  }
  return undefined;
}

// A key that is a field name is short and has no spaces; a longer one (or one with spaces) can carry text, so it is read as text.
const isTextKey = (key: string): boolean => key.length > 24 || /\s/.test(key);
const idOf = (node: Node): string | undefined => ID_KEYS.map((key) => node[key]).find((candidate): candidate is string => typeof candidate === "string");
const isMachineField = (key: string | undefined, value: string): boolean =>
  key !== undefined && Object.hasOwn(MACHINE_VALUE, key) && value.length <= MACHINE_VALUE_MAX && MACHINE_VALUE[key](value);
const isNote = (value: unknown): boolean => typeof value === "object" && value !== null && RISK_NOTES.has(value);

function flag(target: Node | undefined, assessment: SecurityAssessment, taint: MailTaint, ctx: ScanContext, ownerId: string | undefined): void {
  taint.mark(ownerId ?? UNIDENTIFIED, assessment);
  if (!target) {
    ctx.orphan ??= assessment;
    return;
  }
  if (isNote(target.risk)) return;
  RISK_NOTES.add(assessment);
  target.risk = assessment;
}

const instructionNote = (reason: string): SecurityAssessment => ({ level: "high", reasons: [`The message ${reason}.`] });

/** Runs a scan and remembers the first node it ran short on, so the final note lands on a node of the result. */
function check(text: string, ctx: ScanContext, holder: Node | undefined, ownerId: string | undefined): string | undefined {
  const before = ctx.unscanned;
  const hit = scanText(text, ctx);
  if (!hit && ctx.unscanned > before) ctx.firstShort ??= { holder, ownerId };
  return hit;
}

interface Visited {
  text: string;
  changed: boolean;
  flagged: boolean;
}

function visitChild(value: object, depth: number, holder: Node | undefined, ctx: ScanContext, taint: MailTaint, ownerId: string | undefined): Visited {
  if (depth > MAX_SCAN_DEPTH) return { text: "", changed: scanDeep(value, Array.isArray(value) ? holder : (value as Node), ctx, taint, ownerId), flagged: false };
  return Array.isArray(value) ? visitArray(value, depth, holder, ctx, taint, ownerId) : visitNode(value as Node, depth, ctx, taint, ownerId);
}

function visitNode(node: Node, depth: number, ctx: ScanContext, taint: MailTaint, outerId: string | undefined): Visited {
  const id = idOf(node) ?? outerId;
  const fields: string[] = [];
  const entries = Object.entries(node);
  for (const [key, value] of entries) {
    if (isTextKey(key)) fields.push(key);
    if (typeof value === "string" && !isMachineField(key, value)) fields.push(value);
  }
  const text = fields.join(" ");
  let changed = false;
  let flagged = false;
  if (text) {
    const hit = check(text, ctx, node, id);
    if (hit) {
      flag(node, instructionNote(hit), taint, ctx, id);
      changed = flagged = true;
    }
  }
  for (const [key, child] of entries) {
    if (child === null || typeof child !== "object" || (key === "risk" && isNote(child))) continue;
    if (visitChild(child, depth + 1, node, ctx, taint, id).changed) changed = true;
  }
  return { text, changed, flagged };
}

function visitArray(items: unknown[], depth: number, holder: Node | undefined, ctx: ScanContext, taint: MailTaint, ownerId: string | undefined): Visited {
  let changed = false;
  const strings: string[] = [];
  let prev: Visited | undefined;
  for (const item of items) {
    if (typeof item === "string") {
      strings.push(item);
      continue;
    }
    if (item === null || typeof item !== "object") continue;
    const visited = visitChild(item, depth + 1, holder, ctx, taint, ownerId);
    if (visited.changed) changed = true;
    if (Array.isArray(item) || !visited.text) continue;
    // Two neighbours that each read harmlessly can carry one instruction between them.
    if (prev && !prev.flagged && !visited.flagged) {
      const node = item as Node;
      const id = idOf(node) ?? ownerId;
      const hit = check(`${prev.text.slice(-SEAM)} ${visited.text.slice(0, SEAM)}`, ctx, node, id);
      if (hit) {
        flag(node, instructionNote(hit), taint, ctx, id);
        changed = visited.flagged = true;
      }
    }
    prev = visited;
  }
  if (strings.length > 0) {
    const hit = check(strings.join(" "), ctx, holder, ownerId);
    if (hit) {
      flag(holder, instructionNote(hit), taint, ctx, ownerId);
      changed = true;
    }
  }
  return { text: "", changed, flagged: false };
}

// Below the depth the recursive walk goes to, the same content is read by an explicit-stack walk (no recursion to exhaust):
// strings in document order, joined by a space, so deep nesting hides no text and a long chain cannot overflow the stack.
function scanDeep(root: object, target: Node | undefined, ctx: ScanContext, taint: MailTaint, ownerId: string | undefined): boolean {
  const stack: Array<[unknown, string | undefined]> = [[root, undefined]];
  let parts: string[] = [];
  let length = 0;
  let hit: string | undefined;
  const flush = (): void => {
    const joined = parts.join(" ");
    hit = check(joined, ctx, target, ownerId);
    const carry = joined.slice(-SEAM);
    parts = carry ? [carry] : [];
    length = carry.length;
  };
  while (stack.length > 0 && !hit) {
    const [value, key] = stack.pop() as [unknown, string | undefined];
    if (++ctx.flatNodes > MAX_FLAT_NODES) {
      ctx.cut = true;
      ctx.firstShort ??= { holder: target, ownerId };
      break;
    }
    if (typeof value === "string") {
      if (isMachineField(key, value)) continue;
      parts.push(value);
      length += value.length + 1;
      if (length >= SCAN_CHUNK) flush();
    } else if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) stack.push([value[i], key]);
    } else if (value !== null && typeof value === "object") {
      const entries = Object.entries(value);
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i][0] === "risk" && isNote(entries[i][1])) continue;
        stack.push([entries[i][1], entries[i][0]]);
        if (isTextKey(entries[i][0])) stack.push([entries[i][0], undefined]);
      }
    }
  }
  if (!hit && parts.length > 0) flush();
  if (!hit) return false;
  flag(target, instructionNote(hit), taint, ctx, ownerId);
  return true;
}

function unscannedNote(ctx: ScanContext): SecurityAssessment {
  const reasons: string[] = [];
  if (ctx.unscanned > 0) reasons.push(`oversized-unscanned: about ${ctx.unscanned} characters of this result were not checked for instructions to an AI (the scan limit was reached).`);
  if (ctx.cut) reasons.push(`unscanned-depth: content nested more than ${MAX_SCAN_DEPTH} levels deep was too large to check for instructions to an AI.`);
  return { level: "high", reasons };
}

// Walks a tool result and marks every node whose text reads like an instruction to an AI: any string value except the
// server's own machine fields, a node's fields read together (an instruction can be split across them) and neighbouring
// nodes read across their seam. The session is tainted by it and the node gets a `risk` note. Only the instruction
// patterns are used here: a list of previews would be too noisy with the weaker signals.
function annotateWith(value: unknown, taint: MailTaint, ctx: ScanContext): { changed: boolean; orphan?: SecurityAssessment } {
  let changed = false;
  if (value !== null && typeof value === "object") changed = visitChild(value, 0, undefined, ctx, taint, undefined).changed;
  if (ctx.unscanned > 0 || ctx.cut) {
    flag(ctx.firstShort?.holder, unscannedNote(ctx), taint, ctx, ctx.firstShort?.ownerId);
    changed = true;
  }
  return { changed, orphan: ctx.orphan };
}

/** Marks the nodes of a result that read like an instruction to an AI. Returns whether anything was marked. */
export function annotateHighRisk(value: unknown, taint: MailTaint): boolean {
  return annotateWith(value, taint, newContext(performance.now() + SCAN_DEADLINE_MS)).changed;
}

/** A text that is not walked as JSON: read as plain text, or (past the scan size) by its two ends, and said so. */
function scanPlain(text: string, taint: MailTaint, deadline: number): SecurityAssessment | undefined {
  if (text.length > MAX_SCAN_CHARS) {
    // Not walked, so look at both ends and say so rather than let it pass.
    const ends = text.length > 2 * SCAN_WINDOW ? `${text.slice(0, SCAN_WINDOW)}\n${text.slice(-SCAN_WINDOW)}` : text;
    const assessment = assessMail({ text: ends });
    const flagged: SecurityAssessment = assessment.level === "high"
      ? assessment
      : { level: "high", reasons: [`oversized-unscanned: ${Math.max(0, text.length - 2 * SCAN_WINDOW)} characters of this result could not be read as JSON and were not checked for instructions to an AI.`] };
    taint.mark("oversized-unscanned", flagged);
    return flagged;
  }
  const ctx = newContext(deadline);
  const hit = scanText(text, ctx);
  const note = hit ? instructionNote(hit) : ctx.unscanned > 0 ? unscannedNote(ctx) : undefined;
  if (note) taint.mark(UNIDENTIFIED, note);
  return note;
}

const riskPart = (risk: SecurityAssessment) => ({ type: "text", text: JSON.stringify({ risk }) });

// The text of a resource part (a string, or a base64 blob read as UTF-8); a blob too big to decode here is reported unread.
function resourceText(part: { resource?: { text?: unknown; blob?: unknown } }): string | undefined {
  const { text, blob } = part.resource ?? {};
  if (typeof text === "string") return text;
  if (typeof blob !== "string") return undefined;
  if (blob.length > MAX_SCAN_CHARS * 2) return "\u0000".repeat(MAX_SCAN_CHARS + 1);
  return Buffer.from(blob, "base64").toString("utf8");
}

function alreadyRead(structured: object, readClean: Array<{ text: string; indent: number | undefined }>): boolean {
  try {
    return readClean.some(({ text, indent }) => JSON.stringify(structured, null, indent) === text);
  } catch {
    return false;
  }
}

/** A tool handler whose results are scanned for mail that tries to steer an AI, wherever that text came from. */
export function withRiskScan<R, T extends { content: unknown[]; structuredContent?: unknown; isError?: boolean }>(
  taint: MailTaint,
  handler: (request: R) => Promise<T>,
): (request: R) => Promise<T> {
  return async (request) => {
    const result = await handler(request);
    if (result.isError) return result;
    const deadline = performance.now() + SCAN_DEADLINE_MS;
    let changed = false;
    // Text parts read as JSON and found clean: a structuredContent that writes out to the same text was read with them.
    const readClean: Array<{ text: string; indent: number | undefined }> = [];
    const content = result.content.flatMap((part): unknown[] => {
      const item = part as { type?: string; text?: string; resource?: { text?: unknown; blob?: unknown } };
      if (item.type === "resource") {
        const text = resourceText(item);
        const note = text === undefined ? undefined : scanPlain(text, taint, deadline);
        if (!note) return [part];
        changed = true;
        return [part, riskPart(note)];
      }
      if (item.type !== "text" || typeof item.text !== "string") return [part];
      if (/^[\s]*[{[]/.test(item.text) && item.text.length <= MAX_PARSE_CHARS) {
        try {
          const parsed = JSON.parse(item.text) as unknown;
          const scanned = annotateWith(parsed, taint, newContext(deadline));
          if (!scanned.changed) {
            readClean.push({ text: item.text, indent: item.text.includes("\n  ") ? 2 : undefined });
            return [part];
          }
          const rewritten = { ...item, text: JSON.stringify(parsed, null, item.text.includes("\n  ") ? 2 : undefined) };
          changed = true;
          return scanned.orphan ? [rewritten, riskPart(scanned.orphan)] : [rewritten];
        } catch {
          // Not JSON, or too deep to write back: read as plain text below (the session is already tainted if it matters).
        }
      }
      const note = scanPlain(item.text, taint, deadline);
      if (!note) return [part];
      changed = true;
      return [part, riskPart(note)];
    });
    const structured = result.structuredContent;
    if (structured && typeof structured === "object" && (changed || !alreadyRead(structured, readClean)) && annotateWith(structured, taint, newContext(deadline)).changed) changed = true;
    if (!changed) return result;
    return { ...result, content, ...(structured !== undefined ? { structuredContent: structured } : {}) };
  };
}
