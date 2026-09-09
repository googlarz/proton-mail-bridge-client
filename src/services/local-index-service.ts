import Database from "better-sqlite3";
import { chmodSync } from "node:fs";
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
import { ensureAccountIdentityMatches } from "../utils/account-identity.js";
import {
  createEmailId,
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
  is_automated: number | null;
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
      // An RFC 3501/5322 group marker (e.g. "Undisclosed-Recipients:;", or a
      // named group's start entry) has a real display name but no address at
      // all — imapflow's envelope parser keeps it as-is with address:"".
      // Falling back to the name as the dedup key kept these fabricated,
      // no-address "contacts" in the participant list as if they were real
      // people. A group marker isn't a participant; skip anything with no
      // real address instead of keying on its name.
      const key = lowerCaseAddress(address.address);
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

// ponytail: the upgrade path has been taken — messages.is_automated now stores the real
// List-Unsubscribe/List-Id/Precedence/Auto-Submitted verdict captured at index time
// (EmailSummary.isAutomated), and it wins whenever present. This local-part heuristic is kept
// only as the fallback for rows indexed before that column existed (is_automated NULL), which
// stay on the heuristic until a full re-sync backfills them. It proved too coarse live: it cut
// "pending on you" from 49,026 to 38,532 of ~57k threads, but transactional senders like an
// order-confirmation address with no no-reply marker are invisible to it.
const AUTOMATED_SENDER_PATTERN =
  /(^|[._-])(no-?reply|donotreply|do-not-reply|notification|powiadomien|mailer-daemon|postmaster|bounce)/i;

function isLikelyAutomatedSender(message: Pick<EmailSummary, "from" | "isAutomated">): boolean {
  if (message.isAutomated !== undefined) {
    return message.isAutomated;
  }
  return message.from.some((address) => AUTOMATED_SENDER_PATTERN.test(address.address ?? ""));
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
      : isLikelyAutomatedSender(latestMessage)
        ? "unknown"
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
    const db = await this.ensureDb();
    const { ownerEmail, updatedAt, folders, indexedFolders } = this.loadFoldersAndMetadata(db);
    const syncCheckpoints = this.loadCheckpointsSync(db);
    const counts = await this.realMessageCounts();
    // threadCount/labelCount (below, via toStatus -> buildThreads/buildMailboxMessages)
    // genuinely need message content — thread grouping via thread_id/References/In-Reply-To
    // and per-message label normalization aren't derivable from folders/sync_state alone.
    // Reuse the same deliberately-capped message query loadSnapshot() uses elsewhere for
    // this; every other field above is now sourced without touching the messages table.
    const messages = this.loadMessages(db, {});
    const snapshot: SnapshotData = { ownerEmail, updatedAt, folders, indexedFolders, syncCheckpoints, messages };
    return this.toStatus(snapshot, counts);
  }

  // loadSnapshot() caps snapshot.messages at DEFAULT_SNAPSHOT_LIMIT (5000) —
  // deliberately, so thread/status builders never materialize the whole
  // mailbox at once. But toStatus() used to derive storedMessageCount and
  // dedupedMessageCount from that same capped array, so both silently
  // plateaued at 5000 forever regardless of how much was actually indexed.
  // Found live: after syncing Archive, get_index_status still reported
  // storedMessageCount:5000 while run_doctor's runIntegrityCheck (a real
  // SELECT COUNT(*)) showed 34507 real rows — the exact field documented
  // for "verify the index is fresh and complete" was lying about progress.
  // Query the real counts directly instead; cheap indexed COUNT(*)s, no
  // need to touch the deliberate thread/label-building cap above.
  private async realMessageCounts(): Promise<{ storedMessageCount: number; dedupedMessageCount: number }> {
    const db = await this.ensureDb();
    const storedMessageCount = Number(
      (db.prepare(`SELECT COUNT(*) AS count FROM messages`).get() as { count: number }).count,
    );
    const dedupedMessageCount = Number(
      (
        db
          .prepare(`SELECT COUNT(DISTINCT COALESCE(message_id, email_id)) AS count FROM messages`)
          .get() as { count: number }
      ).count,
    );
    return { storedMessageCount, dedupedMessageCount };
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
        // Same DEFAULT_SNAPSHOT_LIMIT-cap bug already fixed in getThreadById(): this
        // snapshot fed straight into the thread lookup below, so a threadId whose
        // messages sat outside the newest 5000 (mailbox-wide) resolved fine via
        // getThreadById() but silently came back empty here. The folder/isRead/since
        // conditions above already scope the SQL query, so removing the cap doesn't
        // turn this into an unbounded "everything" read.
        limit: Number.MAX_SAFE_INTEGER,
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
    // Unlike every other method here, clear() doesn't go through ensureDb()
    // (it deletes the db file rather than opening it), so it must run the
    // same account-identity guard itself — otherwise a mismatched account
    // could delete another account's entire index with no prior open ever
    // having checked identity. Must run before closeDb()/rm() below.
    await ensureAccountIdentityMatches(this.config.dataDir, this.config.smtp.username);

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

    // Mirrors realMessageCounts()'s fix for the identical bug: messageCount/unreadCount
    // above were derived from buildMailboxMessages(loadSnapshot()), so — just like
    // storedMessageCount/dedupedMessageCount before that fix — they silently plateaued
    // at DEFAULT_SNAPSHOT_LIMIT (5000) on a mailbox bigger than that. A "folder"/
    // "special_use" label maps onto exactly one `folder` column value, so its true
    // count is a cheap indexed COUNT(*)/GROUP BY away — recompute those here, unbounded
    // by the snapshot cap. (Thread grouping and "label" (custom Proton label) counts
    // still come from the capped scan above: thread_id/References resolution and
    // labels_json membership aren't derivable from a folder-scoped SQL aggregate alone.)
    const db = await this.ensureDb();
    const realFolderCounts = db
      .prepare(`SELECT folder, COUNT(*) AS count, SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread FROM messages GROUP BY folder`)
      .all() as Array<{ folder: string; count: number; unread: number }>;
    const realCountsByFolderPath = new Map(
      realFolderCounts.map((row) => [row.folder, { messageCount: Number(row.count), unreadCount: Number(row.unread) }]),
    );

    for (const folder of snapshot.folders) {
      const real = realCountsByFolderPath.get(folder.path);
      if (!real) {
        continue;
      }

      const normalizedFolderName = normalizeMailboxLabel(folder.path) || folder.path;
      const folderId = `folder:${normalizedFolderName.toLowerCase()}`;
      const existingFolderEntry = counts.get(folderId);
      if (existingFolderEntry) {
        existingFolderEntry.label.messageCount = real.messageCount;
        existingFolderEntry.label.unreadCount = real.unreadCount;
      } else {
        // Every one of this folder's messages was aged out of the capped snapshot above
        // (all older than the newest DEFAULT_SNAPSHOT_LIMIT mailbox-wide), so the loop
        // above never discovered it at all. Synthesize its entry directly from the
        // accurate SQL counts rather than silently omitting the folder.
        counts.set(folderId, {
          label: {
            id: folderId,
            name: normalizedFolderName,
            type: "folder",
            messageCount: real.messageCount,
            unreadCount: real.unreadCount,
            threadCount: 0,
            specialUse: folder.specialUse,
          },
          threadIds: new Set<string>(),
        });
      }

      if (folder.specialUse) {
        const friendly = friendlySpecialUse(folder.specialUse) || folder.specialUse;
        const specialId = `special:${friendly.toLowerCase()}`;
        const existingSpecialEntry = counts.get(specialId);
        if (existingSpecialEntry) {
          existingSpecialEntry.label.messageCount = real.messageCount;
          existingSpecialEntry.label.unreadCount = real.unreadCount;
        } else {
          counts.set(specialId, {
            label: {
              id: specialId,
              name: friendly,
              type: "special_use",
              messageCount: real.messageCount,
              unreadCount: real.unreadCount,
              threadCount: 0,
              specialUse: folder.specialUse,
            },
            threadIds: new Set<string>(),
          });
        }
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
    messagesCapped?: boolean;
  }> {
    const db = await this.ensureDb();
    const { ownerEmail, updatedAt, folders, indexedFolders } = this.loadFoldersAndMetadata(db);
    const syncCheckpoints = this.loadCheckpointsSync(db);

    let messages: EmailSummary[];
    let messagesCapped = false;
    const hasFilter = Boolean(input.folder || input.label || input.query);
    if (hasFilter) {
      // Filter/search in SQL first — mirroring how search() builds its SQL query
      // before any snapshot-size limiting — so a thread whose messages sit entirely
      // outside the DEFAULT_SNAPSHOT_LIMIT-capped snapshot is never silently missed
      // just because a folder/label/query filter was given.
      messages = this.loadThreadCandidateMessages(db, input);
    } else {
      // No filter at all: a huge mailbox still needs SOME cap on what's fetched, so
      // keep the deliberate DEFAULT_SNAPSHOT_LIMIT cap here — but surface it via
      // messagesCapped instead of silently truncating, since real pagination over an
      // un-scoped "every thread" view isn't possible without a separate thread index.
      messages = this.loadMessages(db, {});
      messagesCapped = messages.length >= DEFAULT_SNAPSHOT_LIMIT;
    }

    const snapshot: SnapshotData = { ownerEmail, updatedAt, folders, indexedFolders, syncCheckpoints, messages };
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
      ...(messagesCapped ? { messagesCapped: true } : {}),
    };
  }

  async getThreadById(threadId: string): Promise<ThreadDetail> {
    const db = await this.ensureDb();
    const imapPrefix = "imap:";
    if (threadId.startsWith(imapPrefix)) {
      const rawThreadId = threadId.slice(imapPrefix.length);
      // A thread keyed as "imap:<id>" was grouped directly off the persisted
      // messages.thread_id column (see threadKeyForEmail/resolveThreadKey below) —
      // its full membership can be queried by that column directly, unbounded by
      // the DEFAULT_SNAPSHOT_LIMIT cap. This is what lets a threadId that was valid
      // when the index was smaller keep resolving after the index grows past 5000,
      // instead of throwing "Thread not found" just because its messages aged out
      // of the capped snapshot below.
      const rows = db.prepare(`SELECT * FROM messages WHERE thread_id = ?`).all(rawThreadId);
      if (rows.length > 0) {
        const { ownerEmail, updatedAt, folders, indexedFolders } = this.loadFoldersAndMetadata(db);
        const syncCheckpoints = this.loadCheckpointsSync(db);
        const messages = rows.map((row) => this.rowToEmailSummary(row as MessageRow));
        const snapshot: SnapshotData = { ownerEmail, updatedAt, folders, indexedFolders, syncCheckpoints, messages };
        const thread = (this.buildThreads(snapshot, true) as ThreadDetail[]).find((entry) => entry.id === threadId);
        if (thread) {
          return thread;
        }
      }
    }

    // Threads keyed off a References/In-Reply-To chain ("ref:...") or the
    // participant-signature fallback have no persisted thread_id to query by —
    // resolving them needs the cross-message reference graph. Read the full,
    // uncapped message set here (not the DEFAULT_SNAPSHOT_LIMIT-capped snapshot
    // loadSnapshot() would give us) so a fallback thread entirely outside the
    // newest 5000 messages — or one whose id only comes out right when its
    // complete membership is considered — still resolves instead of throwing
    // "Thread not found".
    const { ownerEmail, updatedAt, folders, indexedFolders } = this.loadFoldersAndMetadata(db);
    const syncCheckpoints = this.loadCheckpointsSync(db);
    const messages = this.loadAllMessages(db);
    const snapshot: SnapshotData = { ownerEmail, updatedAt, folders, indexedFolders, syncCheckpoints, messages };
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
    messagesCapped?: boolean;
  }> {
    const db = await this.ensureDb();
    const { ownerEmail, updatedAt, folders, indexedFolders } = this.loadFoldersAndMetadata(db);
    const syncCheckpoints = this.loadCheckpointsSync(db);
    const pendingFilter = input.pendingOn || "any";
    const limit = input.limit ?? 50;
    const offset = 0;
    // unreadOnly defaults to true (mirrors the JS-level filter below) — the vast
    // majority of calls are therefore SQL-prefilterable by is_read alone, same as
    // label/query. Only unreadOnly:false with no label/query has nothing SQL-expressible
    // to narrow by.
    const unreadOnly = input.unreadOnly !== false;

    let messages: EmailSummary[];
    let messagesCapped = false;
    if (unreadOnly || input.label || input.query) {
      // Same SQL-prefilter-then-expand-by-thread_id pattern getThreads() already uses:
      // any thread that could pass the unreadOnly/label/query filters below has at
      // least one qualifying message found here, so expanding to each match's full
      // thread_id membership (expandCandidatesToFullThreads) builds every such thread
      // complete, unbounded by DEFAULT_SNAPSHOT_LIMIT — instead of only threads whose
      // qualifying message also happened to be in the newest 5000 mailbox-wide.
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (unreadOnly) {
        conditions.push(`is_read = 0`);
      }
      if (input.label) {
        const labelNeedle = escapeLike(input.label.toLowerCase());
        conditions.push(`(LOWER(folder) LIKE ? ESCAPE '\\' OR LOWER(labels_json) LIKE ? ESCAPE '\\')`);
        params.push(`%${labelNeedle}%`, `%${labelNeedle}%`);
      }
      if (input.query) {
        const needle = `%${escapeLike(input.query.toLowerCase())}%`;
        conditions.push(
          `(LOWER(subject) LIKE ? ESCAPE '\\' OR LOWER(preview) LIKE ? ESCAPE '\\' OR LOWER(from_json) LIKE ? ESCAPE '\\' OR LOWER(labels_json) LIKE ? ESCAPE '\\')`,
        );
        params.push(needle, needle, needle, needle);
      }
      const sql = `SELECT * FROM messages${conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : ""}`;
      const candidateMessages = db
        .prepare(sql)
        .all(...params)
        .map((row) => this.rowToEmailSummary(row as MessageRow));
      messages = this.expandCandidatesToFullThreads(db, candidateMessages);
    } else {
      // unreadOnly explicitly false and no label/query: a genuinely unfiltered "every
      // thread" view, same as getThreads()' unfiltered path — nothing SQL-expressible to
      // narrow by, so keep the deliberate DEFAULT_SNAPSHOT_LIMIT cap but surface it.
      messages = this.loadMessages(db, {});
      messagesCapped = messages.length >= DEFAULT_SNAPSHOT_LIMIT;
    }

    const snapshot: SnapshotData = { ownerEmail, updatedAt, folders, indexedFolders, syncCheckpoints, messages };
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
      ...(messagesCapped ? { messagesCapped: true } : {}),
    };
  }

  async getSyncCheckpointMap(): Promise<Record<string, MailboxSyncCheckpoint>> {
    // Query sync_state directly — no need to pay loadSnapshot()'s up-to-5000-row
    // message deserialization just to read checkpoints, which never touch a
    // message row at all.
    const db = await this.ensureDb();
    const checkpoints = this.loadCheckpointsSync(db);
    return Object.fromEntries(checkpoints.map((checkpoint) => [checkpoint.folder, checkpoint]));
  }

  async getInboxDigest(input: {
    limit?: number;
    minAgeHours?: number;
  } = {}): Promise<Record<string, unknown>> {
    const db = await this.ensureDb();
    const { ownerEmail, updatedAt, folders, indexedFolders } = this.loadFoldersAndMetadata(db);
    const syncCheckpoints = this.loadCheckpointsSync(db);
    const minAgeHours = input.minAgeHours ?? 24;

    // Recent-activity overview (topThreads and the counts below it): a "digest" is
    // inherently about what's recent, so the deliberate DEFAULT_SNAPSHOT_LIMIT cap from
    // loadMessages() is appropriate here — unlike the stale-awaiting-you section below,
    // which specifically needs to find OLD stuff and must not be capped the same way.
    const recentMessages = this.loadMessages(db, {});
    const recentSnapshot: SnapshotData = { ownerEmail, updatedAt, folders, indexedFolders, syncCheckpoints, messages: recentMessages };
    const allActionable = (this.buildThreads(recentSnapshot, true) as ThreadDetail[])
      .map((thread) => {
        const latestMessage = thread.messages[thread.messages.length - 1];
        const { pendingOn, score } = actionableThreadScore(thread, ownerEmail);
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

    // Stale-awaiting-you: the exact same "find OLD stuff" problem getFollowUpCandidates()
    // has — a thread whose latest message is old enough to qualify may have aged
    // entirely out of recentSnapshot above. SQL-prefilter by date (any qualifying
    // thread's latest message necessarily satisfies this condition itself), then expand
    // to full, uncapped thread membership — mirrors getFollowUpCandidates()' fix.
    const cutoffIso = new Date(now - staleThresholdMs).toISOString();
    const staleCandidateMessages = db
      .prepare(`SELECT * FROM messages WHERE COALESCE(internal_date, date) < ?`)
      .all(cutoffIso)
      .map((row) => this.rowToEmailSummary(row as MessageRow));
    const staleMessages = this.expandCandidatesToFullThreads(db, staleCandidateMessages);
    const staleSnapshot: SnapshotData = { ownerEmail, updatedAt, folders, indexedFolders, syncCheckpoints, messages: staleMessages };
    const staleAwaitingYou = (this.buildThreads(staleSnapshot, true) as ThreadDetail[])
      .map((thread) => {
        const latestMessage = thread.messages[thread.messages.length - 1];
        const { pendingOn, score } = actionableThreadScore(thread, ownerEmail);
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
        if (thread.pendingOn !== "you" || !thread.latestDate) {
          return false;
        }
        return now - new Date(thread.latestDate).getTime() >= staleThresholdMs;
      })
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return new Date(right.latestDate || 0).getTime() - new Date(left.latestDate || 0).getTime();
      });

    return {
      generatedAt: new Date().toISOString(),
      indexUpdatedAt: updatedAt,
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
    const db = await this.ensureDb();
    const { ownerEmail, updatedAt, folders, indexedFolders } = this.loadFoldersAndMetadata(db);
    const syncCheckpoints = this.loadCheckpointsSync(db);
    const minAgeHours = input.minAgeHours ?? 24;
    const pendingOn = input.pendingOn ?? "you";
    const thresholdMs = minAgeHours * 60 * 60 * 1000;
    const now = Date.now();
    const limit = input.limit ?? 25;
    const offset = 0;

    // This method's entire purpose is finding OLD threads (minAgeHours), which is the
    // exact opposite of what the DEFAULT_SNAPSHOT_LIMIT-capped loadSnapshot() gives you
    // (the newest 5000 messages mailbox-wide) — a mailbox with more than 5000 recent
    // messages made this structurally incapable of ever surfacing an old candidate.
    // SQL-prefilter by date instead: any thread whose latest message is old enough to
    // qualify below necessarily has that message satisfy this condition itself, so
    // expanding every match to its full thread_id membership (expandCandidatesToFullThreads)
    // is guaranteed not to miss a qualifying thread, unbounded by the snapshot cap.
    const cutoffIso = new Date(now - thresholdMs).toISOString();
    const candidateMessages = db
      .prepare(`SELECT * FROM messages WHERE COALESCE(internal_date, date) < ?`)
      .all(cutoffIso)
      .map((row) => this.rowToEmailSummary(row as MessageRow));
    const messages = this.expandCandidatesToFullThreads(db, candidateMessages);
    const snapshot: SnapshotData = { ownerEmail, updatedAt, folders, indexedFolders, syncCheckpoints, messages };

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
    const db = await this.ensureDb();
    const { ownerEmail, updatedAt, folders, indexedFolders } = this.loadFoldersAndMetadata(db);
    const syncCheckpoints = this.loadCheckpointsSync(db);
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

    // SQL-prefilter by the same keyword haystack the JS-level document filter below
    // checks per attachment (attachments_json carries filename/contentType/kind; subject/
    // preview/attachment_text cover the rest) — a safe, over-inclusive superset, same
    // pattern as getThreads()' fix — then expand every match to its full thread_id
    // membership so a matching document thread outside DEFAULT_SNAPSHOT_LIMIT is never
    // silently missed. A message with no attachments can never contribute a document
    // match regardless of its text, so has_attachments = 1 narrows this further.
    const keywordConditions = keywords.map(
      () =>
        `(LOWER(attachments_json) LIKE ? ESCAPE '\\' OR LOWER(subject) LIKE ? ESCAPE '\\' OR LOWER(preview) LIKE ? ESCAPE '\\' OR LOWER(attachment_text) LIKE ? ESCAPE '\\')`,
    );
    const keywordParams: unknown[] = [];
    for (const keyword of keywords) {
      const needle = `%${escapeLike(keyword)}%`;
      keywordParams.push(needle, needle, needle, needle);
    }
    const candidateMessages = db
      .prepare(`SELECT * FROM messages WHERE has_attachments = 1 AND (${keywordConditions.join(" OR ")})`)
      .all(...keywordParams)
      .map((row) => this.rowToEmailSummary(row as MessageRow));
    const messages = this.expandCandidatesToFullThreads(db, candidateMessages);
    const snapshot: SnapshotData = { ownerEmail, updatedAt, folders, indexedFolders, syncCheckpoints, messages };

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
    const db = await this.ensureDb();
    const { ownerEmail, updatedAt, folders, indexedFolders } = this.loadFoldersAndMetadata(db);
    const syncCheckpoints = this.loadCheckpointsSync(db);
    const personNeedle = input.person?.toLowerCase();
    const domainNeedle = input.domain?.toLowerCase();
    const limit = input.limit ?? 10;

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (personNeedle) {
      const needle = `%${escapeLike(personNeedle)}%`;
      conditions.push(`(LOWER(from_json) LIKE ? ESCAPE '\\' OR LOWER(to_json) LIKE ? ESCAPE '\\' OR LOWER(cc_json) LIKE ? ESCAPE '\\')`);
      params.push(needle, needle, needle);
    }
    if (domainNeedle) {
      const needle = `%@${escapeLike(domainNeedle)}%`;
      conditions.push(`(LOWER(from_json) LIKE ? ESCAPE '\\' OR LOWER(to_json) LIKE ? ESCAPE '\\' OR LOWER(cc_json) LIKE ? ESCAPE '\\')`);
      params.push(needle, needle, needle);
    }

    let messages: EmailSummary[];
    let messagesCapped = false;
    if (conditions.length > 0) {
      // SQL-prefilter by participant text (a safe superset over the exact person/domain
      // match applied below), then expand every match to its full thread_id membership —
      // same pattern as getThreads()' fix — so a meeting-prep match outside
      // DEFAULT_SNAPSHOT_LIMIT is never silently missed.
      const sql = `SELECT * FROM messages WHERE ${conditions.join(" OR ")}`;
      const candidateMessages = db
        .prepare(sql)
        .all(...params)
        .map((row) => this.rowToEmailSummary(row as MessageRow));
      messages = this.expandCandidatesToFullThreads(db, candidateMessages);
    } else {
      // Neither person nor domain given: nothing SQL-expressible to narrow by — same
      // unavoidable bound as getThreads()' unfiltered path.
      messages = this.loadMessages(db, {});
      messagesCapped = messages.length >= DEFAULT_SNAPSHOT_LIMIT;
    }

    const snapshot: SnapshotData = { ownerEmail, updatedAt, folders, indexedFolders, syncCheckpoints, messages };
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
      ...(messagesCapped ? { messagesCapped: true } : {}),
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

    // Refuse to open this dataDir's SQLite index if it belongs to a
    // different account than the one currently configured (see
    // account-identity.ts) — must run before the Database constructor below
    // ever touches the file, so a mismatched account can never read a
    // single row of the previous account's index.
    await ensureAccountIdentityMatches(this.config.dataDir, this.config.smtp.username);

    await mkdir(dirname(this.dbPath), { recursive: true, mode: 0o700 });
    const isFirstOpen = !this.db;
    const db = this.db ?? new Database(this.dbPath);
    if (isFirstOpen) {
      this.chmodDbFiles();
    }
    // auto_vacuum only takes effect on a brand-new/empty database (page_count 0) —
    // setting the pragma alone does NOT retroactively enable incremental vacuuming
    // on a database that already existed before this line was added, and the
    // periodic incremental_vacuum call (see applySnapshot's full-sync path) is
    // itself a silent no-op until the mode has actually taken effect. Caught on
    // review: every real upgrading install (not a fresh one) has an existing,
    // already-populated database, so this "fix" reclaimed nothing for anyone
    // already hitting the growth problem it was meant to solve — confirmed
    // empirically (insert+delete rows without the pragma, reopen exactly like
    // this method does, incremental_vacuum is a proven no-op: page count doesn't
    // move). SQLite's own documented way to change an existing database's
    // auto_vacuum mode is to set the pragma then VACUUM — the VACUUM rewrites the
    // whole file and applies the pending mode during that rewrite. Do that once,
    // only when needed (mode isn't already INCREMENTAL), so a pre-existing
    // database gets converted exactly once on the first open after this fix,
    // and every open after that is a no-op check.
    db.pragma("auto_vacuum = INCREMENTAL");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("synchronous = NORMAL");
    const autoVacuumMode = db.pragma("auto_vacuum", { simple: true }) as number;
    if (autoVacuumMode !== 2) {
      this.log.warn(
        "Converting existing index database to incremental auto_vacuum (one-time)",
        "LocalIndexService",
      );
      db.exec("VACUUM");
    }

    this.runMigrations(db);
    this.db = db;
    await this.maybeImportLegacyIndex(db);

    this.initialized = true;
    return db;
  }

  // The sqlite file (and its WAL/SHM sidecars, when present) can hold sensitive mail
  // content, so restrict them to owner-only access. better-sqlite3's Database
  // constructor has no file-mode option, so this is done with an explicit chmod right
  // after opening. Best-effort: a filesystem that doesn't support chmod should log a
  // warning, not crash the server.
  private chmodDbFiles(): void {
    for (const path of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) {
      try {
        chmodSync(path, 0o600);
      } catch (error) {
        this.log.warn("Failed to set restrictive permissions on database file", "LocalIndexService", {
          path,
          error,
        });
      }
    }
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
        is_read, is_starred, flags_json, size, preview, has_attachments, attachments_json, attachment_text, labels_json,
        is_automated
      ) VALUES (
        @email_id, @folder, @uid, @seq, @message_id, @in_reply_to, @references_json, @thread_id, @subject,
        @from_json, @to_json, @cc_json, @bcc_json, @reply_to_json, @date, @internal_date,
        @is_read, @is_starred, @flags_json, @size, @preview, @has_attachments, @attachments_json, @attachment_text, @labels_json,
        @is_automated
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
        labels_json = excluded.labels_json,
        -- Same reasoning: a flags-only refresh fetches no headers, so is_automated arrives
        -- NULL; the headers of a fixed UID never change, so keeping the stored verdict is safe.
        is_automated = COALESCE(excluded.is_automated, messages.is_automated)
      RETURNING preview, attachment_text
    `);
    const upsertSyncState = db.prepare(`
      INSERT INTO sync_state (
        folder, uid_validity, uid_next, highest_uid, last_sync_at, last_full_sync_at, strategy, changed, fetched, total, backfilled_to_uid, incremental_resume_uid
      ) VALUES (
        @folder, @uid_validity, @uid_next, @highest_uid, @last_sync_at, @last_full_sync_at, @strategy, @changed, @fetched, @total, @backfilled_to_uid, @incremental_resume_uid
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
        total = excluded.total,
        backfilled_to_uid = excluded.backfilled_to_uid,
        incremental_resume_uid = excluded.incremental_resume_uid
    `);

    const deleteFts = db.prepare(`DELETE FROM messages_fts WHERE email_id = ?`);
    const insertFts = db.prepare(`
      INSERT INTO messages_fts (
        email_id, subject, preview, folder, labels, participants, attachment_names
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    // The UIDVALIDITY-embedding id format is optional per-caller (createEmailId):
    // a message indexed before that fix lives here under the old 3-field id
    // (<folder>::<uid>::<checksum>, no uidValidity), while a sync running the
    // current code now mints a 4-field id (<folder>::<uidValidity>::<uid>::
    // <checksum>) for the exact same physical message. ON CONFLICT(email_id)
    // in upsertMessage never sees this — the id STRING changed even though
    // the message didn't — so left alone, the old row is never touched and a
    // second, disjoint row appears for one physical message (see the
    // migration loop below). This is a targeted single-row lookup by the
    // exact old-format id (computed directly from folder+uid, not searched
    // for), so it's a cheap indexed PK read on every sync and, once the old
    // row is migrated away below, a cheap negative lookup forever after.
    const findLegacyRow = db.prepare(`SELECT preview, attachment_text FROM messages WHERE email_id = ?`);
    const deleteLegacyRow = db.prepare(`DELETE FROM messages WHERE email_id = ?`);
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

      // The "empty" strategy carries no UID range at all, so the range-scoped
      // expunge-detection below (cleanupExpunged) never runs for it — a folder
      // genuinely emptied on the server would otherwise keep its previously-
      // indexed messages forever. folderObservedEmpty is only set when the
      // server reported exists === 0 on a successful SELECT, never on a
      // failed/interrupted fetch, so this purge only fires on a real
      // observation. Scoped strictly to that one folder.
      for (const folderStat of input.folderStats) {
        if (folderStat.folderObservedEmpty) {
          deleteFtsForFolder.run(folderStat.folder);
          deleteMessagesForFolder.run(folderStat.folder);
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
          backfilled_to_uid: resetCheckpoint ? null : folderStat.backfilledToUid ?? null,
          incremental_resume_uid: resetCheckpoint ? null : folderStat.incrementalResumeUid ?? null,
        });
      }

      for (const email of input.emails) {
        // Migration: reconcile an old-format row for this same physical
        // message (same folder+uid) before inserting under the incoming id.
        // createEmailId(folder, uid) with no uidValidity always reconstructs
        // what the pre-UIDVALIDITY-fix id for this folder+uid would have
        // been — no search required. When email.id itself is already that
        // old format (legacyEmailId === email.id), there's nothing to
        // migrate: the row below is written under that same id as always.
        // A genuine UIDVALIDITY change (different generation reusing this
        // UID) can't be misdetected here: the folder-wipe above already
        // deleted every row for this folder before this loop runs whenever
        // the server's UIDVALIDITY no longer matches what was stored, so any
        // old-format row still found at this point is guaranteed to be the
        // same generation, not a stale one.
        //
        // parseEmailId documents a THIRD, even older shape on top of the
        // 3-field one above: <encodedFolder>::<uid>, no checksum at all —
        // from before the checksum suffix existed. A row can still be
        // sitting under that shape (an index that predates the checksum
        // feature and was never fully re-synced for this folder), and it
        // needs the exact same reconcile-then-delete treatment, or it's
        // never found and a duplicate row appears alongside it. Mirror
        // createEmailId's folder encoding but without a checksum suffix —
        // this is exactly what parseEmailId's legacy (no-checksum) branch
        // expects to parse back apart.
        let legacyPreview: string | null = null;
        let legacyAttachmentText: string | null = null;
        const legacyEmailId = createEmailId(email.folder, email.uid);
        const legacyEmailId2Field = `${encodeURIComponent(email.folder)}::${email.uid}`;
        // Check the more-recent (3-field) shape first, then the older
        // (2-field) one — a partially-migrated-through-both-stages index is
        // a genuinely degenerate case, but checking newest-first and
        // deleting whichever legacy rows are actually found still converges
        // to exactly one surviving row, never a crash or a lingering
        // duplicate, regardless of which (or both) exist.
        if (legacyEmailId !== email.id) {
          const legacyRow = findLegacyRow.get(legacyEmailId) as
            | { preview: string | null; attachment_text: string | null }
            | undefined;
          if (legacyRow) {
            legacyPreview = legacyRow.preview;
            legacyAttachmentText = legacyRow.attachment_text;
            deleteLegacyRow.run(legacyEmailId);
            deleteFts.run(legacyEmailId);
          }
        }
        if (legacyEmailId2Field !== email.id) {
          const legacyRow2Field = findLegacyRow.get(legacyEmailId2Field) as
            | { preview: string | null; attachment_text: string | null }
            | undefined;
          if (legacyRow2Field) {
            legacyPreview = legacyPreview ?? legacyRow2Field.preview;
            legacyAttachmentText = legacyAttachmentText ?? legacyRow2Field.attachment_text;
            deleteLegacyRow.run(legacyEmailId2Field);
            deleteFts.run(legacyEmailId2Field);
          }
        }

        // RETURNING gives back the post-COALESCE stored values, not the raw
        // incoming ones — a flags-only sync omits source/preview, and the
        // messages table upsert already preserves the prior indexed preview/
        // attachment_text in that case (IMAP content for a fixed UID is
        // immutable). Without this, the FTS row below would be rebuilt from
        // the incoming (empty) values and lose body-text searchability on
        // every metadata-only refresh, even though the stored row is intact.
        // The same COALESCE-style preservation applies to a migrated legacy
        // row above: this is an INSERT under a brand-new id, so
        // ON CONFLICT's COALESCE never fires for it — legacyPreview/
        // legacyAttachmentText fill that role instead.
        const persisted = upsertMessage.get({
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
          preview: email.preview ?? legacyPreview,
          has_attachments: email.hasAttachments ? 1 : 0,
          attachments_json: JSON.stringify(email.attachments),
          attachment_text: email.attachmentText ?? legacyAttachmentText,
          labels_json: JSON.stringify(email.labels),
          is_automated: email.isAutomated === undefined ? null : email.isAutomated ? 1 : 0,
        }) as { preview: string | null; attachment_text: string | null };

        const mergedPreview = persisted.preview ?? "";
        const search = emailToSearchParts({ ...email, attachmentText: persisted.attachment_text ?? undefined });
        deleteFts.run(email.id);
        insertFts.run(
          email.id,
          email.subject,
          mergedPreview,
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
        // Scoped to [rangeStartUid, rangeEndUid] — the UID range this call
        // actually re-scanned — not the whole folder. A "full" sync only
        // ever fetches one bounded window (at most a few hundred UIDs out
        // of a folder that can hold tens of thousands), so treating every
        // stored UID outside that window as "expunged" would wipe out every
        // previously-indexed message the moment a later window was synced.
        // This is what made backfill (repeated full:true calls walking the
        // window backward through history) actively destructive before this
        // fix: each new window's sync would delete every message the
        // previous window had just added.
        const deleteExpungedFts = db.prepare(`
          DELETE FROM messages_fts
          WHERE email_id IN (
            SELECT email_id
            FROM messages
            WHERE folder = ?
              AND uid BETWEEN ? AND ?
              AND uid NOT IN (SELECT uid FROM temp_snapshot_uids)
          )
        `);
        const deleteExpungedMessages = db.prepare(`
          DELETE FROM messages
          WHERE folder = ?
            AND uid BETWEEN ? AND ?
            AND uid NOT IN (SELECT uid FROM temp_snapshot_uids)
        `);
        const rangesByFullSyncFolder = new Map<string, { uids: Set<number>; rangeStartUid: number; rangeEndUid: number }>();
        for (const folderStat of input.folderStats) {
          if (folderStat.strategy === "full" && folderStat.rangeStartUid !== undefined && folderStat.rangeEndUid !== undefined) {
            rangesByFullSyncFolder.set(folderStat.folder, {
              uids: new Set<number>(),
              rangeStartUid: folderStat.rangeStartUid,
              rangeEndUid: folderStat.rangeEndUid,
            });
          }
        }
        for (const email of input.emails) {
          rangesByFullSyncFolder.get(email.folder)?.uids.add(email.uid);
        }
        for (const [folder, range] of rangesByFullSyncFolder) {
          clearSnapshotUidTable.run();
          for (const uid of range.uids) {
            insertSnapshotUid.run(uid);
          }
          deleteExpungedFts.run(folder, range.rangeStartUid, range.rangeEndUid);
          deleteExpungedMessages.run(folder, range.rangeStartUid, range.rangeEndUid);
        }
        clearSnapshotUidTable.run();
      }
    });

    transaction();

    if (cleanupExpunged) {
      // auto_vacuum = INCREMENTAL (set in ensureDb) only marks freed pages as
      // reclaimable — it doesn't return them to the OS on its own. This companion
      // pragma actually reclaims them. Run it here (outside the transaction, after
      // commit) rather than on every write: this full-sync path is already the
      // heaviest/least-frequent write path, so the extra maintenance cost is
      // proportionate.
      db.pragma("incremental_vacuum");
    }
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
        labels_json TEXT NOT NULL,
        is_automated INTEGER
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
        total INTEGER,
        backfilled_to_uid INTEGER,
        incremental_resume_uid INTEGER
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
    // Nullable on purpose: existing rows read back as NULL (= isAutomated undefined) so the
    // actionable-thread scorer falls back to the sender regex for them instead of treating
    // every pre-migration message as human. A full re-sync backfills the real value.
    if (!columns.has("is_automated")) {
      db.exec(`ALTER TABLE messages ADD COLUMN is_automated INTEGER`);
    }

    const syncStateColumns = new Set(
      (db.prepare(`PRAGMA table_info(sync_state)`).all() as Array<{ name: string }>).map((row) => row.name),
    );
    if (!syncStateColumns.has("backfilled_to_uid")) {
      db.exec(`ALTER TABLE sync_state ADD COLUMN backfilled_to_uid INTEGER`);
    }
    if (!syncStateColumns.has("incremental_resume_uid")) {
      db.exec(`ALTER TABLE sync_state ADD COLUMN incremental_resume_uid INTEGER`);
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
    // Every term is quoted as a literal FTS5 string, including tokens that collide
    // with FTS5 keywords (AND/OR/NOT/NEAR) or start with a leading hyphen. A quoted
    // term is always treated as literal text by FTS5, never as an operator or a
    // NOT-prefix, so this searches for the term itself instead of silently dropping
    // it (e.g. `AND gate schematics` now matches "AND", "gate" and "schematics" all
    // required, rather than dropping "AND" and searching only the other two).
    const match = parsed.residualTerms
      .map((token) => `"${token.replace(/"/g, '""')}"`)
      .join(" AND ");

    if (!match) {
      // No terms survived parsing at all (e.g. an empty/whitespace-only query), so
      // the query never actually ran — this is "search couldn't run", not "no results".
      return {
        ids: [],
        warning: `Search query "${query}" contained no searchable terms — the search did not run.`,
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

  // Metadata/folders only — no messages table query at all. Split out of loadSnapshot()
  // so callers that don't need message rows (getStatus, getThreads, getThreadById) don't
  // pay for them.
  private loadFoldersAndMetadata(db: Database.Database): {
    ownerEmail?: string;
    updatedAt?: string;
    folders: FolderInfo[];
    indexedFolders: IndexedFolderState[];
  } {
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

    return {
      ownerEmail: metadata.ownerEmail || undefined,
      updatedAt: metadata.updatedAt || undefined,
      folders,
      indexedFolders,
    };
  }

  // sync_state only — no messages table query. Used directly by getSyncCheckpointMap()
  // (which never needs a message row) and by loadSnapshot()/getStatus()/getThreads()/
  // getThreadById() so none of them duplicate this query inline.
  private loadCheckpointsSync(db: Database.Database): MailboxSyncCheckpoint[] {
    return db
      .prepare(`
        SELECT folder, uid_validity, uid_next, highest_uid, last_sync_at, last_full_sync_at, strategy, changed, fetched, total, backfilled_to_uid, incremental_resume_uid
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
        // SQLite returns null (not undefined) for an unset column — but
        // planFolderSync distinguishes "no prior backfill" (undefined) from
        // a real floor value, and null <= 1 is true in JS, so a null here
        // was silently treated as "already backfilled to UID 1" on the very
        // first full sync after this column was introduced. Found live:
        // the first sync_emails(full:true) call after upgrading returned
        // changed:false, fetched:0 instead of starting the newest window.
        backfilledToUid: (row as { backfilled_to_uid?: number | null }).backfilled_to_uid ?? undefined,
        // Same NULL-vs-undefined pitfall as backfilledToUid above: planFolderSync
        // treats undefined as "no incremental catch-up in progress" and a real
        // number as "resume from here" — a null read back as null (not undefined)
        // would be indistinguishable from a legitimate resume-at-0 edge case in
        // some comparisons, so map it away explicitly here too.
        incrementalResumeUid: (row as { incremental_resume_uid?: number | null }).incremental_resume_uid ?? undefined,
      } satisfies MailboxSyncCheckpoint));
  }

  // The message-row query, capped at DEFAULT_SNAPSHOT_LIMIT by default — split out of
  // loadSnapshot() so getThreads() can call it directly (or substitute
  // loadThreadCandidateMessages() below) without re-fetching folders/checkpoints.
  private loadMessages(db: Database.Database, options: SnapshotLoadOptions): EmailSummary[] {
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

    return db
      .prepare(messageSqlParts.join(" "))
      .all(...messageParams)
      .map((row) => this.rowToEmailSummary(row as MessageRow));
  }

  // getThreads()'s filtered path: filter/search in SQL first (the same pattern
  // loadCandidateEmails()/search() already use — a safe LIKE-based superset over every
  // field the JS-level filter in getThreads() checks), then expand each match's
  // persisted thread_id membership directly by that column, unbounded by
  // DEFAULT_SNAPSHOT_LIMIT — so a thread is found and built complete even when most of
  // its messages sit outside the newest 5000.
  private loadThreadCandidateMessages(
    db: Database.Database,
    input: { folder?: string; label?: string; query?: string },
  ): EmailSummary[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (input.folder) {
      conditions.push(`folder = ?`);
      params.push(input.folder);
    }
    if (input.label) {
      const labelNeedle = escapeLike(input.label.toLowerCase());
      conditions.push(`(LOWER(folder) LIKE ? ESCAPE '\\' OR LOWER(labels_json) LIKE ? ESCAPE '\\')`);
      params.push(`%${labelNeedle}%`, `%${labelNeedle}%`);
    }
    if (input.query) {
      const needle = `%${escapeLike(input.query.toLowerCase())}%`;
      conditions.push(
        `(LOWER(subject) LIKE ? ESCAPE '\\' OR LOWER(from_json) LIKE ? ESCAPE '\\' OR LOWER(to_json) LIKE ? ESCAPE '\\' OR LOWER(cc_json) LIKE ? ESCAPE '\\' OR LOWER(bcc_json) LIKE ? ESCAPE '\\' OR LOWER(labels_json) LIKE ? ESCAPE '\\')`,
      );
      params.push(needle, needle, needle, needle, needle, needle);
    }

    const sql = `SELECT * FROM messages${conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : ""}`;
    const candidates = db
      .prepare(sql)
      .all(...params)
      .map((row) => this.rowToEmailSummary(row as MessageRow));

    const byId = new Map(candidates.map((email) => [email.id, email]));

    const threadIds = [...new Set(
      candidates.map((email) => email.threadId?.trim()).filter((id): id is string => Boolean(id)),
    )];
    const CHUNK_SIZE = 200;
    for (let i = 0; i < threadIds.length; i += CHUNK_SIZE) {
      const chunk = threadIds.slice(i, i + CHUNK_SIZE);
      const rows = db
        .prepare(`SELECT * FROM messages WHERE thread_id IN (${chunk.map(() => "?").join(", ")})`)
        .all(...chunk);
      for (const row of rows) {
        const email = this.rowToEmailSummary(row as MessageRow);
        byId.set(email.id, email);
      }
    }

    // A candidate with no persisted thread_id but a References/In-Reply-To header
    // is only a PARTIAL view of its (unpersisted) reference chain — the same chain
    // assignResolvedThreadKeys() walks when buildThreads() runs on whatever we
    // return. Handing back just the SQL-matched subset would make that walk
    // compute a synthetic "ref:..." id from incomplete membership, different from
    // the id an unfiltered getThreads() call would compute for the same thread
    // (see Finding 1 in the thread-identity review). So whenever such a candidate
    // is present, pull in the full, uncapped message set — the same source
    // getThreadById() now uses for these threads — so the thread is always built
    // from its complete membership, filtered query or not.
    const hasUnresolvedReferenceCandidate = candidates.some(
      (email) => !email.threadId?.trim() && (email.inReplyTo || (email.references?.length ?? 0) > 0),
    );
    if (hasUnresolvedReferenceCandidate) {
      for (const email of this.loadAllMessages(db)) {
        byId.set(email.id, email);
      }
    }

    return [...byId.values()];
  }

  // Uncapped message read, unlike loadMessages() (deliberately capped at
  // DEFAULT_SNAPSHOT_LIMIT). Used only where correctness requires seeing every
  // message regardless of index size — resolving a fallback/reference-chain
  // thread's full membership (see loadThreadCandidateMessages() and
  // getThreadById() above).
  private loadAllMessages(db: Database.Database): EmailSummary[] {
    return db
      .prepare(`SELECT * FROM messages`)
      .all()
      .map((row) => this.rowToEmailSummary(row as MessageRow));
  }

  // Shared second half of the SQL-prefilter-then-expand pattern getThreads()'
  // loadThreadCandidateMessages() introduced: given a set of candidate messages found
  // by some SQL condition, pull in the rest of each candidate's persisted thread_id
  // membership (unbounded by DEFAULT_SNAPSHOT_LIMIT), and — for a candidate whose
  // thread is only resolvable via a References/In-Reply-To chain (no persisted
  // thread_id) — fall back to the full, uncapped message set so that thread is always
  // built from its complete membership rather than a partial view with a different
  // synthetic id (see loadThreadCandidateMessages()'s comment on this same risk).
  // Used by getFollowUpCandidates(), getActionableThreads(), getInboxDigest()'s
  // stale-awaiting-you section, findDocumentThreads(), and getMeetingPrep() below —
  // each has its own SQL candidate query but needs the identical expansion afterward.
  private expandCandidatesToFullThreads(db: Database.Database, candidates: EmailSummary[]): EmailSummary[] {
    const byId = new Map(candidates.map((email) => [email.id, email]));

    const threadIds = [...new Set(
      candidates.map((email) => email.threadId?.trim()).filter((id): id is string => Boolean(id)),
    )];
    const CHUNK_SIZE = 200;
    for (let i = 0; i < threadIds.length; i += CHUNK_SIZE) {
      const chunk = threadIds.slice(i, i + CHUNK_SIZE);
      const rows = db
        .prepare(`SELECT * FROM messages WHERE thread_id IN (${chunk.map(() => "?").join(", ")})`)
        .all(...chunk);
      for (const row of rows) {
        const email = this.rowToEmailSummary(row as MessageRow);
        byId.set(email.id, email);
      }
    }

    const hasUnresolvedReferenceCandidate = candidates.some(
      (email) => !email.threadId?.trim() && (email.inReplyTo || (email.references?.length ?? 0) > 0),
    );
    if (hasUnresolvedReferenceCandidate) {
      for (const email of this.loadAllMessages(db)) {
        byId.set(email.id, email);
      }
    }

    return [...byId.values()];
  }

  private async loadSnapshot(options: SnapshotLoadOptions = {}): Promise<SnapshotData> {
    const db = await this.ensureDb();
    const { ownerEmail, updatedAt, folders, indexedFolders } = this.loadFoldersAndMetadata(db);
    const syncCheckpoints = this.loadCheckpointsSync(db);
    const messages = this.loadMessages(db, options);

    return {
      ownerEmail,
      updatedAt,
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
      isAutomated: row.is_automated === null || row.is_automated === undefined ? undefined : Boolean(row.is_automated),
    };
  }

  private toStatus(
    snapshot: SnapshotData,
    counts: { storedMessageCount: number; dedupedMessageCount: number },
  ): LocalIndexStatus {
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
      storedMessageCount: counts.storedMessageCount,
      dedupedMessageCount: counts.dedupedMessageCount,
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
