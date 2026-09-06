import { createHash } from "node:crypto";
import type { MessageAddressObject, MessageStructureObject } from "imapflow";
import TurndownService from "turndown";
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

const EMAIL_ID_INVALID_MESSAGE =
  "Invalid emailId. Expected the email identifier returned by get_emails or search_emails.";

// Cheap, dependency-free integrity check on an emailId — not a security
// boundary (this doesn't defend against a determined attacker, just catches
// a corrupted, hand-edited, or hallucinated id before it silently resolves
// to whatever Number(garbage) happens to produce, possibly a real UID in
// the wrong folder). Deliberately keeps folder+uid human-readable in the id
// itself, rather than fully opaque-encoding them — unlike a model-only MCP
// server, this codebase has a CLI meant for direct human use, and every log
// line, audit entry, and error message shows raw emailIds; a base64 blob
// would be a real debuggability regression for that, not just a style
// choice. `folder` is the encodeURIComponent'd segment, not the decoded
// name, so the checksum also catches a folder segment tampered with after
// encoding (encodeURIComponent output never contains "::" itself, since it
// escapes ":", so this can't collide with the separator).
function computeEmailIdChecksum(encodedFolder: string, uid: number): string {
  return createHash("sha256").update(`${encodedFolder}${EMAIL_ID_SEPARATOR}${uid}`).digest("hex").slice(0, 8);
}

export function createEmailId(folder: string, uid: number): string {
  const encodedFolder = encodeURIComponent(folder);
  const checksum = computeEmailIdChecksum(encodedFolder, uid);
  return `${encodedFolder}${EMAIL_ID_SEPARATOR}${uid}${EMAIL_ID_SEPARATOR}${checksum}`;
}

