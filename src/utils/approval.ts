// Real human approval. `confirmed: true` is an argument, so the model can set it itself (a persuaded model, a message that
// says "pass confirmed"). With PROTONMAIL_APPROVAL=elicit|require the SERVER asks the person through the client (MCP
// elicitation) and only their answer counts. The question is built here from what the server knows or will act on (the
// account, the tool, the recipients the mail will really go to - a reply's found the way the reply tool finds them, Reply-To
// included - a stored draft, a plan, the call's own arguments), never from text the model wrote about the action, and every
// piece of mail text in it is stripped of control and bidi characters and cut short. What is stored (a draft, a plan) is
// bound to the answer: the handler refuses to act if it is no longer what the person was shown.

import { createHash } from "node:crypto";
import { basename } from "node:path";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { FORWARD_DAILY_LIMIT, type EffectiveRule } from "../services/rules-service.js";
import type { AutoresponderRule } from "../services/autoresponder-service.js";
import { normalizeBoolean } from "./helpers.js";
import { isGatedAction } from "./mail-security.js";

export type ApprovalMode = "off" | "elicit" | "require";

export const DEFAULT_APPROVAL_TIMEOUT_SECONDS = 120;

export function parseApprovalEnv(name: string): ApprovalMode {
  const raw = process.env[name]?.trim().toLowerCase();
  // An unfilled "${user_config.approval}" from a host that did not substitute it is "not set", not a typo to fail on.
  if (!raw || raw.startsWith("${")) return "off";
  if (raw === "off" || raw === "elicit" || raw === "require") return raw;
  throw new Error(`${name} must be one of: off, elicit, require (got "${raw}").`);
}

// confirmed-gated tools that the taint gate does not list.
const ALSO_APPROVED = new Set(["approve_plan", "send_test_email", "delete_draft", "delete_template", "delete_label"]);
const FLAG_TOOLS = new Set(["update_message_flags", "bulk_update_flags", "flag_thread"]);

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : typeof value === "string" && value ? [value] : []);

/** Whether this call is one a person must approve: what the confirmation gate asks `confirmed` for, plus approve_plan. */
export function needsApproval(name: string, args: Record<string, unknown>, declared: ReadonlySet<string>): boolean {
  if (ALSO_APPROVED.has(name)) return true;
  if (FLAG_TOOLS.has(name)) return strings(args.flagsToAdd).some((flag) => flag.toLowerCase() === "\\deleted");
  if (!isGatedAction(name, args, declared)) return false;
  // A rule only sends mail when it forwards. With actions given they decide; without, they come from a proposal or the stored rule.
  if (name === "set_rule" && isRecord(args.actions)) return strings(args.actions.forwardTo).length > 0;
  return true;
}

