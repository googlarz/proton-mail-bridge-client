import type { MessageAddressObject, MessageStructureObject } from "imapflow";
import type {
  EmailAddress,
  EmailAttachmentSummary,
  EmailSummary,
  SearchEmailsInput,
} from "../types/index.js";

const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const EMAIL_ID_SEPARATOR = "::";

export function parseEmails(value?: string): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email);
}

export function ensureValidEmails(emails: string[], fieldName: string): void {
  const invalid = emails.filter((email) => !isValidEmail(email));
  if (invalid.length > 0) {
    throw new Error(`Invalid ${fieldName} email address(es): ${invalid.join(", ")}`);
  }
}

export function createEmailId(folder: string, uid: number): string {
  return `${encodeURIComponent(folder)}${EMAIL_ID_SEPARATOR}${uid}`;
}

export function parseEmailId(emailId: string): { folder: string; uid: number } {
  const index = emailId.lastIndexOf(EMAIL_ID_SEPARATOR);
  if (index === -1) {
    throw new Error(
      "Invalid emailId. Expected the email identifier returned by get_emails or search_emails.",
    );
  }

  const folder = decodeURIComponent(emailId.slice(0, index));
  const uid = Number(emailId.slice(index + EMAIL_ID_SEPARATOR.length));

  if (!folder || !Number.isInteger(uid) || uid <= 0) {
    throw new Error(
      "Invalid emailId. Expected the email identifier returned by get_emails or search_emails.",
    );
  }

  return { folder, uid };
}

export function mapEnvelopeAddresses(addresses?: MessageAddressObject[]): EmailAddress[] {
  return (addresses ?? []).map((address) => ({
    name: address.name,
    address: address.address,
  }));
}

export function mapParsedAddresses(
  addresses?: { value?: Array<{ name?: string; address?: string }> } | null,
): EmailAddress[] {
  return (addresses?.value ?? []).map((address) => ({
    name: address.name,
    address: address.address,
  }));
}

export function previewText(value?: string, maxLength = 220): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}...`;
}

export function stripHtmlToText(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const withoutTags = value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");

  return previewText(withoutTags, 10_000);
}

export function extractMessageIdList(value?: string | string[]): string[] {
  if (!value) {
    return [];
  }

  const raw = Array.isArray(value) ? value.join(" ") : value;
  const matches = raw.match(/<[^>]+>/g) ?? [];
  const normalized = matches
    .map((entry) => normalizeMessageId(entry))
    .filter((entry): entry is string => Boolean(entry));

  return [...new Set(normalized)];
}

export function extractAttachments(
  structure?: MessageStructureObject,
): EmailAttachmentSummary[] {
  if (!structure) {
    return [];
  }

  const attachments: EmailAttachmentSummary[] = [];

  const visit = (node: MessageStructureObject): void => {
    const filename =
      node.dispositionParameters?.filename ??
      node.parameters?.name ??
      node.parameters?.filename;
    const disposition = node.disposition?.toLowerCase();
    const looksLikeAttachment =
      disposition === "attachment" || (disposition === "inline" && Boolean(filename));

    if (looksLikeAttachment || filename) {
      const classification = classifyAttachment({
        filename,
        contentType: node.type,
        disposition: node.disposition,
        cid: node.id,
      });
      attachments.push({
        id: node.part,
        filename,
        contentType: node.type,
        size: node.size,
        disposition: node.disposition,
        part: node.part,
        cid: node.id,
        isInline: disposition === "inline",
        kind: classification.kind,
        isCalendarInvite: classification.isCalendarInvite,
        isSignature: classification.isSignature,
      });
    }

    for (const child of node.childNodes ?? []) {
      visit(child);
    }
  };

  visit(structure);
  return attachments;
}

export function dedupeEmails(emails: EmailSummary[]): EmailSummary[] {
  const seen = new Set<string>();
  const result: EmailSummary[] = [];

  for (const email of emails) {
    const dedupeKey = email.messageId || email.id;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    result.push(email);
  }

  return result;
}

export function sortEmailsByNewest<T extends Pick<EmailSummary, "date" | "internalDate" | "uid">>(
  emails: T[],
): T[] {
  return [...emails].sort((left, right) => {
    const leftTime = new Date(left.internalDate || left.date || 0).getTime();
    const rightTime = new Date(right.internalDate || right.date || 0).getTime();

    if (rightTime !== leftTime) {
      return rightTime - leftTime;
    }

    return right.uid - left.uid;
  });
}

export function normalizeLimit(
  value: unknown,
  defaultValue: number,
  min = 1,
  max = 250,
): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return defaultValue;
  }

  const rounded = Math.trunc(value);
  if (rounded < min) {
    return min;
  }
  if (rounded > max) {
    return max;
  }
  return rounded;
}

export function normalizeBoolean(value: unknown, defaultValue: boolean): boolean {
  return typeof value === "boolean" ? value : defaultValue;
}

export function parseDateInput(value?: string): Date | undefined {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date value: ${value}`);
  }

  return date;
}