export function parseEmailId(emailId: string): { folder: string; uid: number } {
  const lastSep = emailId.lastIndexOf(EMAIL_ID_SEPARATOR);
  if (lastSep === -1) {
    throw new Error(EMAIL_ID_INVALID_MESSAGE);
  }

  const trailing = emailId.slice(lastSep + EMAIL_ID_SEPARATOR.length);
  const payload = emailId.slice(0, lastSep);
  const midSep = payload.lastIndexOf(EMAIL_ID_SEPARATOR);

  // New format: <encodedFolder>::<uid>::<checksum> — verify before trusting.
  if (midSep !== -1) {
    const encodedFolder = payload.slice(0, midSep);
    const uidPart = payload.slice(midSep + EMAIL_ID_SEPARATOR.length);
    const uid = Number(uidPart);
    if (Number.isInteger(uid) && uid > 0 && computeEmailIdChecksum(encodedFolder, uid) === trailing) {
      // The checksum already proves encodedFolder+uid are exactly what
      // createEmailId originally encoded — a truthy-check on the decoded
      // folder here only rejected a cryptographically-verified id whenever
      // that folder happened to be "" (falls through to the legacy branch
      // below, which then parses garbage off the wrong separator and
      // throws). Trust the checksum, not an incidental truthiness check.
      return { folder: decodeURIComponent(encodedFolder), uid };
    }
  }

  // Backward compat: ids persisted before the checksum suffix was added —
  // <encodedFolder>::<uid>, no checksum. These can live indefinitely in
  // drafts.json/snoozed.json/delivery-queue.json, resolved long after the
  // process that wrote them exits, so old ids must keep working — no
  // integrity check is possible on this legacy shape, same as before.
  const folder = decodeURIComponent(payload);
  const uid = Number(trailing);
  if (folder && Number.isInteger(uid) && uid > 0) {
    return { folder, uid };
  }

  throw new Error(EMAIL_ID_INVALID_MESSAGE);
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

let markdownConverter: TurndownService | undefined;

function getMarkdownConverter(): TurndownService {
  if (markdownConverter) {
    return markdownConverter;
  }

  markdownConverter = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  // Inline image syntax (![alt](src)) would dump the raw src URL into the
  // token stream — often a long tracking-pixel URL with no value to a
  // model reading the message. Keep the alt text as a plain marker instead.
  markdownConverter.addRule("image-as-marker", {
    filter: "img",
    replacement: (_content, node) => {
      const alt = (node as unknown as { getAttribute?: (name: string) => string | null }).getAttribute?.("alt");
      return alt ? `[image: ${alt}]` : "[image]";
    },
  });

  return markdownConverter;
}

// Structure-preserving alternative to stripHtmlToText, for HTML-only emails
// (no text/plain alternative part) — this is the fallback path in
// getParsedMailDetail, not a replacement for a sender's own authored plain
// text. Markdown keeps links, lists, and emphasis instead of discarding
// them, and (per real-world comparison against other Proton MCP servers)
// costs meaningfully fewer tokens than passing raw HTML to a model.
export function htmlToMarkdown(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  let markdown: string;
  try {
    markdown = getMarkdownConverter().turndown(value);
  } catch {
    // Malformed HTML turndown can't parse — fall back to the plain-text
    // stripper rather than surfacing an error for what's still readable mail.
    return stripHtmlToText(value);
  }

  // Not previewText: previewText collapses all whitespace to single spaces,
  // which would erase the newlines Markdown structure depends on (headings,
  // list items, paragraph breaks). Cap length only.
  const trimmed = markdown.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > 10_000 ? `${trimmed.slice(0, 10_000)}...` : trimmed;
}

const QUOTE_BOUNDARY_LINE = /^>*\s*On .{0,160}\bwrote:\s*$/i;
const ORIGINAL_MESSAGE_BANNER = /^-{2,}\s*Original Message\s*-{2,}$/i;
// Some clients (Outlook-style) quote without either boundary line above —
// only ">"-prefixed lines. Only fold on a run this long so a one-line
// inline quote ("> just this part, right?") is left untouched.
const MIN_UNMARKED_QUOTE_RUN = 4;

function findQuoteBoundary(lines: string[]): number {
  for (let index = 0; index < lines.length; index += 1) {
    if (QUOTE_BOUNDARY_LINE.test(lines[index]) || ORIGINAL_MESSAGE_BANNER.test(lines[index])) {
      return index;
    }
  }

  let run = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim().startsWith(">")) {
      run += 1;
      if (run >= MIN_UNMARKED_QUOTE_RUN) {
        return index - run + 1;
      }
    } else if (lines[index].trim() !== "") {
      run = 0;
    }
  }

  return -1;
}

// Collapses a trailing quoted-reply block — "On <date>, <name> wrote:" (or
// an Outlook-style "-----Original Message-----" banner, or a long run of
// unmarked ">" lines) followed by everything after it — into a short
// marker instead of repeating potentially many prior replies' worth of
// text. Only ever touches a TRAILING run starting at the first recognized
// boundary; a quote appearing earlier in the body (e.g. one line quoted
// inline to respond to it) is left completely alone. Comparison against
// other Proton MCP servers found this is real, avoidable token bloat on
// any single deep-thread message, not just when reading several at once.
export function foldQuotedHistory(text: string): string {
  const lines = text.split(/\r?\n/);
  const boundary = findQuoteBoundary(lines);
  if (boundary === -1) {
    return text;
  }

  const kept = lines.slice(0, boundary).join("\n").trimEnd();
  const folded = lines.slice(boundary);
  const foldedLineCount = folded.filter((line) => line.trim() !== "").length;
  if (foldedLineCount === 0) {
    return text;
  }

  const marker = `[${foldedLineCount} line${foldedLineCount === 1 ? "" : "s"} of quoted earlier message(s) folded]`;
  return kept ? `${kept}\n\n${marker}` : marker;
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
// Generic per-call bound, no side effects (unlike SimpleIMAPService's own
// withTimeout, which additionally force-disconnects its IMAP client — not
// meaningful here). Used by services whose per-item background loops
// (delivery queue sends, snooze wakes) had no timeout at all: one wedged
// call used to silently stall every other queued item indefinitely, since
// each loop's next tick only re-arms after the current pass fully settles.
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

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