/** Mail text on one line, without control, format (bidi, zero-width) or line-separator characters, cut to `max` characters. */
export function cleanForPrompt(value: unknown, max = 120): string {
  const text = String(value ?? "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim();
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

const quoted = (value: unknown, max?: number) => JSON.stringify(cleanForPrompt(value, max));
const addressSet = (values: string[]) => [...new Set(values.map((value) => value.trim().toLowerCase()))].sort().join("\n");
function listed(values: string[], max = 5): string {
  const shown = values.slice(0, max).map((value) => quoted(value, 80));
  return shown.join(", ") + (values.length > max ? ` and ${values.length - max} more` : "");
}

/** Everything of a stored draft that goes out when it is sent. */
export interface DigestableDraft {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  isHtml?: boolean;
  priority?: string;
  replyTo?: string;
  from?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: Array<{ filename: string; content: string; contentType?: string; cid?: string; contentDisposition?: string }>;
}

export interface PlanItemForApproval {
  n: number;
  action: string;
  subject: string;
  emailId?: string;
  target?: string;
}

/** Who a reply or a forward really goes to, found the way the tool finds them; `from` and `replyTo` are the original message's. */
export interface SendTarget {
  to: string[];
  cc: string[];
  bcc: string[];
  from?: string[];
  replyTo?: string[];
}

export interface ApprovalLookups {
  account(args: Record<string, unknown>): string;
  subject(id: string): Promise<string | undefined>;
  target(name: string, args: Record<string, unknown>): Promise<SendTarget | undefined>;
  /** How many cards the vCard file holds and a digest of its text. */
  vcard(path: string): Promise<{ cards: number; digest: string } | undefined>;
  draft(id: string): Promise<DigestableDraft | undefined>;
  plan(planId: string, args: Record<string, unknown>): Promise<PlanItemForApproval[] | undefined>;
  /** The automatic reply as it would be after the call: the stored one with the call's changes applied. */
  autoresponder(args: Record<string, unknown>): Promise<AutoresponderRule | undefined>;
  /** The rule set_rule would store, and where it comes from (a proposal, a stored rule, or the call itself). */
  rule(args: Record<string, unknown>): Promise<{ effective: EffectiveRule; from?: { kind: "proposal" | "existing rule"; id: string } } | undefined>;
  /** What a real apply_rules would touch, counted per rule by a dry run of the planning step. */
  applyPlan(args: Record<string, unknown>): Promise<{ rules: Array<{ name: string; actions: unknown; matches: number }>; total: number; limit: number } | undefined>;
  /** Messages in the folder that match the call's filter, from the local index; no count when the index has nothing for the folder. */
  matches(name: string, args: Record<string, unknown>): Promise<{ count?: number; subjects: string[] } | undefined>;
  unsubscribe(emailId: string): Promise<{ mailto?: string; host?: string } | undefined>;
  invite(emailId: string): Promise<{ organizer?: string; summary?: string } | undefined>;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
/** A digest of a file's text that the question counted (a vCard file to import). */
export const contentDigest = sha256;

/** A digest of the content of a draft that is sent, scheduled or deleted: the question and the handler compute it the same way. */
export function draftApprovalDigest(draft: DigestableDraft): string {
  return sha256(JSON.stringify([
    draft.to, draft.cc, draft.bcc, draft.subject, draft.body, Boolean(draft.isHtml), draft.priority ?? null, draft.replyTo ?? null, draft.from ?? null,
    draft.inReplyTo ?? null, draft.references ?? [],
    (draft.attachments ?? []).map((file) => [file.filename, file.contentType ?? null, file.cid ?? null, file.contentDisposition ?? null, sha256(file.content)]),
  ]));
}

/** A digest of the changes an approved plan applies (which message, which action, which target). */
export function planApprovalDigest(items: ReadonlyArray<Pick<PlanItemForApproval, "n" | "action" | "emailId" | "target">>): string {
  return sha256(JSON.stringify(items.map((item) => [item.n, item.emailId ?? null, item.action, item.target ?? null])));
}

const stable = (value: unknown) => JSON.stringify(value, (_, inner) => (isRecord(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b))) : inner));

/** A digest of an automatic reply as it is stored (not when it was written or switched on). */
export function autoresponderApprovalDigest(rule: AutoresponderRule): string {
  const { updatedAt: _updated, activatedAt: _activated, ...rest } = rule;
  return sha256(stable(rest));
}

/** A digest of the rule set_rule stores: its name, whether it is on, its conditions and its actions. */
export const ruleApprovalDigest = (rule: EffectiveRule): string => sha256(stable(rule));

// What the person was shown, kept on the call's own argument object under a symbol: JSON from a client cannot carry a
// symbol key, so the model can neither set nor forge it, and it is not an argument (not listed, not audited, not ignored-noted).
// `digest` is undefined when the stored content could not be read for the question; nothing then matches it.
type Bound = { kind: "draft" | "plan" | "vcard" | "autoresponder" | "rule"; digest: string | undefined };
const APPROVED = Symbol("approved content");
type Marked = Record<string | symbol, unknown>;

const LOOKUP_MS = 5_000;
async function within<T>(work: () => Promise<T>): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work(), new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), LOOKUP_MS); })]);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const SHOWN_MESSAGES = 3;
const MAX_MESSAGE_CHARS = 1500;
// These carry a block (the reply text, a rule's conditions and actions) that the person needs to read in full.
const LONG_QUESTIONS = new Set(["set_autoresponder", "set_rule", "apply_rules"]);
const MAX_LONG_MESSAGE_CHARS = 2500;