export function nextDay(date: Date): Date {
  return new Date(date.getTime() + 24 * 60 * 60 * 1000);
}

export function matchesLocalSearchFilters(
  email: EmailSummary,
  filters: SearchEmailsInput,
): boolean {
  if (typeof filters.hasAttachment === "boolean" && email.hasAttachments !== filters.hasAttachment) {
    return false;
  }

  if (filters.threadId && email.threadId !== filters.threadId) {
    return false;
  }

  if (filters.label) {
    const labelNeedle = filters.label.toLowerCase();
    const folderMatch = email.folder.toLowerCase() === labelNeedle;
    const labelMatch = email.labels.some((label) => label.toLowerCase() === labelNeedle);
    if (!folderMatch && !labelMatch) {
      return false;
    }
  }

  if (filters.attachmentName) {
    const attachmentNeedle = filters.attachmentName.toLowerCase();
    const match = email.attachments.some((attachment) =>
      (attachment.filename || "").toLowerCase().includes(attachmentNeedle),
    );
    if (!match) {
      return false;
    }
  }

  if (filters.senderDomain) {
    const senderDomain = filters.senderDomain.toLowerCase();
    const match = email.from.some((entry) => extractDomain(entry.address || "") === senderDomain);
    if (!match) {
      return false;
    }
  }

  if (filters.mailboxRole) {
    const roleNeedle = filters.mailboxRole.toLowerCase();
    const roles = new Set(
      [email.folder, ...email.labels]
        .map((value) => normalizeMailboxLabel(value))
        .filter((value): value is string => Boolean(value))
        .map((value) => value.toLowerCase()),
    );
    if (!roles.has(roleNeedle)) {
      return false;
    }
  }

  return true;
}

export function stringifyForJson(value: unknown): string {
  return JSON.stringify(normalizeJsonValue(value), null, 2);
}

export function normalizeJsonValue(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonValue(item));
  }

  if (value instanceof Set) {
    return [...value].map((item) => normalizeJsonValue(item));
  }

  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].map(([key, mapValue]) => [String(key), normalizeJsonValue(mapValue)]),
    );
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, objectValue]) => {
        const normalized = normalizeJsonValue(objectValue);
        return normalized === undefined ? [] : [[key, normalized]];
      }),
    );
  }

  return String(value);
}

export function lowerCaseAddress(value?: string): string | undefined {
  return value?.trim().toLowerCase();
}

export function normalizeMessageId(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.replace(/\s+/g, "").toLowerCase();
}

export function extractDomain(address: string): string | undefined {
  const parts = address.split("@");
  return parts.length === 2 ? parts[1].toLowerCase() : undefined;
}

export function normalizeSubjectForThread(subject: string): string {
  const collapsed = subject.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return "(no subject)";
  }

  return collapsed.replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, "").trim() || "(no subject)";
}

