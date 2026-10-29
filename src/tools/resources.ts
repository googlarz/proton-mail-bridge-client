// The protonmail:// resources: addresses for a message, a thread, a draft and an attachment, the citation links a tool result carries, and the text a client gets when it reads one.

import { formatAddressList } from "./compose.js";
import { type EmailSummary, type CitationSource, type EmailAddress, type DraftRecord, type EmailDetail } from "../types/index.js";
export const RESOURCE_SCHEME = "protonmail";

export function buildEmailResourceUri(emailId: string): string {
  return `${RESOURCE_SCHEME}://email/${encodeURIComponent(emailId)}`;
}

export function buildThreadResourceUri(threadId: string): string {
  return `${RESOURCE_SCHEME}://thread/${encodeURIComponent(threadId)}`;
}

export function buildDraftResourceUri(draftId: string): string {
  return `${RESOURCE_SCHEME}://draft/${encodeURIComponent(draftId)}`;
}

/** The one resource a client can subscribe to: what happened on the accounts (get_events as a resource). */
export function buildEventsResourceUri(): string {
  return `${RESOURCE_SCHEME}://events`;
}

export function buildAttachmentResourceUri(emailId: string, attachmentId: string): string {
  return `${RESOURCE_SCHEME}://attachment/${encodeURIComponent(emailId)}/${encodeURIComponent(attachmentId)}`;
}

export function emailSource(
  email: Pick<EmailSummary, "id" | "subject" | "folder"> &
    Partial<Pick<EmailSummary, "date" | "internalDate" | "messageId" | "threadId" | "preview" | "from">>,
): CitationSource {
  const fromText = email.from && email.from.length > 0 ? formatAddressList(email.from) : undefined;
  return {
    uri: buildEmailResourceUri(email.id),
    name: email.id,
    title: email.subject,
    description: [email.folder, email.internalDate || email.date || "undated", fromText].filter(Boolean).join(" · "),
    mimeType: "message/rfc822",
    provider: "proton-bridge-imap",
    snippet: email.preview,
    locator: {
      kind: "email",
      emailId: email.id,
      folder: email.folder,
      messageId: email.messageId,
      threadId: email.threadId,
      from: fromText,
      subject: email.subject,
      date: email.internalDate || email.date,
    },
  };
}

export function threadSource(thread: {
  id: string;
  subject: string;
  latestDate?: string;
  messageCount: number;
  normalizedLabels?: string[];
  participants?: EmailAddress[];
}): CitationSource {
  return {
    uri: buildThreadResourceUri(thread.id),
    name: thread.id,
    title: thread.subject,
    description: `${thread.messageCount} message(s) · ${thread.latestDate || "undated"}`,
    mimeType: "text/markdown",
    provider: "local-index",
    snippet: thread.participants && thread.participants.length > 0 ? formatAddressList(thread.participants) : undefined,
    locator: {
      kind: "thread",
      threadId: thread.id,
      normalizedLabels: thread.normalizedLabels,
      participants: thread.participants?.map((entry) => entry.address || entry.name).filter(Boolean),
    },
  };
}

export function draftSource(draft: DraftRecord): CitationSource {
  return {
    uri: buildDraftResourceUri(draft.id),
    name: draft.id,
    title: draft.subject,
    description: `${draft.status} · updated ${draft.updatedAt}`,
    mimeType: "text/markdown",
    provider: "local-draft-store",
    locator: {
      kind: "draft",
      draftId: draft.id,
      remoteEmailId: draft.remoteDraft?.emailId,
    },
  };
}

export function attachmentSource(
  emailId: string,
  attachment: NonNullable<EmailDetail["attachments"]>[number],
): CitationSource {
  const attachmentId = attachment.id || attachment.filename || "attachment";
  return {
    uri: buildAttachmentResourceUri(emailId, attachmentId),
    name: attachmentId,
    title: attachment.filename || attachmentId,
    description: `${attachment.contentType || "application/octet-stream"} · ${attachment.size || 0} bytes`,
    mimeType: attachment.contentType || "application/octet-stream",
    provider: "proton-bridge-imap",
    locator: {
      kind: "attachment",
      emailId,
      attachmentId,
      filename: attachment.filename,
    },
  };
}