function whenText(when: unknown): string {
  if (!isRecord(when)) return "no condition";
  const parts: string[] = [];
  if (strings(when.from).length) parts.push(`from ${listed(strings(when.from), 3)}`);
  if (strings(when.subjectContains).length) parts.push(`subject contains ${listed(strings(when.subjectContains), 3)}`);
  parts.push(`in ${quoted(when.folder ?? "INBOX", 60)}`);
  if (when.olderThanDays !== undefined) parts.push(`older than ${quoted(when.olderThanDays, 10)} days`);
  if (when.hasAttachment !== undefined) parts.push(when.hasAttachment === true ? "with an attachment" : "without an attachment");
  if (when.automated !== undefined) parts.push(when.automated === true ? "list and automatic mail only" : "mail from people only");
  if (when.unread === true) parts.push("unread only");
  return parts.join("; ");
}
function actionsText(actions: unknown): string {
  if (!isRecord(actions)) return "nothing";
  const parts: string[] = [];
  if (strings(actions.forwardTo).length) parts.push(`forward to ${listed(strings(actions.forwardTo), 3)}`);
  if (actions.label !== undefined) parts.push(`label ${quoted(actions.label, 40)}`);
  if (actions.markRead === true) parts.push("mark read");
  if (actions.moveTo !== undefined) parts.push(`move to ${quoted(actions.moveTo, 60)}`);
  if (actions.archive === true) parts.push("archive");
  if (actions.trash === true) parts.push("move to Trash");
  if (actions.delete === true) parts.push("delete for good");
  return parts.length ? parts.join("; ") : "nothing";
}

/** Whether the automatic reply would also go to someone who is not in the user's contacts (never written to). */
function answersStrangers(rule: AutoresponderRule): string {
  if (!rule.enabled) return "no (switched off)";
  const rules = rule.rules ?? [];
  if (!rule.body && !rule.bodies && !rules.some((candidate) => candidate.action !== "skip" && candidate.body)) return "no (there is no reply text)";
  let conditional = false;
  for (const candidate of rules) {
    if (candidate.known === "yes") continue;
    if (!candidate.from?.length && !candidate.subjectContains?.length) return candidate.action !== "skip" ? "yes" : conditional ? "only mail matching a rule" : "no";
    if (candidate.action !== "skip") conditional = true;
  }
  return "yes";
}

function matchText(match: unknown): string {
  if (!isRecord(match)) return "none";
  const parts: string[] = [];
  if (match.from !== undefined) parts.push(`from ${quoted(match.from, 60)}`);
  if (match.subject !== undefined) parts.push(`subject contains ${quoted(match.subject, 60)}`);
  if (match.text !== undefined) parts.push(`text contains ${quoted(match.text, 60)}`);
  if (match.since !== undefined) parts.push(`since ${quoted(match.since, 40)}`);
  if (match.before !== undefined) parts.push(`before ${quoted(match.before, 40)}`);
  if (match.isRead !== undefined) parts.push(normalizeBoolean(match.isRead, false) ? "read" : "unread");
  if (match.isStarred !== undefined) parts.push(normalizeBoolean(match.isStarred, false) ? "starred" : "not starred");
  if (match.sizeLarger !== undefined) parts.push(`larger than ${quoted(match.sizeLarger, 12)} bytes`);
  if (match.sizeSmaller !== undefined) parts.push(`smaller than ${quoted(match.sizeSmaller, 12)} bytes`);
  return parts.length ? parts.join("; ") : "none (every message in the folder)";
}

/** The text the person sees. Every dynamic piece is a quoted, cleaned, single-line value after a fixed label. */
export async function buildApprovalMessage(name: string, args: Record<string, unknown>, lookups: ApprovalLookups): Promise<string> {
  return (await buildApproval(name, args, lookups)).message;
}

