import Database from "better-sqlite3";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ActionableThreadSummary,
  EmailSummary,
  FolderInfo,
  MailboxLabel,
  MailboxMessage,
  MailboxMessageLocation,
  LocalIndexStatus,
  MailboxSyncCheckpoint,
  ProtonMailConfig,
  SearchEmailsInput,
  ThreadDetail,
  ThreadSummary,
} from "../types/index.js";
import {
  dedupeEmails,
  extractDomain,
  extractMessageIdList,
  lowerCaseAddress,
  nextDay,
  normalizeMailboxLabel,
  normalizeMessageId,
  normalizeSubjectForThread,
  sortEmailsByNewest,
} from "../utils/helpers.js";
import { logger, type Logger } from "../utils/logger.js";

interface IndexedFolderState {
  path: string;
  messages?: number;
  unseen?: number;
  specialUse?: string;
  lastIndexedAt?: string;
  lastIndexedCount?: number;
}

interface LegacyLocalIndexFile {
  version: number;
  ownerEmail?: string;
  updatedAt?: string;
  folders: FolderInfo[];
  indexedFolders: Record<string, IndexedFolderState>;
  messages: Record<string, EmailSummary>;
}

interface SnapshotData {
  ownerEmail?: string;
  updatedAt?: string;
  folders: FolderInfo[];
  indexedFolders: IndexedFolderState[];
  syncCheckpoints: MailboxSyncCheckpoint[];
  messages: EmailSummary[];
}

type MessageRow = {
  email_id: string;
  folder: string;
  uid: number;
  seq: number;
  message_id: string | null;
  in_reply_to: string | null;
  references_json: string | null;
  thread_id: string | null;
  subject: string;
  from_json: string;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  reply_to_json: string;
  date: string | null;
  internal_date: string | null;
  is_read: number;
  is_starred: number;
  flags_json: string;
  size: number | null;
  preview: string | null;
  has_attachments: number;
  attachments_json: string;
  attachment_text: string | null;
  labels_json: string;
};

const DB_SCHEMA_VERSION = 3;
const STALE_THRESHOLD_MINUTES = 60;
const DEFAULT_SNAPSHOT_LIMIT = 5000;

function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

interface SnapshotLoadOptions {
  limit?: number;
  offset?: number;
  folder?: string;
  label?: string;
  isRead?: boolean;
  since?: string;
}

type ParsedSearchQuery = {
  residualTerms: string[];
  senderDomain?: string;
  label?: string;
  from?: string;
  to?: string;
  subject?: string;
};

function parseSearchQuery(query?: string): ParsedSearchQuery {
  const parsed: ParsedSearchQuery = { residualTerms: [] };

  for (const rawToken of query?.trim().split(/\s+/) ?? []) {
    const separator = rawToken.indexOf(":");
    if (separator <= 0) {
      parsed.residualTerms.push(rawToken);
      continue;
    }

    const key = rawToken.slice(0, separator).toLowerCase();
    const value = rawToken.slice(separator + 1).trim();
    if (!value) {
      continue;
    }

    switch (key) {
      case "domain":
      case "fromdomain":
        parsed.senderDomain = value.toLowerCase();
        break;
      case "label":
        parsed.label = value;
        break;
      case "from":
        parsed.from = value;
        break;
      case "to":
        parsed.to = value;
        break;
      case "subject":
        parsed.subject = value;
        break;
      default:
        parsed.residualTerms.push(rawToken);
        break;
    }
  }

  return parsed;
}