export function formatEmailResource(detail: EmailDetail): string {
  return [
    `# ${detail.subject}`,
    "",
    `- Email ID: ${detail.id}`,
    detail.messageId ? `- Message-ID: ${detail.messageId}` : "",
    detail.threadId ? `- Thread ID: ${detail.threadId}` : "",
    detail.references && detail.references.length > 0 ? `- References: ${detail.references.join(", ")}` : "",
    `- Folder: ${detail.folder}`,
    `- Date: ${detail.internalDate || detail.date || "unknown"}`,
    `- From: ${formatAddressList(detail.from) || "unknown"}`,
    `- To: ${formatAddressList(detail.to) || "unknown"}`,
    detail.cc.length > 0 ? `- Cc: ${formatAddressList(detail.cc)}` : "",
    "",
    detail.text || detail.preview || "(no body text available)",
    detail.attachmentText ? "" : "",
    detail.attachmentText ? "## Attachment Text" : "",
    detail.attachmentText || "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatThreadResource(thread: {
  id: string;
  subject: string;
  latestDate?: string;
  normalizedLabels: string[];
  messages: Array<Pick<EmailDetail, "id" | "subject" | "from" | "date" | "internalDate" | "preview">>;
}): string {
  return [
    `# ${thread.subject}`,
    "",
    `- Thread ID: ${thread.id}`,
    `- Latest: ${thread.latestDate || "unknown"}`,
    `- Labels: ${thread.normalizedLabels.join(", ") || "(none)"}`,
    "",
    ...thread.messages.flatMap((message) => [
      `## ${message.subject}`,
      `- Email ID: ${message.id}`,
      `- From: ${formatAddressList(message.from) || "unknown"}`,
      `- Date: ${message.internalDate || message.date || "unknown"}`,
      "",
      message.preview || "(no preview)",
      "",
    ]),
  ].join("\n");
}

export function formatDraftResource(draft: DraftRecord): string {
  return [
    `# ${draft.subject}`,
    "",
    `- Draft ID: ${draft.id}`,
    `- Status: ${draft.status}`,
    `- Mode: ${draft.mode}`,
    `- Updated: ${draft.updatedAt}`,
    `- Remote Sync: ${draft.remoteSyncState}`,
    draft.remoteDraft?.emailId ? `- Remote Email ID: ${draft.remoteDraft.emailId}` : "",
    `- To: ${draft.to.join(", ") || "(none)"}`,
    draft.cc.length > 0 ? `- Cc: ${draft.cc.join(", ")}` : "",
    draft.bcc.length > 0 ? `- Bcc: ${draft.bcc.join(", ")}` : "",
    "",
    draft.body,
  ]
    .filter(Boolean)
    .join("\n");
}

export type ParsedResourceUri =
  | { kind: "email"; emailId: string }
  | { kind: "thread"; threadId: string }
  | { kind: "draft"; draftId: string }
  | { kind: "attachment"; emailId: string; attachmentId: string }
  | { kind: "events" };

export function parseResourceUri(uri: string): ParsedResourceUri {
  const parsed = new URL(uri);
  if (parsed.protocol !== `${RESOURCE_SCHEME}:`) {
    throw new Error(`Unsupported resource URI: ${uri}`);
  }

  const segments = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));

  switch (parsed.hostname) {
    case "email":
      if (segments.length !== 1) {
        break;
      }
      return { kind: "email", emailId: segments[0] };
    case "thread":
      if (segments.length !== 1) {
        break;
      }
      return { kind: "thread", threadId: segments[0] };
    case "draft":
      if (segments.length !== 1) {
        break;
      }
      return { kind: "draft", draftId: segments[0] };
    case "events":
      if (segments.length !== 0) {
        break;
      }
      return { kind: "events" };
    case "attachment":
      if (segments.length !== 2) {
        break;
      }
      return { kind: "attachment", emailId: segments[0], attachmentId: segments[1] };
    default:
      break;
  }

  throw new Error(`Unsupported resource URI: ${uri}`);
}