async function buildApproval(name: string, args: Record<string, unknown>, lookups: ApprovalLookups): Promise<{ message: string; bound?: Bound }> {
  let bound: Bound | undefined;
  const lines: string[] = [`Approve ${name}?`, `Account: ${quoted(lookups.account(args))}`];
  const add = (label: string, text: string | undefined) => { if (text) lines.push(`${label}: ${text}`); };
  const recipients = (label: string, values: unknown) => { const list = strings(values); if (list.length) add(label, listed(list)); };
  const message = async (label: string, id: unknown) => {
    if (typeof id !== "string" || !id) return;
    const subject = await within(() => lookups.subject(id));
    add(label, `${quoted(id, 80)}${subject === undefined ? "" : ` subject ${quoted(subject)}`}`);
  };
  const messages = async (ids: string[]) => {
    add("Messages", String(ids.length));
    for (const id of ids.slice(0, SHOWN_MESSAGES)) await message("Message", id);
  };
  // How many messages a filter or a folder covers, from the local index, which may lag behind the mailbox.
  const counted = async () => {
    const found = await within(() => lookups.matches(name, args));
    add("Messages matched", found?.count === undefined ? "count unknown (the local index has nothing for this folder)" : `${found.count} (local index, may be out of date)`);
    if (found?.subjects.length) add("First subjects (untrusted mail text)", found.subjects.map((subject) => quoted(subject, 60)).join(", "));
  };

  switch (name) {
    case "send_email":
      recipients("To", args.to); recipients("Cc", args.cc); recipients("Bcc", args.bcc);
      add("Subject", quoted(args.subject)); add("Send as", typeof args.from === "string" ? quoted(args.from, 80) : undefined);
      if (Array.isArray(args.attachments) && args.attachments.length) add("Attachments", String(args.attachments.length));
      break;
    case "send_test_email":
      recipients("To", args.to); add("Send as", typeof args.from === "string" ? quoted(args.from, 80) : undefined);
      if (typeof args.customMessage === "string" && args.customMessage) add("Message", quoted(args.customMessage, 100));
      break;
    case "reply_to_email":
    case "reply_all_email": {
      await message("Replying to", args.emailId);
      const target = await within(() => lookups.target(name, args));
      if (target) {
        recipients("To", target.to); recipients("Cc", target.cc); recipients("Bcc", target.bcc);
        // Where answers go can be somewhere else than where the mail came from.
        if (target.replyTo?.length && addressSet(target.replyTo) !== addressSet(target.from ?? [])) add("Reply-To differs from sender", `Reply-To ${listed(target.replyTo)}, sender ${listed(target.from ?? [])}`);
      } else {
        add("To", "unknown (the message could not be read)"); recipients("Extra Cc", args.cc); recipients("Extra Bcc", args.bcc);
      }
      add("Send as", typeof args.from === "string" ? quoted(args.from, 80) : undefined);
      break;
    }
    case "forward_email": {
      await message("Forwarding", args.emailId);
      const target = await within(() => lookups.target(name, args));
      recipients("To", target ? target.to : args.to); recipients("Cc", target ? target.cc : args.cc); recipients("Bcc", target ? target.bcc : args.bcc);
      add("Send as", typeof args.from === "string" ? quoted(args.from, 80) : undefined);
      break;
    }
    case "send_draft":
    case "schedule_draft":
    case "delete_draft": {
      const draftId = typeof args.draftId === "string" ? args.draftId : "";
      const draft = draftId ? await within(() => lookups.draft(draftId)) : undefined;
      bound = { kind: "draft", digest: draft ? draftApprovalDigest(draft) : undefined };
      add("Draft", quoted(draftId, 80));
      if (draft) { recipients("To", draft.to); recipients("Cc", draft.cc); recipients("Bcc", draft.bcc); add("Subject", quoted(draft.subject)); }
      if (name === "schedule_draft") add("Send at", quoted(args.sendAt, 40));
      break;
    }
    case "respond_to_invite": {
      await message("Invitation", args.emailId); add("Response", quoted(args.response, 40));
      const invite = typeof args.emailId === "string" ? await within(() => lookups.invite(args.emailId as string)) : undefined;
      if (invite) { add("Organiser (from the invitation, untrusted)", invite.organizer ? quoted(invite.organizer, 80) : "unknown"); add("Event (from the invitation, untrusted)", invite.summary ? quoted(invite.summary, 80) : undefined); }
      else add("Organiser", "unknown (the invitation could not be read)");
      break;
    }
    case "unsubscribe_sender": {
      await message("Message", args.emailId);
      const info = typeof args.emailId === "string" ? await within(() => lookups.unsubscribe(args.emailId as string)) : undefined;
      add("Unsubscribe by", !info ? "unknown (the message could not be read)"
        : info.mailto ? `mail to ${quoted(info.mailto, 80)} (from the message, untrusted)`
        : info.host ? `a link on ${quoted(info.host, 80)}, which this server does not open (from the message, untrusted)`
        : "nothing: the message has no List-Unsubscribe header");
      break;
    }
    case "delete_email":
      await message("Message", args.emailId);
      break;
    case "delete_thread":
      await message("Thread of", args.messageId); add("Permanently", normalizeBoolean(args.permanent, false) ? "yes" : "no");
      break;
    case "bulk_delete":
    case "batch_email_action": {
      const ids = strings(args.emailIds);
      if (ids.length) await messages(ids);
      else if (name === "bulk_delete" && isRecord(args.match)) { add("Folder", quoted(args.folder, 80)); add("Filter", matchText(args.match)); await counted(); }
      else add("Messages", "chosen by a filter");
      if (name === "batch_email_action") add("Action", quoted(args.action, 40)); else add("Permanently", normalizeBoolean(args.permanent, false) ? "yes" : "no");
      break;
    }
    case "apply_thread_action":
      await message("Thread of", args.threadId); add("Action", quoted(args.action, 40));
      break;
    case "empty_folder":
      add("Empty folder", quoted(args.folder, 80)); await counted();
      break;
    case "delete_folder":
      add("Delete folder", quoted(args.path, 80)); await counted();
      break;
    case "delete_label":
      add("Delete label", quoted(args.name, 80));
      break;
    case "delete_template":
      add("Delete template", quoted(args.id, 80));
      break;
    case "set_rule": {
      const found = await within(() => lookups.rule(args));
      bound = { kind: "rule", digest: found ? ruleApprovalDigest(found.effective) : undefined };
      if (!found) {
        add("Rule", typeof args.name === "string" ? quoted(args.name, 80) : typeof args.id === "string" ? quoted(args.id, 80) : typeof args.proposalId === "string" ? quoted(args.proposalId, 80) : undefined);
        add("Effect", "may forward mail to another address (the stored rule or proposal could not be read)");
        break;
      }
      const { effective } = found;
      add("Rule", effective.name ? quoted(effective.name, 80) : "unnamed");
      if (found.from) add("From", `${found.from.kind} ${quoted(found.from.id, 80)}`);
      add("When", whenText(effective.when)); add("Actions", actionsText(effective.actions));
      if (isRecord(effective.actions) && strings(effective.actions.forwardTo).length) add("Forwarding", `at most ${FORWARD_DAILY_LIMIT} messages a day; it sends them by itself without asking each time, only mail that arrives after it is switched on`);
      add("Switched on", effective.enabled ? "yes" : "no");
      break;
    }
    case "set_autoresponder": {
      const rule = await within(() => lookups.autoresponder(args));
      bound = { kind: "autoresponder", digest: rule ? autoresponderApprovalDigest(rule) : undefined };
      if (!rule) { add("Effect", "changes the automatic reply, which can send mail by itself (the result could not be worked out)"); break; }
      add("Automatic reply", rule.enabled ? "on" : "off"); add("Mode", rule.mode ?? "send");
      add("Answers people outside your contacts", answersStrangers(rule));
      add("Reply subject", quoted(rule.subject, 120)); add("Reply text", rule.body ? quoted(rule.body, 300) : "none");
      for (const [language, text] of Object.entries(rule.bodies ?? {}).slice(0, 5)) add(`Text in ${cleanForPrompt(language, 10)}`, quoted(text, 100));
      if (rule.startsAt || rule.endsAt) add("Window", `from ${rule.startsAt ? quoted(rule.startsAt, 40) : "now"} to ${rule.endsAt ? quoted(rule.endsAt, 40) : "no end"}${rule.timezone ? ` (${quoted(rule.timezone, 40)})` : ""}`);
      if (rule.outsideHours) add("Only outside hours", `days ${strings(rule.outsideHours.days).join(",")}, ${quoted(rule.outsideHours.from, 10)} to ${quoted(rule.outsideHours.to, 10)}`);
      add("Limits", `each sender at most once in ${rule.replyEveryDays} days; at most ${rule.dailyLimit ?? 50} a day`);
      if (rule.outgoingNote) add("Note added to every mail sent", quoted(rule.outgoingNote, 100));
      const matchRules = rule.rules ?? [];
      if (matchRules.length) add("Rules", String(matchRules.length));
      matchRules.slice(0, 5).forEach((candidate, index) => {
        const parts: string[] = [candidate.action];
        if (candidate.from?.length) parts.push(`from ${listed(candidate.from, 3)}`);
        if (candidate.subjectContains?.length) parts.push(`subject contains ${listed(candidate.subjectContains, 3)}`);
        if (candidate.known) parts.push(candidate.known === "yes" ? "people you have written to" : "people you have not written to");
        add(`Rule ${index + 1}`, `${quoted(candidate.name ?? "", 40)} ${parts.join(", ")}`);
      });
      break;
    }
    case "apply_rules": {
      add("Rule", typeof args.ruleId === "string" ? quoted(args.ruleId, 80) : "all enabled rules");
      const plan = await within(() => lookups.applyPlan(args));
      if (!plan) { add("Effect", "applies them to the mailbox now (the matches could not be counted)"); break; }
      add("Messages matched", String(plan.total));
      if (plan.total > plan.limit) add("This run covers", `the first ${plan.limit}`);
      for (const [index, rule] of plan.rules.slice(0, 5).entries()) add(`Rule ${index + 1}`, `${quoted(rule.name, 40)} matches ${rule.matches} messages: ${actionsText(rule.actions)}`);
      break;
    }
    case "set_contact": {
      const clearable = (label: string, value: unknown) => { if (value !== undefined) add(label, value === null || value === "" ? "cleared" : quoted(value, 80)); };
      add("Address", quoted(args.address, 80)); clearable("Display name", args.displayName);
      for (const [label, tags] of [["Add tags", strings(args.addTags)], ["Remove tags", strings(args.removeTags)]] as const) if (tags.length) add(label, listed(tags));
      if (typeof args.mergeWith === "string" && args.mergeWith.trim()) add("Merge with", quoted(args.mergeWith, 80));
      if (normalizeBoolean(args.unmerge, false)) add("Unmerge", "yes");
      clearable("Notes", args.notes);
      break;
    }
    case "import_contacts": {
      const path = typeof args.path === "string" ? args.path : "";
      const file = path ? await within(() => lookups.vcard(path)) : undefined;
      bound = { kind: "vcard", digest: file?.digest };
      add("File", quoted(basename(path), 80)); add("Cards", file ? String(file.cards) : "unknown (the file could not be read)");
      break;
    }
    case "approve_plan": {
      const planId = typeof args.planId === "string" ? args.planId : "";
      add("Plan", quoted(planId, 80));
      const items = planId ? await within(() => lookups.plan(planId, args)) : undefined;
      bound = { kind: "plan", digest: items ? planApprovalDigest(items) : undefined };
      if (items) {
        add("Changes", String(items.length));
        for (const item of items.slice(0, SHOWN_MESSAGES)) add("Change", `${quoted(item.action, 40)} ${quoted(item.subject)}`);
      }
      break;
    }
    default: {
      // update_message_flags, bulk_update_flags, flag_thread: only reached when \Deleted is added.
      add("Flags to add", listed(strings(args.flagsToAdd)));
      if (typeof args.emailId === "string") await message("Message", args.emailId);
      else if (typeof args.messageId === "string") await message("Thread of", args.messageId);
      else if (strings(args.emailIds).length) await messages(strings(args.emailIds));
    }
  }
  const text = lines.join("\n");
  const cap = LONG_QUESTIONS.has(name) ? MAX_LONG_MESSAGE_CHARS : MAX_MESSAGE_CHARS;
  return { message: text.length > cap ? `${text.slice(0, cap - 1)}…` : text, bound };
}