function matchesIndexedSearch(email: EmailSummary, filters: SearchEmailsInput): boolean {
  const parsedQuery = parseSearchQuery(filters.query);
  const normalizedFilters: SearchEmailsInput = {
    ...filters,
    query: parsedQuery.residualTerms.join(" ") || undefined,
    senderDomain: filters.senderDomain || parsedQuery.senderDomain,
    label: filters.label || parsedQuery.label,
    from: filters.from || parsedQuery.from,
    to: filters.to || parsedQuery.to,
    subject: filters.subject || parsedQuery.subject,
  };

  if (normalizedFilters.folder && email.folder !== normalizedFilters.folder) {
    return false;
  }

  if (normalizedFilters.label) {
    const labelNeedle = normalizedFilters.label.toLowerCase();
    const folderMatch = normalizeMailboxLabel(email.folder)?.toLowerCase() === labelNeedle;
    const labelMatch = email.labels.some(
      (label) => normalizeMailboxLabel(label)?.toLowerCase() === labelNeedle,
    );
    if (!folderMatch && !labelMatch) {
      return false;
    }
  }

  if (normalizedFilters.threadId && email.threadId !== normalizedFilters.threadId) {
    return false;
  }

  // Was accepted and documented by search_indexed_emails's schema
  // ("Normalized mailbox role like Inbox, Sent, Archive, or Trash") but
  // never actually checked here — every call silently ignored it and
  // returned matches from any folder. The live-IMAP search_emails path
  // (matchesLocalSearchFilters in utils/helpers.ts) already implements this
  // correctly; mirrored here.
  if (normalizedFilters.mailboxRole) {
    const roleNeedle = normalizedFilters.mailboxRole.toLowerCase();
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

  if (
    typeof normalizedFilters.hasAttachment === "boolean" &&
    email.hasAttachments !== normalizedFilters.hasAttachment
  ) {
    return false;
  }

  if (normalizedFilters.attachmentName) {
    const attachmentNeedle = normalizedFilters.attachmentName.toLowerCase();
    const match = email.attachments.some((attachment) =>
      (attachment.filename || "").toLowerCase().includes(attachmentNeedle),
    );
    if (!match) {
      return false;
    }
  }

  if (typeof normalizedFilters.isRead === "boolean" && email.isRead !== normalizedFilters.isRead) {
    return false;
  }

  if (typeof normalizedFilters.isStarred === "boolean" && email.isStarred !== normalizedFilters.isStarred) {
    return false;
  }

  const haystacks = [
    email.subject,
    email.preview ?? "",
    email.attachmentText ?? "",
    email.folder,
    email.labels.join(" "),
    ...email.from.map((value) => `${value.name ?? ""} ${value.address ?? ""}`),
    ...email.to.map((value) => `${value.name ?? ""} ${value.address ?? ""}`),
    ...email.cc.map((value) => `${value.name ?? ""} ${value.address ?? ""}`),
  ]
    .join("\n")
    .toLowerCase();

  if (normalizedFilters.query && !haystacks.includes(normalizedFilters.query.toLowerCase())) {
    return false;
  }

  if (
    normalizedFilters.subject &&
    !email.subject.toLowerCase().includes(normalizedFilters.subject.toLowerCase())
  ) {
    return false;
  }

  if (normalizedFilters.from) {
    const fromNeedle = normalizedFilters.from.toLowerCase();
    const match = email.from.some((value) =>
      `${value.name ?? ""} ${value.address ?? ""}`.toLowerCase().includes(fromNeedle),
    );
    if (!match) {
      return false;
    }
  }

  if (normalizedFilters.to) {
    const toNeedle = normalizedFilters.to.toLowerCase();
    const recipients = [...email.to, ...email.cc, ...email.bcc];
    const match = recipients.some((value) =>
      `${value.name ?? ""} ${value.address ?? ""}`.toLowerCase().includes(toNeedle),
    );
    if (!match) {
      return false;
    }
  }

  if (normalizedFilters.senderDomain) {
    const match = email.from.some(
      (value) => extractDomain(value.address || "") === normalizedFilters.senderDomain,
    );
    if (!match) {
      return false;
    }
  }

  const emailDate = email.internalDate || email.date;
  if (normalizedFilters.dateFrom && emailDate) {
    if (new Date(emailDate).getTime() < new Date(normalizedFilters.dateFrom).getTime()) {
      return false;
    }
  }

  if (normalizedFilters.dateTo && emailDate) {
    // Exclusive upper bound at the start of the next day — see the
    // identical fix and rationale on the SQL dateTo condition above.
    if (new Date(emailDate).getTime() >= nextDay(new Date(normalizedFilters.dateTo)).getTime()) {
      return false;
    }
  }

  return true;
}

function canonicalMessageKey(email: EmailSummary): string {
  const messageId = normalizeMessageId(email.messageId);
  if (messageId) {
    return messageId;
  }

  const fromAddress = lowerCaseAddress(email.from[0]?.address) || "unknown";
  const dateBucket = email.internalDate || email.date || String(email.uid);
  return `${normalizeSubjectForThread(email.subject).toLowerCase()}::${fromAddress}::${dateBucket}`;
}

function threadKeyForEmail(email: EmailSummary): string {
  if (email.threadId?.trim()) {
    return `imap:${email.threadId.trim()}`;
  }
  return fallbackThreadKey(email);
}

function specialUseToRole(specialUse?: string, folderPath?: string): string {
  switch (specialUse) {
    case "\\Inbox":
      return "inbox";
    case "\\Sent":
      return "sent";
    case "\\Drafts":
      return "drafts";
    case "\\Trash":
      return "trash";
    case "\\Archive":
      return "archive";
    case "\\Junk":
      return "spam";
    default:
      return normalizeMailboxLabel(folderPath)?.toLowerCase() || "folder";
  }
}

function friendlySpecialUse(specialUse?: string): string | undefined {
  return normalizeMailboxLabel(specialUse?.replace(/^\\/, ""));
}

function normalizedMailboxLabelsFor(email: EmailSummary, folder?: FolderInfo): string[] {
  const labels = new Set<string>();

  const add = (value?: string) => {
    const normalized = normalizeMailboxLabel(value);
    if (normalized) {
      labels.add(normalized);
    }
  };

  add(email.folder);
  for (const label of email.labels) {
    add(label);
  }
  add(folder?.specialUse?.replace(/^\\/, ""));

  const pathParts = email.folder.split("/");
  if (pathParts.length > 1) {
    add(pathParts[pathParts.length - 1]);
  }

  return [...labels].sort((left, right) => left.localeCompare(right));
}

function locationScore(location: { email: EmailSummary; folder?: FolderInfo }): number {
  const specialUse = location.folder?.specialUse;
  let score = 0;

  switch (specialUse) {
    case "\\Inbox":
      score += 100;
      break;
    case "\\Sent":
      score += 80;
      break;
    case "\\Drafts":
      score += 70;
      break;
    case "\\Archive":
      score += 50;
      break;
    case "\\Trash":
      score += 10;
      break;
    default:
      score += 40;
      break;
  }

  if (!location.email.isRead) {
    score += 3;
  }
  if (location.email.hasAttachments) {
    score += 1;
  }
  if (location.email.isStarred) {
    score += 2;
  }

  return score;
}

function uniqueParticipants(messages: EmailSummary[]): MailboxMessage["from"] {
  const seen = new Set<string>();
  const participants: MailboxMessage["from"] = [];

  for (const message of messages) {
    for (const address of [...message.from, ...message.to, ...message.cc]) {
      const key = lowerCaseAddress(address.address) || address.name?.trim().toLowerCase();
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      participants.push(address);
    }
  }

  return participants;
}

function isOutgoingMessage(message: Pick<EmailSummary, "from">, ownerEmail?: string): boolean {
  const owner = lowerCaseAddress(ownerEmail);
  if (!owner) {
    return false;
  }

  return message.from.some((address) => lowerCaseAddress(address.address) === owner);
}

function actionableThreadScore(
  thread: ThreadDetail,
  ownerEmail?: string,
): {
  pendingOn: ActionableThreadSummary["pendingOn"];
  score: number;
} {
  const latestMessage = thread.messages[thread.messages.length - 1];
  const latestIsOutgoing = latestMessage ? isOutgoingMessage(latestMessage, ownerEmail) : false;
  const pendingOn: ActionableThreadSummary["pendingOn"] = latestMessage
    ? latestIsOutgoing
      ? "them"
      : "you"
    : "unknown";

  let score = 0;
  score += thread.unreadCount * 10;
  if (pendingOn === "you") {
    score += 8;
  }
  if (latestMessage?.isStarred) {
    score += 4;
  }
  if (latestMessage?.hasAttachments) {
    score += 2;
  }

  const latestTime = new Date(thread.latestDate || 0).getTime();
  if (latestTime > 0) {
    const ageHours = (Date.now() - latestTime) / (60 * 60 * 1000);
    if (ageHours > 24) {
      score += 3;
    } else if (ageHours > 4) {
      score += 1;
    }
  }

  return { pendingOn, score };
}

function safeJsonParse<T>(value: string | null, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function emailToSearchParts(email: EmailSummary): {
  labels: string;
  participants: string;
  attachmentNames: string;
} {
  return {
    labels: [normalizeMailboxLabel(email.folder) || email.folder, ...email.labels.map((label) => normalizeMailboxLabel(label) || label)].join(" "),
    participants: [...email.from, ...email.to, ...email.cc, ...email.bcc]
      .map((value) => `${value.name ?? ""} ${value.address ?? ""} ${extractDomain(value.address || "") ?? ""}`.trim())
      .join(" "),
    attachmentNames: [
      ...email.attachments.map((attachment) => attachment.filename || ""),
      ...email.attachments.map((attachment) => attachment.kind || ""),
      email.attachmentText || "",
    ]
      .join(" ")
      .trim(),
  };
}

function participantThreadSignature(message: EmailSummary, ownerEmail?: string): string {
  const owner = lowerCaseAddress(ownerEmail);
  const addresses = [...message.from, ...message.to, ...message.cc]
    .map((entry) => lowerCaseAddress(entry.address))
    .filter((entry): entry is string => Boolean(entry));
  const counterparties = owner ? addresses.filter((entry) => entry !== owner) : addresses;
  const signatureSource = counterparties.length > 0 ? counterparties : addresses;
  const signature = [...new Set(signatureSource)].sort().slice(0, 4).join("|");
  return signature || "unknown";
}

function fallbackThreadKey(message: EmailSummary, ownerEmail?: string): string {
  return `subject:${normalizeSubjectForThread(message.subject).toLowerCase()}::${participantThreadSignature(
    message,
    ownerEmail,
  )}`;
}

function searchRelevanceScore(email: EmailSummary, filters: SearchEmailsInput): number {
  const parsedQuery = parseSearchQuery(filters.query);
  const residual = parsedQuery.residualTerms.join(" ").toLowerCase();
  const fullParticipants = [...email.from, ...email.to, ...email.cc, ...email.bcc]
    .map((value) => `${value.name ?? ""} ${value.address ?? ""}`.trim().toLowerCase())
    .join("\n");
  let score = 0;

  if (residual) {
    if (email.subject.toLowerCase().includes(residual)) score += 12;
    if ((email.preview || "").toLowerCase().includes(residual)) score += 8;
    if ((email.attachmentText || "").toLowerCase().includes(residual)) score += 5;
    if (fullParticipants.includes(residual)) score += 6;
  }
  if ((filters.senderDomain || parsedQuery.senderDomain) && email.from.some((entry) => extractDomain(entry.address || "") === (filters.senderDomain || parsedQuery.senderDomain))) {
    score += 4;
  }
  if (email.hasAttachments) score += 1;
  if (!email.isRead) score += 2;
  if (email.isStarred) score += 2;

  const timestamp = new Date(email.internalDate || email.date || 0).getTime();
  if (timestamp > 0) {
    const ageHours = Math.max(0, (Date.now() - timestamp) / (60 * 60 * 1000));
    score += Math.max(0, 3 - ageHours / 48);
  }

  return score;
}

export class LocalIndexService {
  private readonly dbPath: string;
  private readonly legacyIndexPath: string;
  private db?: Database.Database;
  private initialized = false;

  constructor(
    private readonly config: ProtonMailConfig,
    private readonly log: Logger = logger,
  ) {
    this.dbPath = join(this.config.dataDir, "mail-index.sqlite");
    this.legacyIndexPath = join(this.config.dataDir, "mail-index.json");
  }

  async recordSnapshot(input: {
    folders: FolderInfo[];
    emails: EmailSummary[];
    syncedAt: string;
    folderStats: Array<MailboxSyncCheckpoint>;
  }): Promise<LocalIndexStatus> {
    const db = await this.ensureDb();
    const ownerEmail = lowerCaseAddress(this.config.smtp.username);
    this.applySnapshot(db, input, ownerEmail, input.folderStats.some((entry) => entry.strategy === "full"));
    return this.getStatus();
  }

  async getStatus(): Promise<LocalIndexStatus> {
    const snapshot = await this.loadSnapshot();
    return this.toStatus(snapshot);
  }

  async search(filters: SearchEmailsInput): Promise<{
    total: number;
    hasMore: boolean;
    emails: EmailSummary[];
    lastSyncAt?: string;
    indexFreshnessMinutes?: number;
    warnings?: string[];
  }> {
    const parsedQuery = parseSearchQuery(filters.query);
    const normalizedFilters: SearchEmailsInput = {
      ...filters,
      query: parsedQuery.residualTerms.join(" ") || undefined,
      senderDomain: filters.senderDomain || parsedQuery.senderDomain,
      label: filters.label || parsedQuery.label,
      from: filters.from || parsedQuery.from,
      to: filters.to || parsedQuery.to,
      subject: filters.subject || parsedQuery.subject,
    };
    const limit = normalizedFilters.limit ?? 100;
    const offset = 0;

    if (normalizedFilters.threadId?.trim()) {
      const snapshot = await this.loadSnapshot({
        folder: normalizedFilters.folder,
        isRead: normalizedFilters.isRead,
        since: normalizedFilters.dateFrom,
      });
      const thread = (this.buildThreads(snapshot, true) as ThreadDetail[]).find(
        (entry) => entry.id === normalizedFilters.threadId,
      );
      if (thread) {
        const freshnessFields = this.indexFreshnessFields(snapshot.updatedAt);
        const threadMessages = sortEmailsByNewest(thread.messages).filter((email) =>
          matchesIndexedSearch(email, { ...normalizedFilters, threadId: undefined }),
        ).sort((left, right) => searchRelevanceScore(right, normalizedFilters) - searchRelevanceScore(left, normalizedFilters));
        const totalCount = threadMessages.length;
        return {
          total: totalCount,
          hasMore: totalCount > offset + limit,
          emails: threadMessages.slice(offset, offset + limit),
          ...freshnessFields,
        };
      }
    }

    const db = await this.ensureDb();
    const lastSyncAt = this.readLastSyncAt(db);
    const warnings: string[] = [];
    const emails = this.loadCandidateEmails(db, normalizedFilters, Math.max(limit * 10, 500), warnings);
    const matches = dedupeEmails(emails)
      .filter((email) => matchesIndexedSearch(email, normalizedFilters))
      .sort((left, right) => {
        const scoreDelta = searchRelevanceScore(right, normalizedFilters) - searchRelevanceScore(left, normalizedFilters);
        if (scoreDelta !== 0) {
          return scoreDelta;
        }
        return sortEmailsByNewest([left, right])[0] === left ? -1 : 1;
      });
    const totalCount = matches.length;

    return {
      total: totalCount,
      hasMore: totalCount > offset + limit,
      emails: matches.slice(offset, offset + limit),
      ...this.indexFreshnessFields(lastSyncAt),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  async clear(): Promise<{ path: string; removed: boolean }> {
    this.closeDb();
    let removed = false;

    for (const path of [this.dbPath, this.legacyIndexPath]) {
      try {
        await rm(path);
        removed = true;
      } catch (error) {
        if (
          !(
            error &&
            typeof error === "object" &&
            "code" in error &&
            (error as { code?: string }).code === "ENOENT"
          )
        ) {
          throw error;
        }
      }
    }

    return { path: this.dbPath, removed };
  }

  async listRecentMessages(limit = 50): Promise<MailboxMessage[]> {
    const snapshot = await this.loadSnapshot();
    return this.buildMailboxMessages(snapshot).slice(0, limit);
  }

  async getLabels(limit = 250): Promise<MailboxLabel[]> {
    const snapshot = await this.loadSnapshot();
    const messages = this.buildMailboxMessages(snapshot);
    const counts = new Map<
      string,
      {
        label: MailboxLabel;
        threadIds: Set<string>;
      }
    >();

    for (const message of messages) {
      const folderInfo = snapshot.folders.find((folder) => folder.path === message.folder);
      const addCount = (
        id: string,
        name: string,
        type: MailboxLabel["type"],
        specialUse?: string,
      ): void => {
        const existing = counts.get(id) ?? {
          label: {
            id,
            name,
            type,
            messageCount: 0,
            unreadCount: 0,
            threadCount: 0,
            specialUse,
          },
          threadIds: new Set<string>(),
        };

        existing.label.messageCount += 1;
        if (!message.isRead) {
          existing.label.unreadCount += 1;
        }
        existing.threadIds.add(message.threadKey);
        existing.label.threadCount = existing.threadIds.size;
        counts.set(id, existing);
      };

      const normalizedFolderName = normalizeMailboxLabel(message.folder) || message.folder;
      addCount(
        `folder:${normalizedFolderName.toLowerCase()}`,
        normalizedFolderName,
        "folder",
        folderInfo?.specialUse,
      );

      if (folderInfo?.specialUse) {
        const friendly = friendlySpecialUse(folderInfo.specialUse) || folderInfo.specialUse;
        addCount(`special:${friendly.toLowerCase()}`, friendly, "special_use", folderInfo.specialUse);
      }

      for (const label of message.normalizedLabels) {
        addCount(`label:${label.toLowerCase()}`, label, "label");
      }
    }

    return [...counts.values()]
      .map((entry) => entry.label)
      .sort((left, right) => {
        if (right.messageCount !== left.messageCount) {
          return right.messageCount - left.messageCount;
        }
        return left.name.localeCompare(right.name);
      })
      .slice(0, limit);
  }

  async getThreads(input: { query?: string; folder?: string; label?: string; limit?: number } = {}): Promise<{
    total: number;
    hasMore: boolean;
    threads: ThreadSummary[];
    lastSyncAt?: string;
    indexFreshnessMinutes?: number;
  }> {
    const snapshot = await this.loadSnapshot({ folder: input.folder, label: input.label });
    const threads = this.buildThreads(snapshot).filter((thread) => {
      if (input.label) {
        const labelNeedle = input.label.toLowerCase();
        if (!thread.normalizedLabels.some((label) => label.toLowerCase() === labelNeedle)) {
          return false;
        }
      }

      if (input.query) {
        const haystack = [
          thread.subject,
          ...thread.participants.map((participant) => `${participant.name ?? ""} ${participant.address ?? ""}`),
          ...thread.normalizedLabels,
        ]
          .join("\n")
          .toLowerCase();
        if (!haystack.includes(input.query.toLowerCase())) {
          return false;
        }
      }

      return true;
    });

    const limit = input.limit ?? 100;
    const offset = 0;
    const totalCount = threads.length;
    return {
      total: totalCount,
      hasMore: totalCount > offset + limit,
      threads: threads.slice(offset, offset + limit),
      ...this.indexFreshnessFields(snapshot.updatedAt),
    };
  }

  async getThreadById(threadId: string): Promise<ThreadDetail> {
    const snapshot = await this.loadSnapshot();
    const thread = this.buildThreads(snapshot, true).find((entry) => entry.id === threadId) as
      | ThreadDetail
      | undefined;
    if (!thread) {
      throw new Error(`Thread not found for id ${threadId}`);
    }
    return thread;
  }

  async getActionableThreads(input: {
    query?: string;
    label?: string;
    limit?: number;
    unreadOnly?: boolean;
    pendingOn?: "you" | "them" | "any";
  } = {}): Promise<{
    total: number;
    hasMore: boolean;
    threads: ActionableThreadSummary[];
  }> {
    const snapshot = await this.loadSnapshot();
    const pendingFilter = input.pendingOn || "any";
    const limit = input.limit ?? 50;
    const offset = 0;
    const actionable = (this.buildThreads(snapshot, true) as ThreadDetail[])
      .map((thread) => {
        const latestMessage = thread.messages[thread.messages.length - 1];
        const { pendingOn, score } = actionableThreadScore(thread, snapshot.ownerEmail);
        return {
          ...thread,
          latestEmailId: latestMessage?.primaryEmailId,
          latestPreview: latestMessage?.preview,
          latestFrom: latestMessage?.from ?? [],
          latestIsRead: latestMessage?.isRead ?? true,
          latestIsStarred: latestMessage?.isStarred ?? false,
          latestHasAttachments: latestMessage?.hasAttachments ?? false,
          pendingOn,
          score,
        } satisfies ActionableThreadSummary;
      })
      .filter((thread) => {
        if (input.unreadOnly !== false && thread.unreadCount === 0) {
          return false;
        }

        if (pendingFilter !== "any" && thread.pendingOn !== pendingFilter) {
          return false;
        }

        if (input.label) {
          const labelNeedle = input.label.toLowerCase();
          if (!thread.normalizedLabels.some((label) => label.toLowerCase() === labelNeedle)) {
            return false;
          }
        }

        if (input.query) {
          const haystack = [
            thread.subject,
            thread.latestPreview || "",
            ...thread.latestFrom.map((value) => `${value.name ?? ""} ${value.address ?? ""}`),
            ...thread.normalizedLabels,
          ]
            .join("\n")
            .toLowerCase();
          if (!haystack.includes(input.query.toLowerCase())) {
            return false;
          }
        }

        return true;
      })
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        const leftTime = new Date(left.latestDate || 0).getTime();
        const rightTime = new Date(right.latestDate || 0).getTime();
        return rightTime - leftTime;
      });

    const totalCount = actionable.length;
    return {
      total: totalCount,
      hasMore: totalCount > offset + limit,
      threads: actionable.slice(offset, offset + limit),
    };
  }

  async getSyncCheckpointMap(): Promise<Record<string, MailboxSyncCheckpoint>> {
    const snapshot = await this.loadSnapshot();
    return Object.fromEntries(snapshot.syncCheckpoints.map((checkpoint) => [checkpoint.folder, checkpoint]));
  }

  async getInboxDigest(input: {
    limit?: number;
    minAgeHours?: number;
  } = {}): Promise<Record<string, unknown>> {
    const snapshot = await this.loadSnapshot();
    const minAgeHours = input.minAgeHours ?? 24;
    const allActionable = (this.buildThreads(snapshot, true) as ThreadDetail[])
      .map((thread) => {
        const latestMessage = thread.messages[thread.messages.length - 1];
        const { pendingOn, score } = actionableThreadScore(thread, snapshot.ownerEmail);
        return {
          ...thread,
          latestEmailId: latestMessage?.primaryEmailId,
          latestPreview: latestMessage?.preview,
          latestFrom: latestMessage?.from ?? [],
          latestIsRead: latestMessage?.isRead ?? true,
          latestIsStarred: latestMessage?.isStarred ?? false,
          latestHasAttachments: latestMessage?.hasAttachments ?? false,
          pendingOn,
          score,
        } satisfies ActionableThreadSummary;
      })
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return new Date(right.latestDate || 0).getTime() - new Date(left.latestDate || 0).getTime();
      });

    const now = Date.now();
    const staleThresholdMs = minAgeHours * 60 * 60 * 1000;
    const staleAwaitingYou = allActionable.filter((thread) => {
      if (thread.pendingOn !== "you" || !thread.latestDate) {
        return false;
      }
      return now - new Date(thread.latestDate).getTime() >= staleThresholdMs;
    });

    return {
      generatedAt: new Date().toISOString(),
      indexUpdatedAt: snapshot.updatedAt,
      counts: {
        totalThreads: allActionable.length,
        unreadThreads: allActionable.filter((thread) => thread.unreadCount > 0).length,
        pendingOnYou: allActionable.filter((thread) => thread.pendingOn === "you").length,
        pendingOnThem: allActionable.filter((thread) => thread.pendingOn === "them").length,
        starredThreads: allActionable.filter((thread) => thread.latestIsStarred).length,
        attachmentThreads: allActionable.filter((thread) => thread.latestHasAttachments).length,
        staleAwaitingYou: staleAwaitingYou.length,
      },
      topThreads: allActionable.slice(0, input.limit ?? 10),
      staleAwaitingYou: staleAwaitingYou.slice(0, input.limit ?? 10),
    };
  }

  async getFollowUpCandidates(input: {
    limit?: number;
    minAgeHours?: number;
    pendingOn?: "you" | "them" | "any";
  } = {}): Promise<Record<string, unknown>> {
    const snapshot = await this.loadSnapshot();
    const minAgeHours = input.minAgeHours ?? 24;
    const pendingOn = input.pendingOn ?? "you";
    const thresholdMs = minAgeHours * 60 * 60 * 1000;
    const now = Date.now();
    const limit = input.limit ?? 25;
    const offset = 0;

    const candidates = (this.buildThreads(snapshot, true) as ThreadDetail[])
      .map((thread) => {
        const latestMessage = thread.messages[thread.messages.length - 1];
        const { pendingOn: currentPendingOn, score } = actionableThreadScore(thread, snapshot.ownerEmail);
        const ageHours = thread.latestDate
          ? Math.max(0, Math.round((now - new Date(thread.latestDate).getTime()) / (60 * 60 * 1000)))
          : undefined;
        return {
          ...thread,
          latestEmailId: latestMessage?.primaryEmailId,
          latestPreview: latestMessage?.preview,
          latestFrom: latestMessage?.from ?? [],
          latestIsRead: latestMessage?.isRead ?? true,
          latestIsStarred: latestMessage?.isStarred ?? false,
          latestHasAttachments: latestMessage?.hasAttachments ?? false,
          pendingOn: currentPendingOn,
          score,
          ageHours,
          suggestedAction:
            currentPendingOn === "you" ? "reply" : currentPendingOn === "them" ? "follow_up" : "review",
        } satisfies ActionableThreadSummary & {
          ageHours?: number;
          suggestedAction: "reply" | "follow_up" | "review";
        };
      })
      .filter((thread) => {
        if (pendingOn !== "any" && thread.pendingOn !== pendingOn) {
          return false;
        }
        if (thread.latestDate && now - new Date(thread.latestDate).getTime() < thresholdMs) {
          return false;
        }
        return true;
      })
      .sort((left, right) => {
        if ((right.ageHours ?? 0) !== (left.ageHours ?? 0)) {
          return (right.ageHours ?? 0) - (left.ageHours ?? 0);
        }
        return right.score - left.score;
      });

    const totalCount = candidates.length;
    return {
      generatedAt: new Date().toISOString(),
      indexUpdatedAt: snapshot.updatedAt,
      minAgeHours,
      pendingOn,
      total: totalCount,
      hasMore: totalCount > offset + limit,
      threads: candidates.slice(offset, offset + limit),
    };
  }

  async findDocumentThreads(input: {
    category?: "document" | "invoice" | "contract" | "travel" | "calendar";
    query?: string;
    limit?: number;
  } = {}): Promise<Record<string, unknown>> {
    const snapshot = await this.loadSnapshot();
    const category = input.category || "document";
    const limit = input.limit ?? 25;
    const keywordMap: Record<string, string[]> = {
      document: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "contract", "invoice", "receipt", "ticket"],
      invoice: ["invoice", "receipt", "bill", "payment"],
      contract: ["contract", "agreement", "msa", "dpa", "proposal"],
      travel: ["itinerary", "ticket", "booking", "reservation", "boarding", "hotel", "flight"],
      calendar: ["calendar", "invite", "meeting", "ics"],
    };
    const keywords = keywordMap[category] ?? keywordMap.document;

    const matches = (this.buildThreads(snapshot, true) as ThreadDetail[])
      .map((thread) => {
        const documents = thread.messages.flatMap((message) =>
          message.attachments.filter((attachment) => {
            const haystack = [
              attachment.filename || "",
              attachment.contentType || "",
              attachment.kind || "",
              message.subject,
              message.preview || "",
              message.attachmentText || "",
            ]
              .join(" ")
              .toLowerCase();
            return keywords.some((keyword) => haystack.includes(keyword));
          }).map((attachment) => ({
            emailId: message.primaryEmailId,
            subject: message.subject,
            filename: attachment.filename,
            kind: attachment.kind,
            contentType: attachment.contentType,
          })),
        );

        return {
          ...thread,
          documents,
        };
      })
      .filter((thread) => {
        if (thread.documents.length === 0) {
          return false;
        }
        if (!input.query) {
          return true;
        }
        const haystack = [
          thread.subject,
          ...thread.documents.map((document) => `${document.filename || ""} ${document.subject}`),
        ]
          .join("\n")
          .toLowerCase();
        return haystack.includes(input.query.toLowerCase());
      })
      .sort((left, right) => {
        if (right.documents.length !== left.documents.length) {
          return right.documents.length - left.documents.length;
        }
        return new Date(right.latestDate || 0).getTime() - new Date(left.latestDate || 0).getTime();
      });

    const offset = 0;
    const totalCount = matches.length;
    return {
      generatedAt: new Date().toISOString(),
      indexUpdatedAt: snapshot.updatedAt,
      category,
      total: totalCount,
      hasMore: totalCount > offset + limit,
      threads: matches.slice(offset, offset + limit),
    };
  }

  async getMeetingPrep(input: {
    person?: string;
    domain?: string;
    limit?: number;
  }): Promise<Record<string, unknown>> {
    const snapshot = await this.loadSnapshot();
    const personNeedle = input.person?.toLowerCase();
    const domainNeedle = input.domain?.toLowerCase();
    const limit = input.limit ?? 10;
    const threads = (this.buildThreads(snapshot, true) as ThreadDetail[])
      .filter((thread) =>
        thread.participants.some((participant) => {
          const participantText = `${participant.name ?? ""} ${participant.address ?? ""}`.toLowerCase();
          const participantDomain = extractDomain(participant.address || "");
          if (personNeedle && participantText.includes(personNeedle)) {
            return true;
          }
          if (domainNeedle && participantDomain === domainNeedle) {
            return true;
          }
          return false;
        }),
      )
      .slice(0, limit);

    const latestInbound = threads.flatMap((thread) =>
      [...thread.messages]
        .reverse()
        .find((message) => !isOutgoingMessage(message, snapshot.ownerEmail))
        ? [([...thread.messages].reverse().find((message) => !isOutgoingMessage(message, snapshot.ownerEmail)) as MailboxMessage)]
        : [],
    );

    return {
      generatedAt: new Date().toISOString(),
      indexUpdatedAt: snapshot.updatedAt,
      filters: {
        person: input.person,
        domain: input.domain,
      },
      totalThreads: threads.length,
      threads,
      latestInbound: latestInbound.slice(0, limit).map((message) => ({
        emailId: message.primaryEmailId,
        subject: message.subject,
        from: message.from,
        date: message.internalDate || message.date,
        preview: message.preview,
      })),
    };
  }

  async runIntegrityCheck(): Promise<{
    ok: boolean;
    integrity: string;
    storedMessageCount: number;
    ftsRowCount: number;
    syncCheckpointCount: number;
  }> {
    const db = await this.ensureDb();
    const integrity = String(
      (db.prepare(`PRAGMA integrity_check`).get() as { integrity_check?: string } | undefined)?.integrity_check || "unknown",
    );
    const storedMessageCount = Number(
      (db.prepare(`SELECT COUNT(*) AS count FROM messages`).get() as { count: number }).count,
    );
    const ftsRowCount = Number(
      (db.prepare(`SELECT COUNT(*) AS count FROM messages_fts`).get() as { count: number }).count,
    );
    const syncCheckpointCount = Number(
      (db.prepare(`SELECT COUNT(*) AS count FROM sync_state`).get() as { count: number }).count,
    );

    return {
      ok: integrity.toLowerCase() === "ok",
      integrity,
      storedMessageCount,
      ftsRowCount,
      syncCheckpointCount,
    };
  }

  private async ensureDb(): Promise<Database.Database> {
    if (this.db && this.initialized) {
      return this.db;
    }

    await mkdir(dirname(this.dbPath), { recursive: true });
    const db = this.db ?? new Database(this.dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("synchronous = NORMAL");

    this.runMigrations(db);
    this.db = db;
    await this.maybeImportLegacyIndex(db);

    this.initialized = true;
    return db;
  }

  private applySnapshot(
    db: Database.Database,
    input: {
      folders: FolderInfo[];
      emails: EmailSummary[];
      syncedAt: string;
      folderStats: Array<MailboxSyncCheckpoint>;
    },
    ownerEmail?: string,
    cleanupExpunged = false,
  ): void {
    const upsertFolder = db.prepare(`
      INSERT INTO folders (
        path, name, delimiter, special_use, listed, subscribed, flags_json,
        messages, unseen, uid_next, last_indexed_at, last_indexed_count
      ) VALUES (
        @path, @name, @delimiter, @special_use, @listed, @subscribed, @flags_json,
        @messages, @unseen, @uid_next, @last_indexed_at, @last_indexed_count
      )
      ON CONFLICT(path) DO UPDATE SET
        name = excluded.name,
        delimiter = excluded.delimiter,
        special_use = excluded.special_use,
        listed = excluded.listed,
        subscribed = excluded.subscribed,
        flags_json = excluded.flags_json,
        messages = excluded.messages,
        unseen = excluded.unseen,
        uid_next = excluded.uid_next,
        last_indexed_at = excluded.last_indexed_at,
        last_indexed_count = excluded.last_indexed_count
    `);

    const upsertMessage = db.prepare(`
      INSERT INTO messages (
        email_id, folder, uid, seq, message_id, in_reply_to, references_json, thread_id, subject,
        from_json, to_json, cc_json, bcc_json, reply_to_json, date, internal_date,
        is_read, is_starred, flags_json, size, preview, has_attachments, attachments_json, attachment_text, labels_json
      ) VALUES (
        @email_id, @folder, @uid, @seq, @message_id, @in_reply_to, @references_json, @thread_id, @subject,
        @from_json, @to_json, @cc_json, @bcc_json, @reply_to_json, @date, @internal_date,
        @is_read, @is_starred, @flags_json, @size, @preview, @has_attachments, @attachments_json, @attachment_text, @labels_json
      )
      ON CONFLICT(email_id) DO UPDATE SET
        folder = excluded.folder,
        uid = excluded.uid,
        seq = excluded.seq,
        message_id = excluded.message_id,
        in_reply_to = excluded.in_reply_to,
        references_json = excluded.references_json,
        thread_id = excluded.thread_id,
        subject = excluded.subject,
        from_json = excluded.from_json,
        to_json = excluded.to_json,
        cc_json = excluded.cc_json,
        bcc_json = excluded.bcc_json,
        reply_to_json = excluded.reply_to_json,
        date = excluded.date,
        internal_date = excluded.internal_date,
        is_read = excluded.is_read,
        is_starred = excluded.is_starred,
        flags_json = excluded.flags_json,
        size = excluded.size,
        -- A cheap flags-only sync (no message source fetched) leaves preview/
        -- attachment_text unset on the incoming row. IMAP content for a fixed
        -- UID is immutable — only flags change — so preserving the existing
        -- indexed value here is always correct, never stale.
        preview = COALESCE(excluded.preview, messages.preview),
        has_attachments = excluded.has_attachments,
        attachments_json = excluded.attachments_json,
        attachment_text = COALESCE(excluded.attachment_text, messages.attachment_text),
        labels_json = excluded.labels_json
    `);
    const upsertSyncState = db.prepare(`
      INSERT INTO sync_state (
        folder, uid_validity, uid_next, highest_uid, last_sync_at, last_full_sync_at, strategy, changed, fetched, total
      ) VALUES (
        @folder, @uid_validity, @uid_next, @highest_uid, @last_sync_at, @last_full_sync_at, @strategy, @changed, @fetched, @total
      )
      ON CONFLICT(folder) DO UPDATE SET
        uid_validity = excluded.uid_validity,
        uid_next = excluded.uid_next,
        highest_uid = excluded.highest_uid,
        last_sync_at = excluded.last_sync_at,
        last_full_sync_at = COALESCE(excluded.last_full_sync_at, sync_state.last_full_sync_at),
        strategy = excluded.strategy,
        changed = excluded.changed,
        fetched = excluded.fetched,
        total = excluded.total
    `);

    const deleteFts = db.prepare(`DELETE FROM messages_fts WHERE email_id = ?`);
    const insertFts = db.prepare(`
      INSERT INTO messages_fts (
        email_id, subject, preview, folder, labels, participants, attachment_names
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const setMetadata = db.prepare(`
      INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    const getStoredSyncState = db.prepare(`SELECT uid_validity FROM sync_state WHERE folder = ?`);
    const deleteFtsForFolder = db.prepare(`
      DELETE FROM messages_fts
      WHERE email_id IN (SELECT email_id FROM messages WHERE folder = ?)
    `);
    const deleteMessagesForFolder = db.prepare(`DELETE FROM messages WHERE folder = ?`);
    const createSnapshotUidTable = db.prepare(`
      CREATE TEMP TABLE IF NOT EXISTS temp_snapshot_uids (
        uid INTEGER PRIMARY KEY
      )
    `);

    const transaction = db.transaction(() => {
      setMetadata.run("schemaVersion", String(DB_SCHEMA_VERSION));
      setMetadata.run("ownerEmail", ownerEmail || "");
      setMetadata.run("updatedAt", input.syncedAt);
      const foldersWithResetCheckpoint = new Set<string>();

      for (const folderStat of input.folderStats) {
        const stored = getStoredSyncState.get(folderStat.folder) as { uid_validity?: string | null } | undefined;
        const storedUidValidity = stored?.uid_validity ?? null;
        const serverUidValidity = folderStat.uidValidity ?? null;
        if (storedUidValidity && serverUidValidity && storedUidValidity !== serverUidValidity) {
          this.log.warn(
            `UIDVALIDITY changed for folder ${folderStat.folder}, clearing local index.`,
            "LocalIndexService",
            {
              folder: folderStat.folder,
              storedUidValidity,
              serverUidValidity,
            },
          );
          deleteFtsForFolder.run(folderStat.folder);
          deleteMessagesForFolder.run(folderStat.folder);
          foldersWithResetCheckpoint.add(folderStat.folder);
        }
      }

      for (const folder of input.folders) {
        const folderStat = input.folderStats.find((entry) => entry.folder === folder.path);
        upsertFolder.run({
          path: folder.path,
          name: folder.name,
          delimiter: folder.delimiter,
          special_use: folder.specialUse ?? null,
          listed: folder.listed ? 1 : 0,
          subscribed: folder.subscribed ? 1 : 0,
          flags_json: JSON.stringify(folder.flags),
          messages: folder.messages ?? null,
          unseen: folder.unseen ?? null,
          uid_next: folder.uidNext ?? null,
          last_indexed_at: input.syncedAt,
          last_indexed_count: folderStat?.fetched ?? null,
        });
      }

      for (const folderStat of input.folderStats) {
        const resetCheckpoint = foldersWithResetCheckpoint.has(folderStat.folder);
        upsertSyncState.run({
          folder: folderStat.folder,
          uid_validity: resetCheckpoint ? null : folderStat.uidValidity ?? null,
          uid_next: folderStat.uidNext ?? null,
          highest_uid: resetCheckpoint ? null : folderStat.highestUid ?? null,
          last_sync_at: folderStat.lastSyncAt ?? input.syncedAt,
          last_full_sync_at:
            !resetCheckpoint && folderStat.strategy === "full"
              ? folderStat.lastFullSyncAt ?? folderStat.lastSyncAt ?? input.syncedAt
              : folderStat.lastFullSyncAt ?? null,
          strategy: folderStat.strategy ?? null,
          changed: folderStat.changed ? 1 : 0,
          fetched: folderStat.fetched ?? null,
          total: folderStat.total ?? null,
        });
      }

      for (const email of input.emails) {
        upsertMessage.run({
          email_id: email.id,
          folder: email.folder,
          uid: email.uid,
          seq: email.seq,
          message_id: email.messageId ?? null,
          in_reply_to: email.inReplyTo ?? null,
          references_json: JSON.stringify(email.references ?? []),
          thread_id: email.threadId ?? null,
          subject: email.subject,
          from_json: JSON.stringify(email.from),
          to_json: JSON.stringify(email.to),
          cc_json: JSON.stringify(email.cc),
          bcc_json: JSON.stringify(email.bcc),
          reply_to_json: JSON.stringify(email.replyTo),
          date: email.date ?? null,
          internal_date: email.internalDate ?? null,
          is_read: email.isRead ? 1 : 0,
          is_starred: email.isStarred ? 1 : 0,
          flags_json: JSON.stringify(email.flags),
          size: email.size ?? null,
          preview: email.preview ?? null,
          has_attachments: email.hasAttachments ? 1 : 0,
          attachments_json: JSON.stringify(email.attachments),
          attachment_text: email.attachmentText ?? null,
          labels_json: JSON.stringify(email.labels),
        });

        const search = emailToSearchParts(email);
        deleteFts.run(email.id);
        insertFts.run(
          email.id,
          email.subject,
          email.preview ?? "",
          email.folder,
          search.labels,
          search.participants,
          search.attachmentNames,
        );
      }

      if (cleanupExpunged) {
        createSnapshotUidTable.run();
        const clearSnapshotUidTable = db.prepare(`DELETE FROM temp_snapshot_uids`);
        const insertSnapshotUid = db.prepare(`INSERT OR IGNORE INTO temp_snapshot_uids(uid) VALUES (?)`);
        const deleteExpungedFts = db.prepare(`
          DELETE FROM messages_fts
          WHERE email_id IN (
            SELECT email_id
            FROM messages
            WHERE folder = ?
              AND uid NOT IN (SELECT uid FROM temp_snapshot_uids)
          )
        `);
        const deleteExpungedMessages = db.prepare(`
          DELETE FROM messages
          WHERE folder = ?
            AND uid NOT IN (SELECT uid FROM temp_snapshot_uids)
        `);
        const uidsByFullSyncFolder = new Map<string, Set<number>>();
        for (const folderStat of input.folderStats) {
          if (folderStat.strategy === "full") {
            uidsByFullSyncFolder.set(folderStat.folder, new Set<number>());
          }
        }
        for (const email of input.emails) {
          uidsByFullSyncFolder.get(email.folder)?.add(email.uid);
        }
        for (const [folder, uids] of uidsByFullSyncFolder) {
          clearSnapshotUidTable.run();
          for (const uid of uids) {
            insertSnapshotUid.run(uid);
          }
          deleteExpungedFts.run(folder);
          deleteExpungedMessages.run(folder);
        }
        clearSnapshotUidTable.run();
      }
    });

    transaction();
  }

  private runMigrations(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS folders (
        path TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        delimiter TEXT NOT NULL,
        special_use TEXT,
        listed INTEGER NOT NULL,
        subscribed INTEGER NOT NULL,
        flags_json TEXT NOT NULL,
        messages INTEGER,
        unseen INTEGER,
        uid_next INTEGER,
        last_indexed_at TEXT,
        last_indexed_count INTEGER
      );

      CREATE TABLE IF NOT EXISTS messages (
        email_id TEXT PRIMARY KEY,
        folder TEXT NOT NULL,
        uid INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        message_id TEXT,
        in_reply_to TEXT,
        references_json TEXT NOT NULL DEFAULT '[]',
        thread_id TEXT,
        subject TEXT NOT NULL,
        from_json TEXT NOT NULL,
        to_json TEXT NOT NULL,
        cc_json TEXT NOT NULL,
        bcc_json TEXT NOT NULL,
        reply_to_json TEXT NOT NULL,
        date TEXT,
        internal_date TEXT,
        is_read INTEGER NOT NULL,
        is_starred INTEGER NOT NULL,
        flags_json TEXT NOT NULL,
        size INTEGER,
        preview TEXT,
        has_attachments INTEGER NOT NULL,
        attachments_json TEXT NOT NULL,
        attachment_text TEXT,
        labels_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        folder TEXT PRIMARY KEY,
        uid_validity TEXT,
        uid_next INTEGER,
        highest_uid INTEGER,
        last_sync_at TEXT,
        last_full_sync_at TEXT,
        strategy TEXT,
        changed INTEGER NOT NULL DEFAULT 0,
        fetched INTEGER,
        total INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_messages_folder ON messages(folder);
      CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id);
      CREATE INDEX IF NOT EXISTS idx_messages_in_reply_to ON messages(in_reply_to);
      CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id);
      CREATE INDEX IF NOT EXISTS idx_messages_internal_date ON messages(internal_date);
      CREATE INDEX IF NOT EXISTS idx_messages_folder_date ON messages(folder, internal_date DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        email_id UNINDEXED,
        subject,
        preview,
        folder,
        labels,
        participants,
        attachment_names,
        tokenize = 'porter unicode61'
      );
    `);
    this.ensureMessagesColumns(db);
  }

  private ensureMessagesColumns(db: Database.Database): void {
    const columns = new Set(
      (db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>).map((row) => row.name),
    );

    if (!columns.has("references_json")) {
      db.exec(`ALTER TABLE messages ADD COLUMN references_json TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!columns.has("attachment_text")) {
      db.exec(`ALTER TABLE messages ADD COLUMN attachment_text TEXT`);
    }
  }

  private async maybeImportLegacyIndex(db: Database.Database): Promise<void> {
    const hasMetadata = db.prepare(`SELECT value FROM metadata WHERE key = 'schemaVersion'`).get() as
      | { value: string }
      | undefined;
    if (hasMetadata) {
      return;
    }

    try {
      const raw = await readFile(this.legacyIndexPath, "utf8");
      const legacy = JSON.parse(raw) as LegacyLocalIndexFile;
      this.log.info("Importing legacy JSON mailbox index into SQLite", "LocalIndexService", {
        legacyPath: this.legacyIndexPath,
      });

      this.applySnapshot(
        db,
        {
          folders: legacy.folders ?? [],
          emails: Object.values(legacy.messages ?? {}),
          syncedAt: legacy.updatedAt || new Date().toISOString(),
          folderStats: Object.values(legacy.indexedFolders ?? {}).map((entry) => ({
            folder: entry.path,
            fetched: entry.lastIndexedCount ?? 0,
            total: entry.messages ?? 0,
          })),
        },
        lowerCaseAddress(this.config.smtp.username),
      );
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error as { code?: string }).code === "ENOENT"
        )
      ) {
        this.log.warn("Failed to import legacy JSON mailbox index", "LocalIndexService", error);
      }

      const setMetadata = db.prepare(`
        INSERT INTO metadata (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `);
      setMetadata.run("schemaVersion", String(DB_SCHEMA_VERSION));
      setMetadata.run("ownerEmail", lowerCaseAddress(this.config.smtp.username) || "");
      setMetadata.run("updatedAt", "");
    }
  }

  private loadCandidateEmails(
    db: Database.Database,
    filters: SearchEmailsInput,
    limitHint: number,
    warnings: string[],
  ): EmailSummary[] {
    const sqlParts = [`SELECT * FROM messages`];
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (filters.query) {
      const { ids: ftsIds, warning } = this.searchFtsIds(db, filters.query, limitHint);
      if (warning) {
        warnings.push(warning);
      }
      if (ftsIds.length === 0) {
        return [];
      }
      conditions.push(`email_id IN (${ftsIds.map(() => "?").join(", ")})`);
      params.push(...ftsIds);
    }

    if (filters.folder) {
      conditions.push(`folder = ?`);
      params.push(filters.folder);
    }
    if (typeof filters.isRead === "boolean") {
      conditions.push(`is_read = ?`);
      params.push(filters.isRead ? 1 : 0);
    }
    if (typeof filters.isStarred === "boolean") {
      conditions.push(`is_starred = ?`);
      params.push(filters.isStarred ? 1 : 0);
    }
    if (typeof filters.hasAttachment === "boolean") {
      conditions.push(`has_attachments = ?`);
      params.push(filters.hasAttachment ? 1 : 0);
    }
    if (filters.subject) {
      conditions.push(`LOWER(subject) LIKE ? ESCAPE '\\'`);
      params.push(`%${escapeLike(filters.subject.toLowerCase())}%`);
    }
    if (filters.senderDomain) {
      conditions.push(`LOWER(from_json) LIKE ? ESCAPE '\\'`);
      params.push(`%${escapeLike(filters.senderDomain.toLowerCase())}%`);
    }
    // from/to/messageId were accepted by search_indexed_emails but never
    // narrowed the SQL candidate scan — only applied afterward by
    // matchesIndexedSearch, against whatever the plain date-ordered LIMIT
    // happened to fetch. On a mailbox bigger than that candidate window
    // (500, or limit*10), a from/to/messageId search silently misses every
    // genuine match older than the window instead of finding it. Mirror the
    // existing senderDomain LIKE pattern (a safe superset pre-filter).
    if (filters.from) {
      conditions.push(`LOWER(from_json) LIKE ? ESCAPE '\\'`);
      params.push(`%${escapeLike(filters.from.toLowerCase())}%`);
    }
    if (filters.to) {
      conditions.push(`(LOWER(to_json) LIKE ? ESCAPE '\\' OR LOWER(cc_json) LIKE ? ESCAPE '\\' OR LOWER(bcc_json) LIKE ? ESCAPE '\\')`);
      const toNeedle = `%${escapeLike(filters.to.toLowerCase())}%`;
      params.push(toNeedle, toNeedle, toNeedle);
    }
    if (filters.messageId) {
      conditions.push(`message_id = ?`);
      params.push(filters.messageId);
    }
    if (filters.threadId) {
      conditions.push(`thread_id = ?`);
      params.push(filters.threadId);
    }
    if (filters.dateFrom) {
      conditions.push(`COALESCE(internal_date, date) >= ?`);
      params.push(filters.dateFrom);
    }
    if (filters.dateTo) {
      // dateTo is commonly a bare date ("2026-09-02") without a time
      // component. `<= "2026-09-02"` did a raw string comparison against
      // full ISO timestamps ("2026-09-02T17:14:06.000Z" <= "2026-09-02" is
      // false, since the longer string sorts after the shorter prefix) —
      // silently excluding every message on the dateTo day itself. Found
      // live: dateFrom and dateTo both set to today returned zero results
      // despite messages from today existing. Fixed the same way the
      // live-IMAP search path (buildSearchQuery) already does it: treat
      // dateTo as an exclusive upper bound at the start of the *next* day.
      conditions.push(`COALESCE(internal_date, date) < ?`);
      params.push(nextDay(new Date(filters.dateTo)).toISOString());
    }

    if (conditions.length > 0) {
      sqlParts.push(`WHERE ${conditions.join(" AND ")}`);
    }

    sqlParts.push(`ORDER BY COALESCE(internal_date, date) DESC, uid DESC LIMIT ?`);
    params.push(limitHint);

    return db
      .prepare(sqlParts.join(" "))
      .all(...params)
      .map((row) => this.rowToEmailSummary(row as MessageRow));
  }

  private searchFtsIds(
    db: Database.Database,
    query: string,
    limit: number,
  ): { ids: string[]; warning?: string } {
    const parsed = parseSearchQuery(query);
    const FTS5_OPERATORS = new Set(["not", "and", "or", "near"]);
    const safeTerms = parsed.residualTerms.filter(
      (token) => !FTS5_OPERATORS.has(token.toLowerCase()) && !token.startsWith("-"),
    );
    const match = safeTerms
      .map((token) => `"${token.replace(/"/g, '""')}"`)
      .join(" AND ");

    if (!match) {
      // Every token was filtered out (bare FTS5 operators or a leading "-"), so the
      // query never actually ran — this is "search couldn't run", not "no results".
      return {
        ids: [],
        warning: `Search query "${query}" contained no searchable terms after removing FTS5 operator tokens (NOT/AND/OR/NEAR) and leading hyphens — the search did not run. Rephrase without those tokens.`,
      };
    }

    try {
      const ids = db
        .prepare(`SELECT email_id FROM messages_fts WHERE messages_fts MATCH ? LIMIT ?`)
        .all(match, limit)
        .map((row) => String((row as { email_id: string }).email_id));
      return { ids };
    } catch (error) {
      this.log.warn("FTS search failed, falling back to metadata scan", "LocalIndexService", {
        query,
        error,
      });
      return {
        ids: [],
        warning: `Full-text search failed for query "${query}" (likely invalid FTS5 syntax) — results below are empty, not necessarily "no matches". Try a simpler query.`,
      };
    }
  }

  private async loadSnapshot(options: SnapshotLoadOptions = {}): Promise<SnapshotData> {
    const db = await this.ensureDb();

    const metadataRows = db
      .prepare(`SELECT key, value FROM metadata`)
      .all() as Array<{ key: string; value: string }>;
    const metadata = Object.fromEntries(metadataRows.map((row) => [row.key, row.value]));

    const folders = db
      .prepare(`SELECT * FROM folders ORDER BY path ASC`)
      .all()
      .map((row) => this.rowToFolderInfo(row as Record<string, unknown>));

    const indexedFolders = db
      .prepare(`
        SELECT path, messages, unseen, special_use, last_indexed_at, last_indexed_count
        FROM folders
        ORDER BY path ASC
      `)
      .all()
      .map((row) => ({
        path: String((row as { path: string }).path),
        messages: (row as { messages?: number }).messages,
        unseen: (row as { unseen?: number }).unseen,
        specialUse: (row as { special_use?: string }).special_use,
        lastIndexedAt: (row as { last_indexed_at?: string }).last_indexed_at,
        lastIndexedCount: (row as { last_indexed_count?: number }).last_indexed_count,
      }));

    const syncCheckpoints = db
      .prepare(`
        SELECT folder, uid_validity, uid_next, highest_uid, last_sync_at, last_full_sync_at, strategy, changed, fetched, total
        FROM sync_state
        ORDER BY folder ASC
      `)
      .all()
      .map((row) => ({
        folder: String((row as { folder: string }).folder),
        uidValidity: (row as { uid_validity?: string }).uid_validity,
        uidNext: (row as { uid_next?: number }).uid_next,
        highestUid: (row as { highest_uid?: number }).highest_uid,
        lastSyncAt: (row as { last_sync_at?: string }).last_sync_at,
        lastFullSyncAt: (row as { last_full_sync_at?: string }).last_full_sync_at,
        strategy: (row as { strategy?: MailboxSyncCheckpoint["strategy"] }).strategy,
        changed: Boolean((row as { changed?: number }).changed),
        fetched: (row as { fetched?: number }).fetched,
        total: (row as { total?: number }).total,
      } satisfies MailboxSyncCheckpoint));

    const messageSqlParts = [`SELECT * FROM messages`];
    const messageParams: unknown[] = [];
    const messageConditions: string[] = [];

    if (options.folder) {
      messageConditions.push(`folder = ?`);
      messageParams.push(options.folder);
    }
    if (options.label) {
      const labelNeedle = escapeLike(options.label.toLowerCase());
      messageConditions.push(`(LOWER(folder) LIKE ? ESCAPE '\\' OR LOWER(labels_json) LIKE ? ESCAPE '\\')`);
      messageParams.push(`%${labelNeedle}%`, `%${labelNeedle}%`);
    }
    if (typeof options.isRead === "boolean") {
      messageConditions.push(`is_read = ?`);
      messageParams.push(options.isRead ? 1 : 0);
    }
    if (options.since) {
      messageConditions.push(`COALESCE(internal_date, date) >= ?`);
      messageParams.push(options.since);
    }

    if (messageConditions.length > 0) {
      messageSqlParts.push(`WHERE ${messageConditions.join(" AND ")}`);
    }

    // Cap unfiltered snapshots so thread/status builders never materialize the entire mailbox at once.
    const messageLimit = Math.max(0, options.limit ?? DEFAULT_SNAPSHOT_LIMIT);
    const messageOffset = Math.max(0, options.offset ?? 0);
    messageSqlParts.push(`ORDER BY COALESCE(internal_date, date) DESC, uid DESC LIMIT ? OFFSET ?`);
    messageParams.push(messageLimit, messageOffset);

    const messages = db
      .prepare(messageSqlParts.join(" "))
      .all(...messageParams)
      .map((row) => this.rowToEmailSummary(row as MessageRow));

    return {
      ownerEmail: metadata.ownerEmail || undefined,
      updatedAt: metadata.updatedAt || undefined,
      folders,
      indexedFolders,
      syncCheckpoints,
      messages,
    };
  }

  private rowToFolderInfo(row: Record<string, unknown>): FolderInfo {
    return {
      path: String(row.path),
      name: String(row.name),
      delimiter: String(row.delimiter),
      specialUse: typeof row.special_use === "string" ? row.special_use : undefined,
      listed: Boolean(row.listed),
      subscribed: Boolean(row.subscribed),
      flags: safeJsonParse<string[]>(String(row.flags_json || "[]"), []),
      messages: typeof row.messages === "number" ? row.messages : undefined,
      unseen: typeof row.unseen === "number" ? row.unseen : undefined,
      uidNext: typeof row.uid_next === "number" ? row.uid_next : undefined,
    };
  }

  private rowToEmailSummary(row: MessageRow): EmailSummary {
    return {
      id: row.email_id,
      folder: row.folder,
      uid: row.uid,
      seq: row.seq,
      messageId: row.message_id ?? undefined,
      inReplyTo: row.in_reply_to ?? undefined,
      references: safeJsonParse(row.references_json, []),
      threadId: row.thread_id ?? undefined,
      subject: row.subject,
      from: safeJsonParse(row.from_json, []),
      to: safeJsonParse(row.to_json, []),
      cc: safeJsonParse(row.cc_json, []),
      bcc: safeJsonParse(row.bcc_json, []),
      replyTo: safeJsonParse(row.reply_to_json, []),
      date: row.date ?? undefined,
      internalDate: row.internal_date ?? undefined,
      isRead: Boolean(row.is_read),
      isStarred: Boolean(row.is_starred),
      flags: safeJsonParse(row.flags_json, []),
      size: row.size ?? undefined,
      preview: row.preview ?? undefined,
      hasAttachments: Boolean(row.has_attachments),
      attachments: safeJsonParse(row.attachments_json, []),
      attachmentText: row.attachment_text ?? undefined,
      labels: safeJsonParse(row.labels_json, []),
    };
  }

  private toStatus(snapshot: SnapshotData): LocalIndexStatus {
    const dedupedCount = dedupeEmails(snapshot.messages).length;
    const mailboxMessages = this.buildMailboxMessages(snapshot);
    const threadCount = this.buildThreads(snapshot).length;
    const labelCount = new Set(
      mailboxMessages.flatMap((message) => message.normalizedLabels.map((label) => label.toLowerCase())),
    ).size;
    const ageMinutes = snapshot.updatedAt
      ? Math.max(0, Math.round((Date.now() - new Date(snapshot.updatedAt).getTime()) / 60_000))
      : undefined;

    return {
      path: this.dbPath,
      ownerEmail: snapshot.ownerEmail,
      updatedAt: snapshot.updatedAt,
      ageMinutes,
      staleThresholdMinutes: STALE_THRESHOLD_MINUTES,
      isStale: typeof ageMinutes === "number" ? ageMinutes > STALE_THRESHOLD_MINUTES : true,
      folderCount: snapshot.folders.length,
      labelCount,
      threadCount,
      storedMessageCount: snapshot.messages.length,
      dedupedMessageCount: dedupedCount,
      syncCheckpoints: snapshot.syncCheckpoints,
      folders: snapshot.indexedFolders,
    };
  }

  private buildMailboxMessages(snapshot: SnapshotData): MailboxMessage[] {
    const foldersByPath = new Map(snapshot.folders.map((folder) => [folder.path, folder]));
    const groups = new Map<string, Array<{ email: EmailSummary; folder?: FolderInfo }>>();

    for (const email of snapshot.messages) {
      const key = canonicalMessageKey(email);
      const group = groups.get(key) ?? [];
      group.push({ email, folder: foldersByPath.get(email.folder) });
      groups.set(key, group);
    }

    return sortEmailsByNewest(
      [...groups.entries()].map(([canonicalId, entries]) => {
        const primaryEntry = [...entries].sort((left, right) => locationScore(right) - locationScore(left))[0];
        const primary = primaryEntry.email;
        const primaryFolder = primaryEntry.folder;
        const locations: MailboxMessageLocation[] = entries.map(({ email, folder }) => ({
          emailId: email.id,
          folder: email.folder,
          uid: email.uid,
          labels: [...email.labels],
          specialUse: folder?.specialUse,
          isRead: email.isRead,
          isStarred: email.isStarred,
        }));

        return {
          ...primary,
          canonicalId,
          primaryEmailId: primary.id,
          threadKey: threadKeyForEmail(primary),
          mailboxRole: specialUseToRole(primaryFolder?.specialUse, primary.folder),
          normalizedLabels: [...new Set(entries.flatMap((entry) => normalizedMailboxLabelsFor(entry.email, entry.folder)))]
            .sort((left, right) => left.localeCompare(right)),
          locations: locations.sort((left, right) => right.uid - left.uid),
        };
      }),
    );
  }

  private buildThreads(
    snapshot: SnapshotData,
    includeMessages = false,
  ): Array<ThreadSummary | ThreadDetail> {
    const messages = this.assignResolvedThreadKeys(this.buildMailboxMessages(snapshot), snapshot.ownerEmail);
    const groups = new Map<string, MailboxMessage[]>();

    for (const message of messages) {
      const key = message.threadKey;
      const group = groups.get(key) ?? [];
      group.push(message);
      groups.set(key, group);
    }

    return [...groups.entries()]
      .map(([id, entries]) => {
        const sortedMessages = [...entries].sort((left, right) => {
          const leftTime = new Date(left.internalDate || left.date || 0).getTime();
          const rightTime = new Date(right.internalDate || right.date || 0).getTime();
          if (leftTime !== rightTime) {
            return leftTime - rightTime;
          }
          return left.uid - right.uid;
        });

        const latest = sortEmailsByNewest(sortedMessages)[0];
        const normalizedLabels = new Set<string>();
        for (const message of sortedMessages) {
          for (const label of message.normalizedLabels) {
            normalizedLabels.add(label);
          }
        }

        const summary: ThreadSummary = {
          id,
          subject: latest ? normalizeSubjectForThread(latest.subject) : "(no subject)",
          messageCount: sortedMessages.length,
          unreadCount: sortedMessages.filter((message) => !message.isRead).length,
          latestDate: latest?.internalDate || latest?.date,
          participants: uniqueParticipants(sortedMessages),
          normalizedLabels: [...normalizedLabels].sort((left, right) => left.localeCompare(right)),
          messageIds: sortedMessages.map((message) => message.primaryEmailId),
        };

        if (!includeMessages) {
          return summary;
        }

        return {
          ...summary,
          messages: sortedMessages,
        };
      })
      .sort((left, right) => {
        const leftTime = new Date(left.latestDate || 0).getTime();
        const rightTime = new Date(right.latestDate || 0).getTime();
        if (rightTime !== leftTime) {
          return rightTime - leftTime;
        }
        return left.subject.localeCompare(right.subject);
      });
  }

  private assignResolvedThreadKeys(messages: MailboxMessage[], ownerEmail?: string): MailboxMessage[] {
    const byCanonicalId = new Map(messages.map((message) => [message.canonicalId, message]));
    const byMessageId = new Map(
      messages.flatMap((message) => {
        const normalized = normalizeMessageId(message.messageId);
        return normalized ? [[normalized, message] as const] : [];
      }),
    );
    const resolvedKeys = new Map<string, string>();

    const resolveThreadKey = (message: MailboxMessage, stack = new Set<string>()): string => {
      if (resolvedKeys.has(message.canonicalId)) {
        return resolvedKeys.get(message.canonicalId) as string;
      }

      if (message.threadId?.trim()) {
        const direct = `imap:${message.threadId.trim()}`;
        resolvedKeys.set(message.canonicalId, direct);
        return direct;
      }

      if (stack.has(message.canonicalId)) {
        const fallback = fallbackThreadKey(message, ownerEmail);
        resolvedKeys.set(message.canonicalId, fallback);
        return fallback;
      }

      stack.add(message.canonicalId);

      const referenceCandidates = [
        normalizeMessageId(message.inReplyTo),
        ...[...extractMessageIdList(message.references)].reverse(),
      ].filter((value): value is string => Boolean(value));

      for (const parentId of referenceCandidates) {
        const parent = byMessageId.get(parentId) ?? byCanonicalId.get(parentId);
        if (parent && parent.canonicalId !== message.canonicalId) {
          const resolved = resolveThreadKey(parent, stack);
          resolvedKeys.set(message.canonicalId, resolved);
          stack.delete(message.canonicalId);
          return resolved;
        }
      }

      const syntheticReferenceRoot = extractMessageIdList(message.references)[0] || normalizeMessageId(message.inReplyTo);
      if (syntheticReferenceRoot) {
        const synthetic = `ref:${syntheticReferenceRoot}`;
        resolvedKeys.set(message.canonicalId, synthetic);
        stack.delete(message.canonicalId);
        return synthetic;
      }

      const fallback = fallbackThreadKey(message, ownerEmail);
      resolvedKeys.set(message.canonicalId, fallback);
      stack.delete(message.canonicalId);
      return fallback;
    };

    return messages.map((message) => ({
      ...message,
      threadKey: resolveThreadKey(message),
    }));
  }

  private readLastSyncAt(db: Database.Database): string | undefined {
    const row = db.prepare(`SELECT value FROM metadata WHERE key = 'updatedAt'`).get() as { value: string } | undefined;
    return row?.value || undefined;
  }

  private indexFreshnessFields(lastSyncAt?: string): { lastSyncAt?: string; indexFreshnessMinutes?: number } {
    if (!lastSyncAt) {
      return {};
    }
    const freshnessMs = Date.now() - new Date(lastSyncAt).getTime();
    return {
      lastSyncAt,
      indexFreshnessMinutes: Math.max(0, Math.round(freshnessMs / 60_000)),
    };
  }

  private closeDb(): void {
    if (this.db) {
      this.db.close();
      this.db = undefined;
      this.initialized = false;
    }
  }
}
