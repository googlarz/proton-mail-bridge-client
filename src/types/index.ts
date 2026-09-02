export interface ProtonConnectionConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
}

export interface ProtonMailConfig {
  smtp: ProtonConnectionConfig;
  imap: ProtonConnectionConfig;
  dataDir: string;
  debug: boolean;
  cacheEnabled: boolean;
  analyticsEnabled: boolean;
  autoSync: boolean;
  syncInterval: number;
  runtime: ProtonRuntimeConfig;
}

export interface EmailAddress {
  name?: string;
  address?: string;
}

export interface EmailAttachmentInput {
  filename: string;
  content: string;
  contentType?: string;
  cid?: string;
  contentDisposition?: string;
}

export type SnoozeStatus = "pending" | "woken" | "canceled" | "failed";

export interface SnoozeRecord {
  id: string;
  createdAt: string;
  wakeAt: string;
  status: SnoozeStatus;
  originalFolder: string;
  // The email's current composite id — updates on every move (snooze-out,
  // wake, or cancel-restore) since IMAP UIDs change when a message moves.
  currentEmailId: string;
  wokenAt?: string;
  failureReason?: string;
  // Consecutive failed wake attempts. After MAX_WAKE_FAILURES, status flips
  // to the terminal "failed" instead of retrying every 15s forever.
  failureCount?: number;
}

export interface EmailTemplateRecord {
  id: string;
  name: string;
  subject: string;
  body: string;
  isHtml: boolean;
  variables: string[];
  createdAt: string;
}

export type DeliveryQueueKind = "undo_send" | "scheduled_send";
// "sending" is a short-lived claim state: set under the lock right before the
// SMTP call so cancel() and overlapping checkDue() passes can never act on an
// item that's already in flight. A "sending" record found at startup means
// the previous process died mid-send; it is never auto-resent (outcome
// unknown) — see DeliveryQueueService.recoverInterruptedSends.
export type DeliveryQueueStatus = "pending" | "sending" | "sent" | "canceled" | "failed";

export interface DeliveryQueueRecord {
  id: string;
  kind: DeliveryQueueKind;
  createdAt: string;
  sendAt: string;
  status: DeliveryQueueStatus;
  payload: SendEmailInput;
  sentAt?: string;
  sentMessageId?: string;
  failureReason?: string;
  // Set only for kind:"scheduled_send" entries created from schedule_draft —
  // lets send_draft detect and refuse a still-pending scheduled send for the
  // same draft, instead of firing a second, independent send. See the
  // schedule_draft/send_draft handlers.
  sourceDraftId?: string;
}

export interface SendEmailInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  isHtml?: boolean;
  /** Pre-rendered HTML body. When set, sent as multipart/alternative with `body` as plain-text fallback. */
  htmlBody?: string;
  /** Override the display name in the From header without changing the address. */
  fromName?: string;
  /** Strip scripts, event handlers, and remote image beacons before delivery. Defaults to true when body is HTML. */
  sanitizeHtml?: boolean;
  priority?: "high" | "normal" | "low";
  replyTo?: string;
  inReplyTo?: string;
  references?: string[];
  messageId?: string;
  attachments?: EmailAttachmentInput[];
  /** Request a read receipt (MDN) by adding a Disposition-Notification-To header pointing at the sender. Most mail clients ask the recipient before honoring it — this is a request, not a guarantee. */
  requestReadReceipt?: boolean;
  /** Append PROTONMAIL_SIGNATURE (if configured) to the body. Defaults to true. */
  appendSignature?: boolean;
}

export interface EmailAttachmentSummary {
  id?: string;
  filename?: string;
  contentType?: string;
  size?: number;
  disposition?: string;
  part?: string;
  cid?: string;
  checksum?: string;
  isInline?: boolean;
  kind?: "document" | "image" | "calendar" | "signature" | "archive" | "message" | "text" | "other";
  isCalendarInvite?: boolean;
  isSignature?: boolean;
}

export interface EmailSummary {
  id: string;
  folder: string;
  uid: number;
  seq: number;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  threadId?: string;
  subject: string;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  replyTo: EmailAddress[];
  date?: string;
  internalDate?: string;
  isRead: boolean;
  isStarred: boolean;
  flags: string[];
  size?: number;
  preview?: string;
  hasAttachments: boolean;
  attachments: EmailAttachmentSummary[];
  attachmentText?: string;
  labels: string[];
}