type ElicitingServer = Pick<Server, "elicitInput" | "getClientCapabilities">;

export function clientCanElicit(server: Pick<Server, "getClientCapabilities">): boolean {
  const elicitation = server.getClientCapabilities()?.elicitation;
  // An empty capability object means form support (the spec's backwards-compatible default).
  return Boolean(elicitation) && (elicitation?.form !== undefined || elicitation?.url === undefined);
}

const refuse = (text: string) => new McpError(ErrorCode.InvalidRequest, `${text} Do not retry unless the user asks for it.`);

/**
 * Called by a handler that acts on stored content (a draft, a plan) with the content as it reads it now. When the person was
 * asked about this call, it must be what they were shown: anything else (the draft edited by a parallel update_draft, a plan
 * rewritten, content that could not be shown) is refused before anything is sent, scheduled, deleted or applied.
 * A call that was not asked about (approval off, a delegation grant) carries nothing and passes.
 */
export function assertApprovedContentUnchanged(args: Record<string, unknown>, kind: Bound["kind"], current: string, name: string): void {
  const bound = (args as Marked)[APPROVED] as Bound | undefined;
  if (!bound || bound.kind !== kind || bound.digest === current) return;
  throw refuse(`Not approved: the ${kind} changed after you were asked (or could not be shown to you), so ${name} did not run. Nothing was done. Look at it again and ask the user again.`);
}