export function sanitizeFileName(filename?: string, fallback = "attachment"): string {
  let name = (filename || fallback).normalize('NFC');
  const normalized = name.replace(/[\\/:*?"<>|]+/g, "_").replace(/\.\./g, '_').trim();
  return normalized || fallback;
}

export function isTextLikeMimeType(mimeType?: string): boolean {
  if (!mimeType) {
    return false;
  }

  const normalized = mimeType.toLowerCase();
  return (
    normalized.startsWith("text/") ||
    normalized.includes("json") ||
    normalized.includes("xml") ||
    normalized.includes("javascript") ||
    normalized.includes("csv")
  );
}

export function classifyAttachment(input: {
  filename?: string;
  contentType?: string;
  disposition?: string;
  cid?: string;
}): Pick<EmailAttachmentSummary, "kind" | "isCalendarInvite" | "isSignature"> {
  const filename = input.filename?.toLowerCase() || "";
  const contentType = input.contentType?.toLowerCase() || "";
  const disposition = input.disposition?.toLowerCase() || "";
  const cid = input.cid?.toLowerCase() || "";

  const isCalendarInvite =
    contentType === "text/calendar" || filename.endsWith(".ics") || filename.endsWith(".ifb");
  const isSignature =
    filename === "smime.p7s" ||
    filename === "signature.asc" ||
    contentType.includes("pkcs7-signature") ||
    contentType.includes("pgp-signature");

  if (isCalendarInvite) {
    return { kind: "calendar", isCalendarInvite: true, isSignature: false };
  }
  if (isSignature) {
    return { kind: "signature", isCalendarInvite: false, isSignature: true };
  }
  if (contentType.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg)$/i.test(filename) || Boolean(cid)) {
    return { kind: "image", isCalendarInvite: false, isSignature: false };
  }
  if (contentType === "message/rfc822" || filename.endsWith(".eml") || filename.endsWith(".msg")) {
    return { kind: "message", isCalendarInvite: false, isSignature: false };
  }
  if (
    /\.(zip|gz|tgz|bz2|rar|7z)$/i.test(filename) ||
    contentType.includes("zip") ||
    contentType.includes("compressed") ||
    contentType.includes("archive")
  ) {
    return { kind: "archive", isCalendarInvite: false, isSignature: false };
  }
  if (isTextLikeMimeType(contentType) || /\.(txt|md|csv|json|xml|html?)$/i.test(filename)) {
    return { kind: "text", isCalendarInvite: false, isSignature: false };
  }
  if (
    /\.(pdf|docx?|xlsx?|pptx?)$/i.test(filename) ||
    contentType.includes("pdf") ||
    contentType.includes("officedocument") ||
    contentType.includes("msword") ||
    contentType.includes("spreadsheet") ||
    contentType.includes("presentation")
  ) {
    return { kind: "document", isCalendarInvite: false, isSignature: false };
  }
  if (disposition === "inline" && !filename) {
    return { kind: "image", isCalendarInvite: false, isSignature: false };
  }
  return { kind: "other", isCalendarInvite: false, isSignature: false };
}

export function summarizeCalendarText(value: string): string | undefined {
  const normalized = value.replace(/\r/g, "");
  const fields = new Map<string, string>();

  for (const line of normalized.split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).split(";")[0].trim().toUpperCase();
    const fieldValue = line.slice(separator + 1).trim();
    if (fieldValue && !fields.has(key)) {
      fields.set(key, fieldValue);
    }
  }

  const summary = [
    fields.get("SUMMARY"),
    fields.get("ORGANIZER"),
    fields.get("DTSTART") ? `Starts ${fields.get("DTSTART")}` : undefined,
    fields.get("DTEND") ? `Ends ${fields.get("DTEND")}` : undefined,
    fields.get("LOCATION") ? `Location ${fields.get("LOCATION")}` : undefined,
  ]
    .filter(Boolean)
    .join(" | ");

  return previewText(summary || normalized, 8_000);
}

export function normalizeMailboxLabel(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const decoded = decodeURIComponent(trimmed);
  const lower = decoded.toLowerCase();

  if (lower === "inbox") return "Inbox";
  if (lower === "archive") return "Archive";
  if (lower === "all mail") return "All Mail";
  if (lower === "sent" || lower === "sent mail") return "Sent";
  if (lower === "drafts") return "Drafts";
  if (lower === "spam" || lower === "junk") return "Spam";
  if (lower === "trash" || lower === "deleted messages") return "Trash";
  if (lower === "starred") return "Starred";
  if (decoded.startsWith("Labels/")) return decoded.slice("Labels/".length) || "Labels";

  return decoded;
}

/**
 * Convert a markdown string to HTML, returning both the rendered HTML and the original
 * markdown as a plain-text fallback. Handles the common patterns produced by AI assistants:
 * headings, bold/italic, inline code, fenced code blocks, links, ordered and unordered lists,
 * blockquotes, and horizontal rules.
 */
