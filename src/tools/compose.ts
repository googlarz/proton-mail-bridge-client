import { plainTextToHtml } from "../services/smtp-service.js";
import { foldQuotedHistory, isValidEmail, lowerCaseAddress, isSelfAddress } from "../utils/helpers.js";
import { type EmailDetail, type EmailAddress } from "../types/index.js";
// Writing a reply or a forward (quoted text and HTML, recipients, subject prefixes), and reading what a message says about itself (security headers, unsubscribe links).

// Shared by get_email_by_id and get_emails_by_ids: applies body preference/
// truncation and strips the full raw header map by default (needless token
// bloat — get_email_by_id re-adds it when showHeaders is explicitly true).
export function formatEmailDetailOutput(
  detail: EmailDetail,
  preferHtml: boolean,
  maxBodyLength: number,
): Record<string, unknown> {
  let displayBody = preferHtml
    ? (typeof detail.html === "string" ? detail.html : detail.text ?? "")
    : (detail.text ?? "");
  // Only the plain-text path: quote-boundary detection is regex-based on
  // ">"-prefixed lines and "wrote:" markers, which doesn't map onto HTML
  // (blockquotes, interspersed tags) — folding raw HTML here would corrupt
  // it, not shrink it. Comparison against other Proton MCP servers found
  // this is real, avoidable token bloat on a message deep in a thread that
  // repeats every prior reply verbatim at the bottom.
  if (!preferHtml && displayBody) {
    displayBody = foldQuotedHistory(displayBody);
  }
  if (maxBodyLength) {
    const codepoints = [...displayBody];
    if (codepoints.length > maxBodyLength) {
      displayBody = codepoints.slice(0, maxBodyLength).join("") + `\n[truncated at ${maxBodyLength} chars]`;
    }
  }

  const output: Record<string, unknown> = {
    ...detail,
    text: displayBody,
    security: buildSecurityInfo(detail),
    // Disposition-Notification-To means the sender asked for a read receipt.
    // Surfaced so an agent can decide whether to honor it — this server never
    // sends an MDN automatically.
    readReceiptRequested: Boolean(headerString(detail.headers, "disposition-notification-to")),
  };
  if (!preferHtml) delete output.html;
  delete output.headers;
  return output;
}

// mailparser merges List-Unsubscribe (and other List-*) headers into
// detail.headers.list.unsubscribe = { mail?: string, url?: string, name?: string }
// (mail has the "mailto:" prefix already stripped). See mapHeaderValue in
// simple-imap-service.ts for how this nested shape survives serialization.
export function headerString(headers: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = headers?.[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

// Authentication-Results (RFC 8601) is a semi-structured string, not something
// mailparser special-cases into an object: "mx.google.com; dkim=pass ...;
// spf=pass ...; dmarc=pass ...". Pull out the result word for each mechanism.
export function parseAuthenticationResults(value?: string): { dkim?: string; spf?: string; dmarc?: string } {
  if (!value) return {};
  const match = (mechanism: string) => value.match(new RegExp(`\\b${mechanism}=(\\w+)`, "i"))?.[1]?.toLowerCase();
  return { dkim: match("dkim"), spf: match("spf"), dmarc: match("dmarc") };
}

// Bridge injects Proton-only security metadata into every message it serves.
// Surfacing it lets an agent answer "is this email legit?" using signals a
// generic IMAP client can't see — verified against a live Bridge connection
// during the roadmap audit that motivated this tool (x-pm-origin,
// x-pm-content-encryption, x-pm-transfer-encryption, x-pm-spamscore,
// x-pm-spam-action, and a standard Authentication-Results header were all
// observed present on a real message).
export function buildSecurityInfo(detail: EmailDetail): Record<string, unknown> {
  const headers = detail.headers;
  const auth = parseAuthenticationResults(headerString(headers, "authentication-results"));
  return {
    origin: headerString(headers, "x-pm-origin"),
    contentEncryption: headerString(headers, "x-pm-content-encryption"),
    transferEncryption: headerString(headers, "x-pm-transfer-encryption"),
    spamScore: headerString(headers, "x-pm-spamscore"),
    spamAction: headerString(headers, "x-pm-spam-action"),
    dkim: auth.dkim,
    spf: auth.spf,
    dmarc: auth.dmarc,
  };
}

// "unsub@list.example?subject=Remove%20me&body=..." as mailparser hands over a List-Unsubscribe mailto: one
// address plus the subject and body the sender asked for. Anything with more than one recipient, or an
// address part that is not an address, is refused; the requested text is cut to a sane length and stripped of
// line breaks, because it ends up in a header and a body of a mail this server sends.
export function parseUnsubscribeMailto(value: string): { address: string; subject?: string; body?: string } | undefined {
  const cleaned = value.trim().replace(/^mailto:/i, "");
  const questionMark = cleaned.indexOf("?");
  const addressPart = questionMark === -1 ? cleaned : cleaned.slice(0, questionMark);
  let address: string;
  try {
    address = decodeURIComponent(addressPart).trim();
  } catch {
    return undefined;
  }
  if (!address || /[\s,;<>]/.test(address) || !isValidEmail(address)) return undefined;
  const params = new URLSearchParams(questionMark === -1 ? "" : cleaned.slice(questionMark + 1));
  const text = (key: string, max: number, keepNewlines: boolean): string | undefined => {
    const raw = params.get(key);
    if (!raw) return undefined;
    const clean = (keepNewlines ? raw.replace(/\r/g, "") : raw.replace(/[\r\n]+/g, " ")).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
    return clean ? clean.slice(0, max) : undefined;
  };
  return { address, subject: text("subject", 200, false), body: text("body", 2000, true) };
}

export function extractUnsubscribeInfo(detail: EmailDetail): { mailto?: string; mailtoSubject?: string; mailtoBody?: string; url?: string } {
  const list = detail.headers?.list as Record<string, unknown> | undefined;
  const unsubscribe = list?.unsubscribe as Record<string, unknown> | undefined;
  const mail = typeof unsubscribe?.mail === "string" ? parseUnsubscribeMailto(unsubscribe.mail) : undefined;
  const url = typeof unsubscribe?.url === "string" ? unsubscribe.url : undefined;
  return {
    mailto: mail?.address,
    ...(mail?.subject ? { mailtoSubject: mail.subject } : {}),
    ...(mail?.body ? { mailtoBody: mail.body } : {}),
    url,
  };
}

export function uniqueAddresses(addresses: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const address of addresses) {
    const normalized = lowerCaseAddress(address);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(address.trim());
  }

  return result;
}

export function addressValues(addresses: EmailAddress[]): string[] {
  return uniqueAddresses(
    addresses
      .map((value) => value.address?.trim())
      .filter((value): value is string => Boolean(value)),
  );
}

export function prefixedSubject(subject: string, prefix: "Re:" | "Fwd:"): string {
  const trimmed = subject.trim();
  if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
    return trimmed;
  }
  return `${prefix} ${trimmed}`;
}