/**
 * The hook in front of every tool call. `off` does nothing at all. In `elicit` and `require` the model's own `confirmed` is
 * dropped, and for a call that needs approval the person is asked; their yes sets `confirmed` for the gate behind this one.
 * `elicit` on a client without elicitation changes nothing (today's behaviour); `require` refuses such a call.
 */
export async function applyApprovalPolicy(options: {
  mode: ApprovalMode;
  server: ElicitingServer;
  name: string;
  args: Record<string, unknown>;
  declared: ReadonlySet<string>;
  lookups: ApprovalLookups;
  timeoutSeconds?: number;
}): Promise<void> {
  const { mode, server, name, args } = options;
  if (mode === "off") return;
  const capable = clientCanElicit(server);
  if (mode === "elicit" && !capable) return;
  delete args.confirmed;
  if (!needsApproval(name, args, options.declared)) return;
  if (!capable) {
    throw refuse(`${name} needs the user's approval and PROTONMAIL_APPROVAL=require, but this client does not support MCP elicitation, so the user cannot be asked. Use a client that supports it, or set PROTONMAIL_APPROVAL=elicit (or off) to go back to confirmed: true.`);
  }
  const seconds = options.timeoutSeconds ?? DEFAULT_APPROVAL_TIMEOUT_SECONDS;
  const { message, bound } = await buildApproval(name, args, options.lookups);
  let answer;
  try {
    answer = await server.elicitInput({ message, requestedSchema: { type: "object", properties: {} } }, { timeout: seconds * 1000 });
  } catch (error) {
    if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) throw refuse(`Not approved: the user did not answer within ${seconds} s, so ${name} was not run.`);
    throw refuse(`Not approved: the user could not be asked (${error instanceof Error ? cleanForPrompt(error.message, 200) : "unknown error"}), so ${name} was not run.`);
  }
  if (answer.action === "accept") {
    args.confirmed = true;
    if (bound) (args as Marked)[APPROVED] = bound;
    return;
  }
  throw refuse(answer.action === "decline" ? `Not approved: the user declined ${name}.` : `Not approved: the user dismissed the approval question for ${name}.`);
}
