// Scoped delegation: the rules that decide whether a grant covers a call. A grant is a narrow, expiring permission the
// person creates with the CLI at a terminal; no MCP tool can create or widen one. That holds against a model that has only
// MCP tools, not against one that can also write files or run a shell (it can write grants.json itself): the store is not
// signed. Everything here is pure, so the same rules serve the gate in front of a tool call, the claim just before the
// send, the store and the CLI.

/** The only tools a grant can cover: the ones that send mail to a recipient the person can name in advance. */
export const GRANTABLE_TOOLS = ["send_email", "reply_to_email", "reply_all_email", "forward_email", "send_draft", "schedule_draft"] as const;
export type GrantableTool = (typeof GRANTABLE_TOOLS)[number];

export const isGrantableTool = (name: string): name is GrantableTool => (GRANTABLE_TOOLS as readonly string[]).includes(name);

export const MAX_GRANT_USES = 50;
export const MAX_GRANT_DAYS = 30;
export const MAX_GRANT_RECIPIENTS = 50;
export const MAX_GRANT_NOTE_CHARS = 200;

export type DelegationMode = "off" | "on";

export function parseDelegationEnv(name: string): DelegationMode {
  const raw = process.env[name]?.trim().toLowerCase();
  // An unfilled "${user_config.delegation}" from a host that did not substitute it is "not set", not a typo to fail on.
  if (!raw || raw.startsWith("${")) return "off";
  if (raw === "off" || raw === "on") return raw;
  throw new Error(`${name} must be one of: off, on (got "${raw}").`);
}

// Only A-Z are folded. String.prototype.toLowerCase would also turn non-ASCII characters into ASCII ones (the Kelvin sign
// U+212A becomes "k"), which is exactly the look-alike trick the exact comparison below must not fall for.
const asciiLower = (value: string): string => value.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);
const ADDRESS = new RegExp(`^[a-z0-9.!#$%&'*+/=?^_\`{|}~-]+@(${LABEL}(?:\\.${LABEL})+)$`);

function asciiAddress(value: string): string | undefined {
  // Anything but printable ASCII (a space, a control or bidi character, a non-ASCII letter) cannot be read with certainty.
  if (/[^\x21-\x7e]/.test(value)) return undefined;
  const text = asciiLower(value);
  return text.length <= 254 && ADDRESS.test(text) ? text : undefined;
}

/** The bare, ASCII-lowercased address of one recipient ("Name <a@b.example>" or "a@b.example"); undefined when it cannot be read exactly. */
export function normalizeRecipient(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  // The display name is ignored; what counts is the one address between the angle brackets.
  const named = /^[^<>]*<([^<>]+)>$/.exec(text);
  return asciiAddress((named ? named[1] : text).trim());
}

/** A pattern a grant may hold: an exact address, or "@domain" for every address at exactly that domain. Undefined when it is neither. */
export function normalizeRecipientPattern(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text.startsWith("@")) {
    if (/[^\x21-\x7e]/.test(text)) return undefined;
    const domain = asciiLower(text.slice(1));
    return domain.length <= 253 && DOMAIN.test(domain) ? `@${domain}` : undefined;
  }
  // "*" is a legal character in an address, but in a pattern it only ever means someone hoped for a wildcard: there are none.
  return text.includes("*") ? undefined : asciiAddress(text);
}

/** Whether every recipient of a call is an exact match of a pattern. No recipient, or one that cannot be read, is never covered. */
export function recipientsCovered(patterns: readonly string[], recipients: readonly unknown[]): boolean {
  if (recipients.length === 0) return false;
  for (const recipient of recipients) {
    const address = normalizeRecipient(recipient);
    if (!address) return false;
    const domain = address.slice(address.lastIndexOf("@"));
    if (!patterns.includes(address) && !patterns.includes(domain)) return false;
  }
  return true;
}
