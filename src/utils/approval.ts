// Real human approval. `confirmed: true` is an argument, so the model can set it itself (a persuaded model, a message that
// says "pass confirmed"). With PROTONMAIL_APPROVAL=elicit|require the SERVER asks the person through the client (MCP
// elicitation) and only their answer counts. The question is built here from what the server knows (the account, the tool,
// the recipients that will really be used, a stored draft, a plan), never from text the model wrote about the action, and
// every piece of mail text in it is stripped of control and bidi characters and cut short.

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
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
function listed(values: string[], max = 5): string {
  const shown = values.slice(0, max).map((value) => quoted(value, 80));
  return shown.join(", ") + (values.length > max ? ` and ${values.length - max} more` : "");
}

export interface ApprovalLookups {
  account(args: Record<string, unknown>): string;
  subject(id: string): Promise<string | undefined>;
  draft(id: string): Promise<{ to: string[]; cc: string[]; bcc: string[]; subject: string } | undefined>;
  plan(planId: string, args: Record<string, unknown>): Promise<Array<{ n: number; action: string; subject: string }> | undefined>;
}

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

/** The text the person sees. Every dynamic piece is a quoted, cleaned, single-line value after a fixed label. */
export async function buildApprovalMessage(name: string, args: Record<string, unknown>, lookups: ApprovalLookups): Promise<string> {
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

  switch (name) {
    case "send_email":
      recipients("To", args.to); recipients("Cc", args.cc); recipients("Bcc", args.bcc);
      add("Subject", quoted(args.subject)); add("Send as", typeof args.from === "string" ? quoted(args.from, 80) : undefined);
      if (Array.isArray(args.attachments) && args.attachments.length) add("Attachments", String(args.attachments.length));
      break;
    case "send_test_email":
      recipients("To", args.to);
      break;
    case "reply_to_email":
    case "reply_all_email":
      await message("Replying to", args.emailId); recipients("Extra Cc", args.cc); recipients("Extra Bcc", args.bcc);
      break;
    case "forward_email":
      await message("Forwarding", args.emailId); recipients("To", args.to); recipients("Cc", args.cc); recipients("Bcc", args.bcc);
      break;
    case "send_draft":
    case "schedule_draft":
    case "delete_draft": {
      const draftId = typeof args.draftId === "string" ? args.draftId : "";
      const draft = draftId ? await within(() => lookups.draft(draftId)) : undefined;
      add("Draft", quoted(draftId, 80));
      if (draft) { recipients("To", draft.to); recipients("Cc", draft.cc); recipients("Bcc", draft.bcc); add("Subject", quoted(draft.subject)); }
      if (name === "schedule_draft") add("Send at", quoted(args.sendAt, 40));
      break;
    }
    case "respond_to_invite":
      await message("Invitation", args.emailId); add("Response", quoted(args.response, 40));
      break;
    case "unsubscribe_sender":
    case "delete_email":
      await message("Message", args.emailId);
      break;
    case "delete_thread":
      await message("Thread of", args.messageId); add("Permanently", args.permanent === true ? "yes" : "no");
      break;
    case "bulk_delete":
    case "batch_email_action": {
      const ids = strings(args.emailIds);
      if (ids.length) await messages(ids); else add("Messages", "chosen by a filter");
      if (name === "batch_email_action") add("Action", quoted(args.action, 40)); else add("Permanently", args.permanent === true ? "yes" : "no");
      break;
    }
    case "apply_thread_action":
      await message("Thread of", args.threadId); add("Action", quoted(args.action, 40));
      break;
    case "empty_folder":
      add("Empty folder", quoted(args.folder, 80));
      break;
    case "delete_folder":
      add("Delete folder", quoted(args.path, 80));
      break;
    case "delete_label":
      add("Delete label", quoted(args.name, 80));
      break;
    case "delete_template":
      add("Delete template", quoted(args.id, 80));
      break;
    case "set_rule": {
      const forwardTo = isRecord(args.actions) ? strings(args.actions.forwardTo) : [];
      add("Rule", typeof args.name === "string" ? quoted(args.name, 80) : typeof args.id === "string" ? quoted(args.id, 80) : typeof args.proposalId === "string" ? quoted(args.proposalId, 80) : undefined);
      if (forwardTo.length) add("Forwards mail to", listed(forwardTo)); else add("Effect", "may forward mail to another address (taken from the stored rule or proposal)");
      break;
    }
    case "set_autoresponder":
      add("Effect", args.enabled === false ? "changes the automatic reply" : "switches on or changes the automatic reply, which sends mail by itself");
      break;
    case "apply_rules":
      add("Rule", typeof args.ruleId === "string" ? quoted(args.ruleId, 80) : "all enabled rules"); add("Effect", "applies them to the mailbox now");
      break;
    case "approve_plan": {
      const planId = typeof args.planId === "string" ? args.planId : "";
      add("Plan", quoted(planId, 80));
      const items = planId ? await within(() => lookups.plan(planId, args)) : undefined;
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
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - 1)}…` : text;
}

type ElicitingServer = Pick<Server, "elicitInput" | "getClientCapabilities">;

export function clientCanElicit(server: Pick<Server, "getClientCapabilities">): boolean {
  const elicitation = server.getClientCapabilities()?.elicitation;
  // An empty capability object means form support (the spec's backwards-compatible default).
  return Boolean(elicitation) && (elicitation?.form !== undefined || elicitation?.url === undefined);
}

const refuse = (text: string) => new McpError(ErrorCode.InvalidRequest, `${text} Do not retry unless the user asks for it.`);

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
  const message = await buildApprovalMessage(name, args, options.lookups);
  let answer;
  try {
    answer = await server.elicitInput({ message, requestedSchema: { type: "object", properties: {} } }, { timeout: seconds * 1000 });
  } catch (error) {
    if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) throw refuse(`Not approved: the user did not answer within ${seconds} s, so ${name} was not run.`);
    throw refuse(`Not approved: the user could not be asked (${error instanceof Error ? cleanForPrompt(error.message, 200) : "unknown error"}), so ${name} was not run.`);
  }
  if (answer.action === "accept") {
    args.confirmed = true;
    return;
  }
  throw refuse(answer.action === "decline" ? `Not approved: the user declined ${name}.` : `Not approved: the user dismissed the approval question for ${name}.`);
}
