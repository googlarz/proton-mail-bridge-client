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
const HIDDEN_STYLE = /<([a-z0-9]+)\b[^>]*style\s*=\s*"[^"]*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px|pt|em)?\b|opacity\s*:\s*0(?:\.0+)?\b|color\s*:\s*(?:#fff(?:fff)?|white)\b[^"]*background[^"]*(?:#fff(?:fff)?|white))[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi;

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

  const html = typeof input.html === "string" ? input.html : "";
  for (const match of html.matchAll(HIDDEN_STYLE)) {
    const hidden = (match[2] ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (hidden.length < 20) continue;
    const hiddenInstruction = matchesInstruction(hidden);
    if (hiddenInstruction) high.push(`Hidden text in the message ${hiddenInstruction}.`);
    else caution.push("The message has text the reader cannot see (hidden by its markup).");
    break;
  }
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

  for (const link of html.matchAll(/<a\b[^>]*href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const shown = link[2].replace(/<[^>]*>/g, "").trim();
    const shownHost = shown.match(/^(?:https?:\/\/)?([\w.-]+\.[a-z]{2,})(?:[/\s]|$)/i)?.[1]?.toLowerCase();
    const realHost = hostOf(link[1]);
    if (shownHost && realHost && baseDomain(shownHost) !== baseDomain(realHost)) {
      caution.push(`A link reads ${shownHost} but goes to ${realHost}.`);
      break;
    }
  }

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
  "unsubscribe_sender", "delete_email", "delete_thread", "bulk_delete", "empty_folder", "set_rule", "set_autoresponder",
]);