export function formatAddressList(addresses: EmailAddress[]): string {
  return addresses
    .map((value) => {
      if (value.name && value.address) {
        return `${value.name} <${value.address}>`;
      }
      return value.address || value.name || "";
    })
    .filter(Boolean)
    .join(", ");
}

export function quotePlainText(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

// "2026-09-30T08:11:15.000Z" is not how anyone writes "On <date>, X wrote:". Falls back to the
// raw value when it is not a parseable date (an "unknown date" placeholder, a header string).
export function formatQuoteDate(value: string): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value;
  return new Date(time).toLocaleString("en-GB", {
    weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).replace(",", "");
}

// The quoted original's images cannot travel with a reply: a data: image is dropped by Gmail/Outlook
// (a broken-image box) and copies its base64 into every reply, and a cid: image refers to a part
// that is not attached here. Replace each with its alt text, or nothing.
export function stripUnshippableImages(html: string): string {
  // A tag is a run of non-quote characters and quoted strings, so a ">" inside alt="a>b" does not end
  // it and an unclosed "<img" stops at the next "<" instead of scanning to the end of the text.
  return html.replace(/<img\b(?:[^<>"']|"[^"]*"|'[^']*')*>/gi, (tag) => {
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const value = (src?.[1] ?? src?.[2] ?? src?.[3] ?? "").trim().toLowerCase();
    if (!value.startsWith("data:") && !value.startsWith("cid:")) return tag;
    const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const text = (alt?.[1] ?? alt?.[2] ?? "").trim();
    return text ? `[${text}]` : "";
  });
}

// References for a reply: the original's own chain followed by the original's Message-ID (RFC 5322),
// so mail clients that thread by References keep the whole conversation together.
export function replyReferences(detail: EmailDetail): string[] | undefined {
  const chain = [...(detail.references ?? []), detail.messageId].filter((id): id is string => Boolean(id));
  const unique = [...new Set(chain)];
  return unique.length > 0 ? unique : undefined;
}

// Drops blank lines around the body but keeps the first line's own indentation (code, lists).
export function trimBodyEdges(body: string): string {
  return body.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd();
}

export function buildReplyText(detail: EmailDetail, body: string): string {
  const originalText = detail.text || detail.preview || "";
  const fromText = formatAddressList(detail.from);
  const dateText = formatQuoteDate(detail.date || detail.internalDate || "an unknown date");

  return [
    trimBodyEdges(body),
    "",
    `On ${dateText}, ${fromText || "the sender"} wrote:`,
    quotePlainText(originalText),
  ].join("\n");
}

export function buildForwardText(detail: EmailDetail, body?: string): string {
  const originalText = detail.text || detail.preview || "";

  return [
    body?.trim() ? trimBodyEdges(body) : "",
    "",
    "---------- Forwarded message ---------",
    `From: ${formatAddressList(detail.from)}`,
    `Date: ${detail.date || detail.internalDate || ""}`,
    `Subject: ${detail.subject}`,
    `To: ${formatAddressList(detail.to)}`,
    detail.cc.length > 0 ? `Cc: ${formatAddressList(detail.cc)}` : "",
    "",
    originalText,
  ]
    .filter((line, index, array) => line !== "" || (index > 0 && array[index - 1] !== ""))
    .join("\n");
}

// HTML counterparts of buildReplyText/buildForwardText — needed because a
// markdown-authored reply/forward (markdownBody) renders its OWN new text to a
// real, separate htmlBody, but buildReplyText/buildForwardText only ever wrapped
// the PLAIN TEXT `body` with the quoted/forwarded original. That original never
// made it into htmlBody at all — an HTML-viewing recipient of a markdown reply
// saw only the new text and signature, with the entire original message missing
// (confirmed on generated MIME messages), while the text/plain part had it via
// buildReplyText. Uses the original message's own detail.html when present
// (real markup, not reconstructed); falls back to escaping detail.text/preview
// through plainTextToHtml otherwise, same as a plain-text send's own html
// alternative (see smtp-service.ts's plainTextToHtml comment).
export function buildReplyHtml(detail: EmailDetail, htmlBody: string): string {
  const originalHtml = typeof detail.html === "string" && detail.html
    ? stripUnshippableImages(detail.html)
    : plainTextToHtml(detail.text || detail.preview || "");
  const fromText = formatAddressList(detail.from);
  const dateText = formatQuoteDate(detail.date || detail.internalDate || "an unknown date");
  return [
    htmlBody,
    `<p>On ${escapeHtmlForQuote(dateText)}, ${escapeHtmlForQuote(fromText || "the sender")} wrote:</p>`,
    `<blockquote>${originalHtml}</blockquote>`,
  ].join("\n");
}

export function buildForwardHtml(detail: EmailDetail, htmlBody?: string): string {
  const originalHtml = typeof detail.html === "string" && detail.html
    ? stripUnshippableImages(detail.html)
    : plainTextToHtml(detail.text || detail.preview || "");
  return [
    htmlBody?.trim() || "",
    "<p>---------- Forwarded message ---------</p>",
    `<p>From: ${escapeHtmlForQuote(formatAddressList(detail.from))}<br>`,
    `Date: ${escapeHtmlForQuote(detail.date || detail.internalDate || "")}<br>`,
    `Subject: ${escapeHtmlForQuote(detail.subject)}<br>`,
    `To: ${escapeHtmlForQuote(formatAddressList(detail.to))}${detail.cc.length > 0 ? `<br>Cc: ${escapeHtmlForQuote(formatAddressList(detail.cc))}` : ""}</p>`,
    originalHtml,
  ]
    .filter((part) => part !== "")
    .join("\n");
}

export function escapeHtmlForQuote(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function getReplyRecipients(
  detail: EmailDetail,
  ownerEmail: string,
  replyAll: boolean,
  otherSelfAddresses: string[] = [],
): { to: string[]; cc: string[] } {
  // "Self" = the owner (incl. +tag aliases) or any other configured account.
  const isSelf = (address: string): boolean =>
    isSelfAddress(address, ownerEmail) || otherSelfAddresses.some((own) => isSelfAddress(address, own));
  const notSelf = (addresses: string[]): string[] => uniqueAddresses(addresses.filter((address) => !isSelf(address)));
  // On a message we sent ourselves, Reply-To is OUR own header (e.g. an alias we set), not where the
  // recipients want answers — it must not redirect the reply to ourselves or a third party.
  const fromAddresses = addressValues(detail.from);
  const sentBySelf = fromAddresses.length > 0 && fromAddresses.every(isSelf);
  const primary = !sentBySelf && addressValues(detail.replyTo).length > 0 ? detail.replyTo : detail.from;
  const primaryAddresses = addressValues(primary);
  const strippedTo = notSelf(primaryAddresses);
  // A message the user SENT (from = self, nothing else in reply-to) is answered
  // by writing to the people it was sent to, not back to the user. Only when
  // there is nobody else (a "note to self") do we fall back to self, as every
  // mail client does — stripping the owner otherwise leaves zero recipients and
  // the reply would throw "Unable to infer reply recipient."
  const originalTo = strippedTo.length === 0 ? notSelf(addressValues(detail.to)) : [];
  const to =
    strippedTo.length > 0 ? strippedTo : originalTo.length > 0 ? originalTo : uniqueAddresses(primaryAddresses);

  if (!replyAll) {
    return { to, cc: [] };
  }

  // Reply-To redirected the primary recipient; reply-all must still reach the original sender.
  const ccPool = notSelf([...addressValues(detail.from), ...addressValues(detail.to), ...addressValues(detail.cc)]).filter(
    (address) => !to.some((recipient) => lowerCaseAddress(recipient) === lowerCaseAddress(address)),
  );

  return { to, cc: ccPool };
}
