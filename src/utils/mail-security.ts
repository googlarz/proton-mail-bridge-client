import type { EmailAddress } from "../types/index.js";

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
    found.push(html.slice(start, end).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
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

function matchesInstruction(text: string): string | undefined {
  for (const [pattern, reason] of INSTRUCTION_PATTERNS) if (pattern.test(text)) return reason;
  return undefined;
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

  const instruction = matchesInstruction(visible);
  if (instruction) high.push(`The message ${instruction}.`);

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
  const zeroWidth = (visible.match(ZERO_WIDTH) ?? []).length;
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
  "set_contact",
]);

// Tools that only act for some arguments: apply_rules runs its rules when dryRun is false (it previews otherwise), and the
// batch tools are gated for the actions that destroy.
const DESTRUCTIVE_ACTIONS = new Set(["delete", "trash"]);

/**
 * Whether this call is one the confirmation gate applies to after a high-risk message was read. A preview or a switch-off
 * passes, but only through an argument the tool really declares: an undeclared `dryRun` is ignored by the tool, and honouring
 * it here would let a call skip the gate and still act.
 */
export function isGatedAction(name: string, args: Record<string, unknown>, declared: ReadonlySet<string>): boolean {
  if (name === "apply_rules") return args.dryRun === false;
  if (name === "batch_email_action" || name === "apply_thread_action") {
    return typeof args.action === "string" && DESTRUCTIVE_ACTIONS.has(args.action) && !(declared.has("dryRun") && args.dryRun === true);
  }
  if (!TAINT_GATED_TOOLS.has(name)) return false;
  if (declared.has("dryRun") && args.dryRun === true) return false;
  if (declared.has("enabled") && args.enabled === false) return false;
  if (declared.has("active") && args.active === false) return false;
  return true;
}

const ID_KEYS = ["id", "emailId", "primaryEmailId", "latestEmailId"] as const;
const MAX_SCAN_DEPTH = 7;
const MAX_SCAN_CHARS = 2_000_000;

// Walks a tool result and marks every message-like node (an id and some text: a body, a preview, an attachment's text)
// that reads like an instruction to an AI. The session is tainted by it and the node gets a `risk` note. Only the
// instruction patterns are used here: a list of previews would be too noisy with the weaker signals. Returns whether
// anything was marked.
export function annotateHighRisk(value: unknown, taint: MailTaint, depth = 0): boolean {
  if (depth > MAX_SCAN_DEPTH || value === null || typeof value !== "object") return false;
  let changed = false;
  if (Array.isArray(value)) {
    for (const item of value) if (annotateHighRisk(item, taint, depth + 1)) changed = true;
    return changed;
  }
  const node = value as Record<string, unknown>;
  if (node.risk === undefined) {
    const text = [node.text, node.preview, node.snippet, node.sentence, node.body, node.attachmentText, node.subject].filter((part): part is string => typeof part === "string").join("\n");
    const id = ID_KEYS.map((key) => node[key]).find((candidate): candidate is string => typeof candidate === "string");
    if (id && text) {
      const assessment = assessMail({ subject: typeof node.subject === "string" ? node.subject : undefined, text });
      if (assessment.level === "high") {
        node.risk = assessment;
        taint.mark(id, assessment);
        changed = true;
      }
    }
  }
  for (const [key, child] of Object.entries(node)) if (key !== "risk" && annotateHighRisk(child, taint, depth + 1)) changed = true;
  return changed;
}

/** A tool handler whose results are scanned for mail that tries to steer an AI, wherever that text came from. */
export function withRiskScan<R, T extends { content: unknown[]; structuredContent?: unknown; isError?: boolean }>(
  taint: MailTaint,
  handler: (request: R) => Promise<T>,
): (request: R) => Promise<T> {
  return async (request) => {
    const result = await handler(request);
    if (result.isError) return result;
    let changed = false;
    const content = result.content.map((part) => {
      const item = part as { type?: string; text?: string };
      if (item.type !== "text" || typeof item.text !== "string" || item.text.length > MAX_SCAN_CHARS || !/^[\s]*[{[]/.test(item.text)) return part;
      try {
        const parsed = JSON.parse(item.text) as unknown;
        if (!annotateHighRisk(parsed, taint)) return part;
        changed = true;
        return { ...item, text: JSON.stringify(parsed, null, item.text.includes("\n  ") ? 2 : undefined) };
      } catch {
        return part;
      }
    });
    if (!changed) return result;
    const structured = result.structuredContent;
    if (structured && typeof structured === "object") annotateHighRisk(structured, taint);
    return { ...result, content, ...(structured !== undefined ? { structuredContent: structured } : {}) };
  };
}