export interface EmailDetail extends EmailSummary {
  text?: string;
  html?: string | false;
  // Values are usually string | string[], but a few headers (list, and any
  // future unrecognized structured header) are kept as nested objects rather
  // than flattened — see SimpleIMAPService.mapHeaderValue.
  headers: Record<string, unknown>;
}

export type DraftMode = "compose" | "reply" | "forward";
export type DraftStatus = "draft" | "sent";

export interface DraftSendResult {
  messageId?: string;
  accepted: string[];
  rejected: string[];
  response: string;
}

export interface RemoteDraftRef {
  folder: string;
  uid?: number;
  emailId?: string;
  messageId?: string;
  syncedAt: string;
}

export interface DraftRecord {
  id: string;
  status: DraftStatus;
  mode: DraftMode;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  isHtml: boolean;
  priority?: "high" | "normal" | "low";
  replyTo?: string;
  inReplyTo?: string;
  references?: string[];
  draftMessageId: string;
  attachments: EmailAttachmentInput[];
  sourceEmailId?: string;
  sourceMessageId?: string;
  notes?: string;
  remoteSyncState: "local_only" | "synced" | "sync_failed";
  remoteSyncError?: string;
  remoteDraft?: RemoteDraftRef;
  lastSendResult?: DraftSendResult;
}

export interface MailboxMessageLocation {
  emailId: string;
  folder: string;
  uid: number;
  labels: string[];
  specialUse?: string;
  isRead: boolean;
  isStarred: boolean;
}

export interface MailboxMessage extends EmailSummary {
  canonicalId: string;
  primaryEmailId: string;
  threadKey: string;
  mailboxRole: string;
  normalizedLabels: string[];
  locations: MailboxMessageLocation[];
}

export interface MailboxLabel {
  id: string;
  name: string;
  type: "folder" | "label" | "special_use";
  messageCount: number;
  unreadCount: number;
  threadCount: number;
  specialUse?: string;
}

export interface ThreadSummary {
  id: string;
  subject: string;
  messageCount: number;
  unreadCount: number;
  latestDate?: string;
  participants: EmailAddress[];
  normalizedLabels: string[];
  messageIds: string[];
}

export interface ThreadDetail extends ThreadSummary {
  messages: MailboxMessage[];
}

export interface ActionableThreadSummary extends ThreadSummary {
  latestEmailId?: string;
  latestPreview?: string;
  latestFrom: EmailAddress[];
  latestIsRead: boolean;
  latestIsStarred: boolean;
  latestHasAttachments: boolean;
  pendingOn: "you" | "them" | "unknown";
  score: number;
}

export type EmailAction =
  | "mark_read"
  | "mark_unread"
  | "star"
  | "unstar"
  | "archive"
  | "trash"
  | "restore"
  | "move"
  | "delete";

export interface BatchActionEntry {
  emailId: string;
  ok: boolean;
  action: EmailAction;
  result?: unknown;
  error?: string;
}

export interface BatchActionResult {
  action: EmailAction;
  total: number;
  succeeded: number;
  failed: number;
  results: BatchActionEntry[];
}

export interface AttachmentContentResult {
  emailId: string;
  attachment: EmailAttachmentSummary;
  text?: string;
  base64?: string;
  outputPath?: string;
}

export interface CitationSource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  provider?: string;
  snippet?: string;
  locator?: Record<string, unknown>;
}

export interface FolderInfo {
  path: string;
  name: string;
  delimiter: string;
  specialUse?: string;
  listed: boolean;
  subscribed: boolean;
  noselect?: boolean;
  flags: string[];
  messages?: number;
  unseen?: number;
  uidNext?: number;
}

export interface BulkMatchCriteria {
  from?: string;
  subject?: string;
  text?: string;
  since?: string;
  before?: string;
  isRead?: boolean;
  isStarred?: boolean;
  sizeLarger?: number;
  sizeSmaller?: number;
}