export function renderMarkdown(markdown: string): { html: string; text: string } {
  function escHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Protect fenced code blocks from inline processing
  const codeBlocks: string[] = [];
  let html = markdown.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(`<pre><code>${escHtml((code as string).trimEnd())}</code></pre>`);
    return `\x00CODE${codeBlocks.length - 1}\x00`;
  });

  // Protect inline code
  const inlineCodes: string[] = [];
  html = html.replace(/`([^`\n]+)`/g, (_, code) => {
    inlineCodes.push(`<code>${escHtml(code as string)}</code>`);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // Escape remaining HTML
  html = html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Process block-level elements line by line
  const lines = html.split("\n");
  const out: string[] = [];
  let listType: "ul" | "ol" | null = null;

  const closeList = (): void => {
    if (listType) {
      out.push(listType === "ul" ? "</ul>" : "</ol>");
      listType = null;
    }
  };

  for (const line of lines) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^### (.+)$/))) { closeList(); out.push(`<h3>${m[1]}</h3>`); continue; }
    if ((m = line.match(/^## (.+)$/)))  { closeList(); out.push(`<h2>${m[1]}</h2>`); continue; }
    if ((m = line.match(/^# (.+)$/)))   { closeList(); out.push(`<h1>${m[1]}</h1>`); continue; }
    if (/^-{3,}$/.test(line.trim()))    { closeList(); out.push("<hr>"); continue; }
    if ((m = line.match(/^&gt; (.+)$/))){ closeList(); out.push(`<blockquote>${m[1]}</blockquote>`); continue; }

    if ((m = line.match(/^[*-] (.+)$/))) {
      if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; }
      out.push(`<li>${m[1]}</li>`);
      continue;
    }
    if ((m = line.match(/^\d+\. (.+)$/))) {
      if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; }
      out.push(`<li>${m[1]}</li>`);
      continue;
    }

    closeList();
    if (!line.trim()) { out.push(""); continue; }
    out.push(`<p>${line}</p>`);
  }
  closeList();

  html = out.join("\n");

  // Inline formatting (order: bold+italic before bold before italic)
  html = html
    .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/~~(.+?)~~/g, "<del>$1</del>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
      const trimmedUrl = (url as string).trim();
      const safeUrl = /^(https?:|mailto:)/i.test(trimmedUrl) ? trimmedUrl : "#";
      // safeUrl still lands inside a double-quoted HTML attribute — a `"`
      // in the URL (e.g. http://example.com/" onmouseover="alert(1)) would
      // otherwise close the attribute early and let arbitrary attributes
      // get injected into the <a> tag. Found live: sent through with
      // sanitizeHtml:false (a real, documented opt-out path), the raw
      // outbound HTML contained the injected onmouseover attribute
      // verbatim. The default sanitizeHtml:true path already strips
      // unknown attributes as a backstop, but this must not depend on that
      // second layer holding.
      const escapedUrl = safeUrl.replace(/"/g, "&quot;");
      return `<a href="${escapedUrl}">${text}</a>`;
    });

  // Restore protected blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    html = html.replace(`\x00CODE${i}\x00`, codeBlocks[i]);
  }
  for (let i = 0; i < inlineCodes.length; i++) {
    html = html.replace(`\x00IC${i}\x00`, inlineCodes[i]);
  }

  return { html, text: markdown };
}

// Trims each item in a list response to just the requested fields, for callers
// that only need e.g. id/subject/from/date and don't want to pay the token cost
// of the full EmailSummary (preview, attachments, labels, flags, ...) on every
// row. "id" is always kept regardless of the requested field list, since it's
// what every follow-up tool call (get_email_by_id, star_email, ...) needs.
export function projectFields<T extends { id: string }>(
  items: T[],
  fields?: string[],
): T[] | Array<Partial<T>> {
  if (!fields || fields.length === 0) {
    return items;
  }

  const keep = new Set(["id", ...fields]);
  return items.map((item) =>
    Object.fromEntries(
      Object.entries(item).filter(([key]) => keep.has(key)),
    ) as Partial<T>,
  );
}