export interface BulkOperationResult {
  dryRun: boolean;
  total: number;
  succeeded: number;
  failed: number;
  notFound: number;
  results: Array<{
    uid: number;
    emailId: string;
    ok: boolean;
    error?: string;
    notApplied?: string[];
  }>;
}

export interface SenderFrequency {
  address: string;
  name?: string;
  count: number;
  direction: "received" | "self";
}

export interface GetEmailsInput {
  folder?: string;
  limit?: number;
  offset?: number;
  beforeUid?: number;
  sortByUid?: "asc" | "desc";
  includeSnippet?: boolean;
}

export interface SearchEmailsInput {
  query?: string;
  folder?: string;
  label?: string;
  threadId?: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  senderDomain?: string;
  subject?: string;
  hasAttachment?: boolean;
  attachmentName?: string;
  isRead?: boolean;
  isStarred?: boolean;
  mailboxRole?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  includeSnippet?: boolean;
  sizeLarger?: number;
  sizeSmaller?: number;
  listId?: string;
  messageId?: string;
}

export interface SyncEmailsInput {
  folder?: string;
  full?: boolean;
  limitPerFolder?: number;
  includeAttachmentText?: boolean;
  checkpoints?: Record<string, MailboxSyncCheckpoint>;
}

export interface MailboxSyncCheckpoint {
  folder: string;
  uidValidity?: string;
  uidNext?: number;
  highestUid?: number;
  lastSyncAt?: string;
  lastFullSyncAt?: string;
  strategy?: "empty" | "recent" | "full" | "incremental" | "incremental_window";
  changed?: boolean;
  fetched?: number;
  total?: number;
}

export interface LocalIndexStatus {
  path: string;
  ownerEmail?: string;
  updatedAt?: string;
  ageMinutes?: number;
  staleThresholdMinutes: number;
  isStale: boolean;
  folderCount: number;
  labelCount: number;
  threadCount: number;
  storedMessageCount: number;
  dedupedMessageCount: number;
  syncCheckpoints: MailboxSyncCheckpoint[];
  folders: Array<{
    path: string;
    messages?: number;
    unseen?: number;
    specialUse?: string;
    lastIndexedAt?: string;
    lastIndexedCount?: number;
  }>;
}

export interface ProtonRuntimeConfig {
  readOnly: boolean;
  allowSend: boolean;
  allowRemoteDraftSync: boolean;
  allowedActions: EmailAction[];
  startupSync: boolean;
  autoSyncFolder?: string;
  autoSyncFull: boolean;
  autoSyncLimitPerFolder: number;
  idleWatchEnabled: boolean;
  idleMaxSeconds: number;
  confirmDestructive: boolean;
  allowEmptyFolder: boolean;
  restrictOutboundToSelf: boolean;
  allowFileDownloadDir?: string;
  maxInlineBytes: number;
  opDelayMs: number;
  // Undo-send window: 0 disables (send immediately, current default behavior).
  // When >0, send_email queues instead of sending immediately, cancelable via
  // cancel_send until the window elapses. See DeliveryQueueService's own
  // caveat: this only fires while the server process stays alive.
  sendDelaySeconds: number;
}

export interface BackgroundSyncStatus {
  enabled: boolean;
  running: boolean;
  intervalMinutes: number;
  folder?: string;
  full: boolean;
  limitPerFolder: number;
  startupSync: boolean;
  idleEnabled: boolean;
  idleWatching: boolean;
  idleMaxSeconds: number;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  lastIdleAt?: string;
  lastIdleChangeAt?: string;
  lastIdleEventCount?: number;
  lastIdleError?: string;
  lastFailureKind?: "auth" | "transient";
  lastFailureMessage?: string;
  backoffUntil?: string;
  nextRunAt?: string;
}

export interface ContactStats {
  address: string;
  name?: string;
  incoming: number;
  outgoing: number;
  totalMessages: number;
  lastContactAt?: string;
}

export interface VolumeTrendPoint {
  date: string;
  count: number;
  unreadCount: number;
  starredCount: number;
  attachmentCount: number;
}

export interface LogEntry {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  context?: string;
  message: string;
  data?: unknown;
}

export interface AuditEntry {
  timestamp: string;
  tool: string;
  status: "success" | "error";
  durationMs?: number;
  input?: unknown;
  result?: unknown;
  error?: string;
}
