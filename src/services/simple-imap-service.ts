import { realpathSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { ImapFlow, type FetchMessageObject, type ListResponse, type SearchObject } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import type {
  AttachmentContentResult,
  BulkMatchCriteria,
  BulkOperationResult,
  EmailDetail,
  EmailSummary,
  FolderInfo,
  GetEmailsInput,
  MailboxSyncCheckpoint,
  ProtonMailConfig,
  RemoteDraftRef,
  SearchEmailsInput,
  SenderFrequency,
  SendEmailInput,
  SyncEmailsInput,
} from "../types/index.js";
import {
  classifyAttachment,
  createEmailId,
  dedupeEmails,
  extractAttachments,
  extractMessageIdList,
  isTextLikeMimeType,
  mapEnvelopeAddresses,
  mapParsedAddresses,
  matchesLocalSearchFilters,
  nextDay,
  normalizeLimit,
  parseDateInput,
  htmlToMarkdown,
  parseEmailId,
  previewText,
  sanitizeFileName,
  sortEmailsByNewest,
  stripHtmlToText,
  summarizeCalendarText,
} from "../utils/helpers.js";
import { logger, type Logger } from "../utils/logger.js";

const FETCH_SUMMARY_QUERY = {
  uid: true,
  flags: true,
  envelope: true,
  internalDate: true,
  size: true,
  bodyStructure: true,
  labels: true,
} as const;

const FETCH_DETAIL_QUERY = {
  ...FETCH_SUMMARY_QUERY,
  source: true,
} as const;

const FETCH_INDEX_QUERY = {
  uid: true,
  flags: true,
  envelope: true,
  internalDate: true,
  size: true,
  bodyStructure: true,
} as const;

// Indexing needs the message source to populate preview/attachmentText for FTS body
// search — collectFolderForIndex previously used FETCH_INDEX_QUERY (no source), so
// every indexed message's preview and attachmentText silently stayed undefined and
// search_indexed_emails' body search always returned nothing.
const FETCH_INDEX_DETAIL_QUERY = {
  ...FETCH_INDEX_QUERY,
  source: true,
} as const;

const MAX_ATTACHMENT_TEXT_BYTES = 512_000;
// A healthy IMAP IDLE blocks until a mailbox change or the requested timeout.
// If client.idle() returns faster than this with no events, IDLE never actually
// engaged (e.g. imapflow's `idling` flag stuck true after Proton Bridge ended
// the session server-side) and we must recover instead of busy-spinning.
const MIN_HEALTHY_IDLE_MS = 500;
// A fast, event-less idle() return isn't on its own proof of a stuck connection —
// imapflow's preCheck/DONE mechanism is *designed* to interrupt an active IDLE the
// instant any other command needs the same shared connection (a foreground tool
// call, background sync's periodic collectEmailsForIndex, ...), and that legitimate
// interruption looks identical from here: no events, near-instant return. Forcing a
// full disconnect on every one of those — as a single fast return used to — turns
// ordinary connection sharing into a reconnect storm, which is what was actually
// producing the "Connection not available" races elsewhere in this file. Only
// escalate to a real disconnect after several fast/event-less returns *in a row*,
// which is what the originally-observed stuck-idle incident (a busy-spin burning a
// full CPU core for days) actually looked like.
const MAX_CONSECUTIVE_FAST_IDLE_RETURNS = 5;
// Grace period past timeoutMs before waitForMailboxChanges' own hard timeout
// fires — see the comment at its Promise.race for why a caller-side timeout
// can't rely on imapflow's graceful preCheck break alone.
const HARD_IDLE_TIMEOUT_GRACE_MS = 5_000;
const UID_VALIDITY_MISMATCH_ERROR = "UID validity mismatch - local index is stale, run sync_emails to refresh";

function collectErrorText(error: unknown): string {
  const values: string[] = [];

  if (error instanceof Error) {
    values.push(error.message);
    values.push(error.name);
    const maybeResponseText = (error as { responseText?: unknown }).responseText;
    if (typeof maybeResponseText === "string") {
      values.push(maybeResponseText);
    }
    const maybeCode = (error as { code?: unknown }).code;
    if (typeof maybeCode === "string") {
      values.push(maybeCode);
    }
  } else if (typeof error === "string") {
    values.push(error);
  } else if (typeof error === "object" && error !== null) {
    const maybeMessage = (error as { message?: unknown }).message;
    const maybeCode = (error as { code?: unknown }).code;
    const maybeResponse = (error as { response?: unknown }).response;
    if (typeof maybeMessage === "string") {
      values.push(maybeMessage);
    }
    if (typeof maybeCode === "string") {
      values.push(maybeCode);
    }
    if (typeof maybeResponse === "string") {
      values.push(maybeResponse);
    }
  }

  return values.join(" ").toLowerCase();
}

// imapflow throws a generic Error("Command failed") for every IMAP NO/BAD
// response (mailbox create/rename/delete, move, flag change, ...) — the
// server's actual reason (e.g. Bridge rejecting a reserved folder name)
// lives in the non-standard `.responseText` property, never in `.message`.
// Left alone, every one of these surfaces as an unhelpful "Command failed"
// with no clue why. Surface both. Found live: create_label "Starred" failed
// with just "Command failed" instead of Bridge's actual rejection reason.
export function describeImapError(error: unknown): string | undefined {
  if (!(error instanceof Error) || !error.message) {
    return undefined;
  }
  const responseText = (error as { responseText?: unknown }).responseText;
  if (typeof responseText === "string" && responseText.trim() && !error.message.includes(responseText.trim())) {
    return `${error.message}: ${responseText.trim()}`;
  }
  return error.message;
}

export function isLikelyAuthenticationError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  const haystack = collectErrorText(error);
  if (!haystack) {
    return false;
  }

  return [
    "auth",
    "login failed",
    "incorrect login credentials",
    "invalid credentials",
    "authentication failed",
    "no such user",
    "too many login attempts",
  ].some((needle) => haystack.includes(needle));
}

// Distinguishes "Bridge isn't running / wrong host-port" from other failures, so the
// caller can point the user at Bridge instead of a generic "internal error occurred".
export function isLikelyConnectionError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  const haystack = collectErrorText(error);
  if (!haystack) {
    return false;
  }

  return [
    "econnrefused",
    "enotfound",
    "etimedout",
    "ehostunreach",
    "econnreset",
    "connect etimedout",
    "connection closed",
    "connection timed out",
    "timed out while connecting",
  ].some((needle) => haystack.includes(needle));
}

// UID order does not track date order (e.g. after a cross-provider import), so picking
// the target subset by UID (slice(-limit)) can silently drop the newest messages. This
// picks by INTERNALDATE instead. See GitHub issue #6.
export function pickNewestUids(dated: { uid: number; date: number }[], limit: number): number[] {
  return [...dated]
    .sort((a, b) => b.date - a.date)
    .slice(0, limit)
    .map((entry) => entry.uid);
}

export interface FolderSyncPlan {
  folder: string;
  strategy: MailboxSyncCheckpoint["strategy"];
  changed: boolean;
  startUid?: number;
  endUid?: number;
  highestKnownUid: number;
}

export function planFolderSync(input: {
  folder: string;
  exists: number;
  uidNext?: number;
  uidValidity?: string;
  full: boolean;
  limit: number;
  checkpoint?: MailboxSyncCheckpoint;
}): FolderSyncPlan {
  const uidNext = input.uidNext ?? 1;
  const highestKnownUid = Math.max(0, uidNext - 1);

  if (input.exists === 0 || highestKnownUid === 0) {
    return {
      folder: input.folder,
      strategy: "empty",
      changed: false,
      highestKnownUid,
    };
  }

  if (input.full) {
    return {
      folder: input.folder,
      strategy: "full",
      changed: true,
      startUid: Math.max(1, highestKnownUid - input.limit + 1),
      endUid: highestKnownUid,
      highestKnownUid,
    };
  }

  if (
    !input.checkpoint ||
    !input.checkpoint.highestUid ||
    (input.checkpoint.uidValidity && input.uidValidity && input.checkpoint.uidValidity !== input.uidValidity)
  ) {
    return {
      folder: input.folder,
      strategy: "recent",
      changed: true,
      startUid: Math.max(1, highestKnownUid - input.limit + 1),
      endUid: highestKnownUid,
      highestKnownUid,
    };
  }

  if (highestKnownUid < (input.checkpoint?.highestUid ?? 0)) {
    return {
      folder: input.folder,
      strategy: "full",
      changed: true,
      startUid: Math.max(1, highestKnownUid - input.limit + 1),
      endUid: highestKnownUid,
      highestKnownUid,
    };
  }

  const overlap = Math.min(input.limit, Math.max(25, Math.min(100, Math.ceil(input.limit / 2))));
  const changed =
    highestKnownUid > (input.checkpoint.highestUid ?? 0) ||
    uidNext !== (input.checkpoint.uidNext ?? uidNext) ||
    input.exists !== (input.checkpoint.total ?? input.exists);
  return {
    folder: input.folder,
    strategy: changed ? "incremental" : "incremental_window",
    changed,
    startUid: Math.max(1, Math.min(highestKnownUid, input.checkpoint.highestUid) - overlap + 1),
    endUid: highestKnownUid,
    highestKnownUid,
  };
}

function mapFolder(entry: ListResponse): FolderInfo {
  const noselect = entry.flags
    ? Array.from(entry.flags).some((f) => f.toLowerCase() === "\\noselect")
    : false;

  // Prefer the specialUse attribute reported by the server; fall back to name heuristics.
  let specialUse = entry.specialUse || undefined;
  if (!specialUse) {
    const { path, name } = entry;
    if (path === "Sent" || path.endsWith("/Sent") || name === "Sent") specialUse = "\\Sent";
    else if (path === "Trash" || path.endsWith("/Trash") || name === "Trash") specialUse = "\\Trash";
    else if (path === "Drafts" || path.endsWith("/Drafts") || name === "Drafts") specialUse = "\\Drafts";
    else if (path === "Spam" || path === "Junk" || name === "Spam" || name === "Junk") specialUse = "\\Junk";
    else if (path === "Archive" || name === "Archive") specialUse = "\\Archive";
    else if (path === "INBOX" || name === "INBOX") specialUse = "\\Inbox";
  }

  return {
    path: entry.path,
    name: entry.name,
    delimiter: entry.delimiter,
    specialUse,
    listed: entry.listed,
    subscribed: entry.subscribed,
    noselect,
    flags: [...entry.flags],
    messages: entry.status?.messages,
    unseen: entry.status?.unseen,
    uidNext: entry.status?.uidNext,
  };
}

function createParsedAttachmentId(
  attachment: NonNullable<ParsedMail["attachments"]>[number],
  index: number,
): string {
  return attachment.checksum || attachment.cid || `attachment-${index + 1}`;
}

// mailparser structures several headers as objects rather than strings:
//   - from/to/cc/bcc/sender/reply-to/delivered-to/return-path/disposition-notification-to
//     -> { value: AddressEntry[], html, text }
//   - content-type/content-disposition/dkim-signature -> { value: string, params: Record<string,string> }
//   - list (merged from List-Unsubscribe/List-Id/etc.) -> a nested object, kept structured
//     since callers (e.g. the unsubscribe tool) need list.unsubscribe.url/.mail directly.
// A blind String(value) on any of these produces the literal string "[object Object]".
export function mapHeaderValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => mapHeaderValue(item));
  }
  if (typeof value !== "object") {
    return String(value);
  }

  const obj = value as Record<string, unknown>;
  // Address-type header: prefer the readable "Name <addr>, Name2 <addr2>" text mailparser
  // already computed over the raw parsed array.
  if (typeof obj.text === "string" && Array.isArray(obj.value)) {
    return obj.text;
  }
  // content-type / content-disposition / dkim-signature: reconstruct a readable header string.
  if (typeof obj.value === "string" && obj.params && typeof obj.params === "object") {
    const params = Object.entries(obj.params as Record<string, unknown>)
      .map(([paramKey, paramValue]) => `${paramKey}=${String(paramValue)}`)
      .join("; ");
    return params ? `${obj.value}; ${params}` : obj.value;
  }
  // 'list' and any other unrecognized structured header: keep as a plain nested object
  // rather than stringifying it away — JSON.stringify renders it correctly downstream.
  return Object.fromEntries(
    Object.entries(obj).map(([nestedKey, nestedValue]) => [nestedKey, mapHeaderValue(nestedValue)]),
  );
}

export class SimpleIMAPService {
  private client?: ImapFlow;
  private folderCache?: FolderInfo[];
  private readonly messageCache = new Map<string, EmailSummary>();
  private lastSyncAt?: string;
  private lastIdleAt?: string;
  private lastIdleChangeAt?: string;
  private lastIdleEventCount?: number;
  private lastIdleError?: string;
  private _lastOpTs = 0;
  private _connectingPromise?: Promise<void>;
  private readonly _idleActive = new Map<string, boolean>();
  private consecutiveFastIdleReturns = 0;

  constructor(
    private readonly config: ProtonMailConfig,
    private readonly log: Logger = logger,
    private readonly opDelayMs = 0,
  ) {}

  async connect(): Promise<void> {
    if (this.client?.usable) {
      return;
    }

    // Inflight-promise guard: if a connect() is already in progress, wait for
    // it rather than racing to create a second TCP connection (zombie guard).
    if (this._connectingPromise) {
      return this._connectingPromise;
    }

    this._connectingPromise = (async () => {
      await this.disconnect();

      const client = new ImapFlow({
        host: this.config.imap.host,
        port: this.config.imap.port,
        secure: this.config.imap.secure,
        doSTARTTLS: this.config.imap.secure ? undefined : true,
        auth: {
          user: this.config.imap.username,
          pass: this.config.imap.password,
        },
        tls: this.shouldRelaxTlsVerification() ? { rejectUnauthorized: false } : undefined,
        disableAutoIdle: true,
        maxIdleTime: this.config.runtime.idleMaxSeconds * 1000,
        logger: false,
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
      });

      client.on("error", (error) => {
        this.log.warn("IMAP client error", "IMAPService", error);
      });

      await client.connect();
      this.client = client;
    })().finally(() => {
      this._connectingPromise = undefined;
    });

    return this._connectingPromise;
  }

  async disconnect(): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      if (this.client.usable) {
        await this.client.logout();
      } else {
        this.client.close();
      }
    } catch (error) {
      this.log.warn("IMAP disconnect failed", "IMAPService", error);
      this.client.close();
    } finally {
      this.client = undefined;
    }
  }

  isConnected(): boolean {
    return Boolean(this.client?.usable);
  }

  async ping(): Promise<void> {
    const client = await this.ensureConnected();
    await client.noop();
  }

  getIdleStatus(): Record<string, unknown> {
    return {
      enabled: this.config.runtime.idleWatchEnabled,
      connected: this.isConnected(),
      maxSeconds: this.config.runtime.idleMaxSeconds,
      lastIdleAt: this.lastIdleAt,
      lastIdleChangeAt: this.lastIdleChangeAt,
      lastIdleEventCount: this.lastIdleEventCount,
      lastIdleError: this.lastIdleError,
    };
  }

  async waitForMailboxChanges(input: {
    folder?: string;
    timeoutMs?: number;
  } = {}): Promise<{
    folder: string;
    timeoutMs: number;
    checkedAt: string;
    changed: boolean;
    events: Array<Record<string, unknown>>;
  }> {
    const folder = input.folder?.trim() || "INBOX";
    const timeoutMs = normalizeLimit(input.timeoutMs, this.config.runtime.idleMaxSeconds * 1000, 1_000, 300_000);

    // IDLE semaphore: prevent stacking concurrent IDLE sessions per folder,
    // which would exhaust Proton Bridge's connection limit.
    if (this._idleActive.get(folder)) {
      return { folder, timeoutMs, checkedAt: new Date().toISOString(), changed: false, events: [] };
    }
    this._idleActive.set(folder, true);

    const client = await this.ensureConnected();
    try {
      return await this.waitForMailboxChangesWithClient(client, folder, timeoutMs, true);
    } finally {
      this._idleActive.delete(folder);
    }
  }

  private async waitForMailboxChangesWithClient(
    client: ImapFlow,
    folder: string,
    timeoutMs: number,
    allowReconnectRetry: boolean,
  ): Promise<{
    folder: string;
    timeoutMs: number;
    checkedAt: string;
    changed: boolean;
    events: Array<Record<string, unknown>>;
  }> {
    // imapflow.preCheck is an internal hook used here to interrupt IDLE early.
    // If this breaks after an imapflow upgrade, inspect the library's IDLE
    // implementation for the current cancellation/break mechanism.
    const idleClient = client as unknown as {
      maxIdleTime?: number | false;
      preCheck?: false | (() => Promise<void>);
      idling?: boolean;
    };
    const previousMaxIdle = idleClient.maxIdleTime;
    const events: Array<Record<string, unknown>> = [];
    let idleBreakRequested = false;

    const requestIdleBreak = () => {
      if (idleBreakRequested) {
        return;
      }
      idleBreakRequested = true;

      const breaker = idleClient.preCheck;
      if (typeof breaker === "function") {
        breaker().catch((error) => {
          this.log.warn("Failed to break IMAP IDLE probe", "IMAPService", {
            folder,
            error,
          });
        });
      }
    };

    const onExists = (event: { count?: number; exists?: number }) => {
      const mailbox = client.mailbox || undefined;
      events.push({ type: "exists", count: event.count ?? event.exists ?? mailbox?.exists });
      requestIdleBreak();
    };
    const onExpunge = (event: { seq?: number }) => {
      events.push({ type: "expunge", seq: event.seq });
      requestIdleBreak();
    };
    const onFlags = (event: { seq?: number; uid?: number }) => {
      events.push({ type: "flags", seq: event.seq, uid: event.uid });
      requestIdleBreak();
    };

    client.on("exists", onExists);
    client.on("expunge", onExpunge);
    client.on("flags", onFlags);

    const lock = await client.getMailboxLock(folder, { readOnly: true });
    // Best-effort graceful break — NOT what enforces the timeout (see the
    // Promise.race below for why this alone isn't trustworthy).
    const timeout = setTimeout(() => {
      requestIdleBreak();
    }, timeoutMs);
    timeout.unref?.();

    let timedOutHard = false;
    let hardTimeoutTimer: NodeJS.Timeout | undefined;

    try {
      idleClient.maxIdleTime = timeoutMs;

      // imapflow's client.idle() early-returns as a no-op when `idling` is
      // already true (see imap-flow.js: `async idle() { if (!this.idling) ... }`).
      // Proton Bridge can terminate an IDLE session server-side without our DONE,
      // which leaves imapflow's `idling` stuck true even though the socket is
      // still "usable" — so ensureConnected() won't reconnect, and every
      // subsequent idle() returns instantly. That turns the caller's watch loop
      // into a 100%-CPU busy spin (observed: an orphaned process burning a full
      // core for days). Our IDLE calls are serialized per folder via _idleActive
      // and awaited by the caller, so no legitimate IDLE can be in flight here —
      // if the flag is set, it is stuck. Clear it so idle() actually enters IDLE
      // and blocks.
      if (idleClient.idling) {
        this.log.warn("Clearing stuck IMAP IDLE state before re-entering IDLE", "IMAPService", {
          folder,
        });
        idleClient.idling = false;
      }

      const idleStartedAt = Date.now();

      // imapflow's own maxIdleTime is a keepalive-refresh interval, NOT a
      // caller-facing timeout: internally it breaks and immediately restarts
      // a fresh IDLE every maxIdleTime ms (see imapflow's commands/idle.js
      // runIdleLoop — `if (stillIdling) return runIdleLoop()`), so
      // client.idle() can keep looping indefinitely instead of ever
      // resolving when nothing else happens to break it. Confirmed live:
      // timeoutSeconds:10 hung past 120s. requestIdleBreak() above is a
      // best-effort attempt at imapflow's graceful preCheck/DONE path, but
      // that path is exactly what's proven unreliable — the actual
      // documented "always has a hard timeout" contract must not depend on
      // it, so it's enforced here independently via Promise.race.
      const idlePromise = client.idle().then(() => "idle-resolved" as const);
      // Attach a catch immediately: if this loses the race, the connection
      // gets force-disconnected below and this promise may later reject on
      // the now-closed socket — that must not become an unhandled rejection.
      idlePromise.catch(() => {});
      const hardTimeout = new Promise<"hard-timeout">((resolve) => {
        hardTimeoutTimer = setTimeout(() => resolve("hard-timeout"), timeoutMs + HARD_IDLE_TIMEOUT_GRACE_MS);
        hardTimeoutTimer.unref?.();
      });

      const outcome = await Promise.race([idlePromise, hardTimeout]);

      if (outcome === "hard-timeout") {
        timedOutHard = true;
        this.log.warn("IMAP IDLE exceeded its hard timeout; disconnecting to clear stuck state", "IMAPService", {
          folder,
          timeoutMs,
        });
        // Force-disconnect rather than trying to gracefully unwind — a dropped
        // connection is unambiguous where imapflow's own break mechanism just
        // proved it wasn't. This is also what prevents the stuck-IDLE busy-spin
        // described above from surviving into the caller's next attempt.
        await this.disconnect().catch(() => {});
        this.consecutiveFastIdleReturns = 0;
        const checkedAt = new Date().toISOString();
        const changed = events.length > 0;
        this.lastIdleAt = checkedAt;
        this.lastIdleError = undefined;
        if (changed) {
          this.lastIdleChangeAt = checkedAt;
          this.lastIdleEventCount = events.length;
        }
        return { folder, timeoutMs, checkedAt, changed, events };
      }

      const idleElapsedMs = Date.now() - idleStartedAt;
      const checkedAt = new Date().toISOString();
      const changed = events.length > 0;

      if (changed || idleElapsedMs >= MIN_HEALTHY_IDLE_MS) {
        // A real mailbox change, or a full-duration idle that simply timed out
        // with nothing to report — both are healthy outcomes.
        this.consecutiveFastIdleReturns = 0;
      } else {
        // See MAX_CONSECUTIVE_FAST_IDLE_RETURNS above: a lone fast/event-less
        // return is expected connection sharing, not evidence of a stuck idle.
        this.consecutiveFastIdleReturns += 1;
        if (this.consecutiveFastIdleReturns >= MAX_CONSECUTIVE_FAST_IDLE_RETURNS) {
          this.log.warn(
            "IMAP IDLE returned without blocking several times in a row; resetting connection",
            "IMAPService",
            { folder, idleElapsedMs, consecutiveFastIdleReturns: this.consecutiveFastIdleReturns },
          );
          await this.disconnect();
          this.consecutiveFastIdleReturns = 0;
        }
      }
      this.lastIdleAt = checkedAt;
      this.lastIdleError = undefined;
      if (changed) {
        this.lastIdleChangeAt = checkedAt;
        this.lastIdleEventCount = events.length;
      }
      return {
        folder,
        timeoutMs,
        checkedAt,
        changed,
        events,
      };
    } catch (error) {
      this.lastIdleError = error instanceof Error ? error.message : String(error);
      if (allowReconnectRetry && !isLikelyAuthenticationError(error)) {
        await this.disconnect();
        const freshClient = await this.ensureConnected();
        return this.waitForMailboxChangesWithClient(freshClient, folder, timeoutMs, false);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      clearTimeout(hardTimeoutTimer);
      client.off("exists", onExists);
      client.off("expunge", onExpunge);
      client.off("flags", onFlags);
      if (!timedOutHard) {
        // On the hard-timeout path the client was already force-disconnected
        // above — its lock and maxIdleTime belong to a now-closed socket, and
        // this.client is already undefined so the next call reconnects fresh.
        lock.release();
        idleClient.maxIdleTime = previousMaxIdle;
      }
    }
  }

  async getFolders(forceRefresh = false): Promise<FolderInfo[]> {
    if (this.folderCache && !forceRefresh) {
      return this.folderCache;
    }

    let client = await this.ensureConnected();
    let folders;
    try {
      folders = await client.list({
        statusQuery: { messages: true, unseen: true, uidNext: true },
      });
    } catch (error) {
      // ensureConnected()'s `this.client?.usable` check is a snapshot — it can
      // pass a beat before a concurrent disconnect (e.g. the IDLE watcher
      // resetting a stuck connection) actually tears the socket down, handing
      // this call a client that dies mid-request. Reproduced live: sync_folders
      // failed with NoConnection 2ms after an unrelated "IMAP IDLE returned
      // without blocking; resetting connection" log line. A plain read has no
      // side effect to double up on, so just reconnect and retry once.
      if ((error as { code?: string } | undefined)?.code !== "NoConnection") {
        throw error;
      }
      await this.disconnect().catch(() => {});
      client = await this.ensureConnected();
      folders = await client.list({
        statusQuery: { messages: true, unseen: true, uidNext: true },
      });
    }

    this.folderCache = folders.map(mapFolder);
    return this.folderCache;
  }

  async syncFolders(): Promise<{ syncedAt: string; folders: FolderInfo[] }> {
    const folders = await this.getFolders(true);
    const syncedAt = new Date().toISOString();
    return { syncedAt, folders };
  }

  // Two distinct failure modes land here and both are resolved the same way —
  // by checking what the folder list actually says instead of trusting the
  // thrown error:
  //   1. NoConnection: a write sent right as imapflow cycles its socket (IDLE
  //      renewal, or Bridge dropping the connection under it) can throw
  //      "Connection not available" even though the command already reached
  //      the server. Reproduced live: create/rename/delete all left the
  //      mailbox in the post-command state while still throwing NoConnection.
  //   2. A genuine IMAP NO/BAD ("Command failed") for a mutation whose goal
  //      state turns out to already hold — e.g. delete_label on a label a
  //      prior call already removed. Bridge often returns this with no
  //      `.responseText` at all, so there's no reason string to show the
  //      caller; reported live as delete_label on an already-gone label
  //      failing with a bare "Command failed" and nothing else to go on.
  // Blindly retrying the same mutation after either would risk failing a
  // *second* time for the opposite reason ("already exists" / "no such
  // mailbox"), reporting an error for a request that in fact succeeded.
  // Reconnect (only needed for case 1) and check the actual folder list
  // first; only re-send the mutation if the goal demonstrably wasn't met —
  // and even then, only retry when reconnecting is what plausibly caused the
  // first attempt to fail, not for an unrelated server rejection.
  private async mutateFolderWithReconnectCheck<T>(
    mutate: () => Promise<T>,
    alreadyApplied: (folders: FolderInfo[]) => T | undefined,
  ): Promise<T> {
    try {
      return await mutate();
    } catch (error) {
      const isNoConnection = (error as { code?: string } | undefined)?.code === "NoConnection";
      if (isNoConnection) {
        await this.disconnect().catch(() => {});
      }
      const folders = await this.getFolders(true);
      const applied = alreadyApplied(folders);
      if (applied !== undefined) {
        return applied;
      }
      if (!isNoConnection) {
        throw error;
      }
      return mutate();
    }
  }

  async createFolder(path: string): Promise<{
    path: string;
    created: boolean;
    folder?: FolderInfo;
  }> {
    const trimmed = path?.trim();
    if (!trimmed) {
      throw new Error("Folder path is required.");
    }

    const response = await this.mutateFolderWithReconnectCheck(
      async () => {
        const client = await this.ensureConnected();
        return client.mailboxCreate(trimmed);
      },
      (folders) => {
        const existing = folders.find((entry) => entry.path === trimmed);
        return existing ? { path: existing.path, created: true } : undefined;
      },
    );

    this.folderCache = undefined;
    const folders = await this.getFolders(true);
    const folder = folders.find((entry) => entry.path === response.path);

    return { path: response.path, created: response.created !== false, folder };
  }

  async renameFolder(path: string, newPath: string): Promise<{
    path: string;
    newPath: string;
    folder?: FolderInfo;
    warning?: string;
  }> {
    const fromPath = path?.trim();
    const toPath = newPath?.trim();
    if (!fromPath) {
      throw new Error("Source folder path is required.");
    }
    if (!toPath) {
      throw new Error("Target folder path is required.");
    }
    if (fromPath === toPath) {
      throw new Error("Source and target paths are identical.");
    }

    const response = await this.mutateFolderWithReconnectCheck(
      async () => {
        const client = await this.ensureConnected();
        return client.mailboxRename(fromPath, toPath);
      },
      (folders) => {
        const renamed = folders.some((entry) => entry.path === toPath);
        return renamed ? { path: fromPath, newPath: toPath } : undefined;
      },
    );

    this.folderCache = undefined;
    for (const [id, cached] of this.messageCache) {
      if (cached.folder === response.path) {
        this.messageCache.delete(id);
      }
    }
    const folders = await this.getFolders(true);
    const folder = folders.find((entry) => entry.path === response.newPath);

    // The IMAP RENAME response only means the server accepted the command —
    // it's not proof the source path is actually gone. Found via a live
    // report: renaming a Gmail-import label left BOTH the old and new
    // labels behind (Bridge/Proton apparently implemented it as create-new
    // + leave-old-orphaned for that label, not an atomic rename), and this
    // method had no way to detect or surface that — it just reported a
    // clean rename. Check for the source path still existing and warn
    // instead of silently claiming success.
    const stillExists = folders.some((entry) => entry.path === response.path);
    const warning = stillExists
      ? `Rename reported success, but "${response.path}" still exists alongside "${response.newPath}" — this looks like a duplicate, not a clean rename. Verify both and delete the stale one manually if so.`
      : undefined;

    return { path: response.path, newPath: response.newPath, folder, warning };
  }

  async deleteFolder(path: string): Promise<{
    path: string;
    deleted: true;
  }> {
    const trimmed = path?.trim();
    if (!trimmed) {
      throw new Error("Folder path is required.");
    }

    const reservedRoots = new Set([
      "INBOX",
      "Drafts",
      "Sent",
      "Trash",
      "Spam",
      "Archive",
      "All Mail",
      "Folders",
      "Labels",
    ]);
    if (reservedRoots.has(trimmed)) {
      throw new Error(`Refusing to delete reserved system folder ${trimmed}.`);
    }

    const response = await this.mutateFolderWithReconnectCheck<{ path: string }>(
      async () => {
        const client = await this.ensureConnected();
        return client.mailboxDelete(trimmed);
      },
      (folders) => {
        const stillExists = folders.some((entry) => entry.path === trimmed);
        return stillExists ? undefined : { path: trimmed };
      },
    );

    this.folderCache = undefined;
    for (const [id, cached] of this.messageCache) {
      if (cached.folder === response.path) {
        this.messageCache.delete(id);
      }
    }
    await this.getFolders(true);

    return { path: response.path, deleted: true };
  }

  async getEmails(input: GetEmailsInput = {}): Promise<{
    folder: string;
    total: number;
    limit: number;
    offset: number;
    emails: EmailSummary[];
  }> {
    const folder = input.folder?.trim() || "INBOX";
    const limit = normalizeLimit(input.limit, 50);
    const offset = normalizeLimit(input.offset, 0, 0, 10_000);

    return this.withMailbox(folder, true, async (client) => {
      const total = client.mailbox && client.mailbox.exists ? client.mailbox.exists : 0;
      if (total === 0 || offset >= total) {
        return { folder, total, limit, offset, emails: [] };
      }

      const emails: EmailSummary[] = [];
      const fetchQuery = input.includeSnippet ? FETCH_DETAIL_QUERY : FETCH_SUMMARY_QUERY;

      if (input.beforeUid !== undefined) {
        // UID-based pagination: search for UIDs below the given upper bound
        const searchQuery: SearchObject = { uid: `1:${input.beforeUid - 1}` };
        const uids = await client.search(searchQuery, { uid: true });
        if (!uids || uids.length === 0) {
          return { folder, total, limit, offset, emails: [] };
        }
        // Use the UID-filtered count as effectiveTotal for accurate early-exit
        // (total reflects mailbox.exists which includes UIDs >= beforeUid)
        const effectiveTotal = uids.length;
        if (offset >= effectiveTotal) {
          return { folder, total, limit, offset, emails: [] };
        }
        const sorted = input.sortByUid === "asc" ? uids.sort((a, b) => a - b) : uids.sort((a, b) => b - a);
        const page = sorted.slice(offset, offset + limit);
        if (page.length === 0) {
          return { folder, total, limit, offset, emails: [] };
        }
        const uidSet = page.join(",");
        for await (const message of client.fetch(uidSet, fetchQuery, { uid: true })) {
          const summary = this.toSummary(folder, message);
          const enriched =
            input.includeSnippet && message.source
              ? await this.enrichSummaryFromParsed(summary, await this.parseSource(message.source), false)
              : summary;
          emails.push(enriched);
          this.messageCache.set(enriched.id, enriched);
        }
      } else {
        const endSeq = total - offset;
        const startSeq = Math.max(1, endSeq - limit + 1);

        for await (const message of client.fetch(`${startSeq}:${endSeq}`, fetchQuery)) {
          const summary = this.toSummary(folder, message);
          const enriched =
            input.includeSnippet && message.source
              ? await this.enrichSummaryFromParsed(summary, await this.parseSource(message.source), false)
              : summary;
          emails.push(enriched);
          this.messageCache.set(enriched.id, enriched);
        }
      }

      const sorted =
        input.sortByUid === "asc"
          ? emails.sort((a, b) => a.uid - b.uid)
          : sortEmailsByNewest(emails);

      return {
        folder,
        total,
        limit,
        offset,
        emails: sorted,
      };
    });
  }

  async getEmailById(emailId: string): Promise<EmailDetail> {
    const { detail } = await this.getParsedMailDetail(emailId);
    return detail;
  }

  async searchEmails(input: SearchEmailsInput = {}): Promise<{
    folders: string[];
    limit: number;
    total: number;
    totalMatched: number;
    hasMore: boolean;
    emails: EmailSummary[];
  }> {
    const limit = normalizeLimit(input.limit, 100);
    const folders = await this.resolveFolders(input.folder);
    const searchQuery = this.buildSearchQuery(input);
    const collected: EmailSummary[] = [];
    let totalMatched = 0;

    for (const folder of folders) {
      const emails = await this.withMailbox(folder, true, async (client) => {
        const searchResult = await client.search(searchQuery, { uid: true });
        const uids = searchResult || [];
        totalMatched += uids.length;
        if (uids.length === 0) {
          return [];
        }

        // UID order does not track date order (e.g. after a cross-provider import),
        // so a naive slice(-limit) on UIDs can silently drop the newest messages.
        // Fetch cheap INTERNALDATE-only headers first, sort by date, then pick the target UIDs.
        let targetUids = uids;
        if (uids.length > limit) {
          const dated: { uid: number; date: number }[] = [];
          for await (const message of client.fetch(uids, FETCH_INDEX_QUERY, { uid: true })) {
            dated.push({ uid: message.uid, date: new Date(message.internalDate ?? 0).getTime() });
          }
          targetUids = pickNewestUids(dated, limit);
        } else {
          targetUids = [...uids].reverse();
        }

        const results: EmailSummary[] = [];

        const fetchQuery = input.includeSnippet ? FETCH_DETAIL_QUERY : FETCH_SUMMARY_QUERY;
        for await (const message of client.fetch(targetUids, fetchQuery, { uid: true })) {
          const summary = this.toSummary(folder, message);
          const enriched =
            input.includeSnippet && message.source
              ? await this.enrichSummaryFromParsed(summary, await this.parseSource(message.source), false)
              : summary;
          results.push(enriched);
          this.messageCache.set(enriched.id, enriched);
        }

        // FIX #3: verified — hasAttachment, attachmentName, label, threadId handled above
        return results.filter((email) => matchesLocalSearchFilters(email, input));
      });

      collected.push(...emails);
    }

    const sorted = sortEmailsByNewest(dedupeEmails(collected)).slice(0, limit);
    return {
      folders,
      limit,
      total: sorted.length,
      totalMatched,
      hasMore: totalMatched > sorted.length,
      emails: sorted,
    };
  }

  async listAttachments(emailId: string): Promise<{
    emailId: string;
    attachments: EmailDetail["attachments"];
  }> {
    const detail = await this.getEmailById(emailId);
    return {
      emailId,
      attachments: detail.attachments,
    };
  }

  async saveAttachments(input: {
    emailId: string;
    outputPath?: string;
    includeInline?: boolean;
    filenameContains?: string;
    contentType?: string;
  }): Promise<{
    emailId: string;
    saved: AttachmentContentResult[];
    skipped: number;
  }> {
    const { parsed } = await this.getParsedMailDetail(input.emailId);
    const attachments = this.mapParsedAttachmentsWithContent(parsed);
    const saved: AttachmentContentResult[] = [];
    let skipped = 0;
    // Track resolved output paths to detect filename collisions within this batch
    const usedPaths = new Set<string>();

    for (const attachment of attachments) {
      if (!input.includeInline && attachment.isInline) {
        skipped += 1;
        continue;
      }
      if (
        input.filenameContains &&
        !(attachment.filename || "").toLowerCase().includes(input.filenameContains.toLowerCase())
      ) {
        skipped += 1;
        continue;
      }
      if (
        input.contentType &&
        (attachment.contentType || "").toLowerCase() !== input.contentType.toLowerCase()
      ) {
        skipped += 1;
        continue;
      }

      const attachmentId = attachment.id || attachment.filename || attachment.checksum;
      if (!attachmentId) {
        skipped += 1;
        continue;
      }

      let targetPath: string | undefined;
      if (input.outputPath && attachment.filename) {
        const sanitized = sanitizeFileName(attachment.filename, attachmentId);
        const base = join(resolve(input.outputPath), sanitized);
        // Deduplicate: if path already used, append numeric suffix (image.png → image (1).png)
        if (!usedPaths.has(base)) {
          targetPath = base;
        } else {
          const ext = sanitized.includes(".") ? sanitized.slice(sanitized.lastIndexOf(".")) : "";
          const stem = sanitized.slice(0, sanitized.length - ext.length);
          let counter = 1;
          let candidate: string;
          do {
            candidate = join(resolve(input.outputPath), `${stem} (${counter})${ext}`);
            counter++;
          } while (usedPaths.has(candidate));
          targetPath = candidate;
        }
        usedPaths.add(targetPath);
      } else {
        targetPath = input.outputPath;
      }

      saved.push(await this.writeAttachmentToPath(input.emailId, attachment, targetPath));
    }

    return {
      emailId: input.emailId,
      saved,
      skipped,
    };
  }

  private extractAttachmentText(attachment: { content: Buffer; contentType?: string }): string | undefined {
    // GAP-12: guard zero-byte attachments before calling toString()
    if (!attachment.content || attachment.content.length === 0 || attachment.content.length > MAX_ATTACHMENT_TEXT_BYTES) {
      return undefined;
    }
    const contentType = attachment.contentType?.toLowerCase();
    if (contentType === "text/html") {
      return stripHtmlToText(attachment.content.toString("utf8"));
    }
    if (contentType === "text/calendar") {
      return summarizeCalendarText(attachment.content.toString("utf8"));
    }
    if (isTextLikeMimeType(attachment.contentType)) {
      return attachment.content.toString("utf8");
    }
    return undefined;
  }

  // Fetches full attachment content for internal re-attachment (forwarding to
  // SMTP) — deliberately NOT gated by assertAttachmentWithinInlineLimit below,
  // which bounds base64 returned inline in an MCP *tool response*, a much
  // smaller concern than what SMTP can actually send. Reusing
  // getAttachmentContent here would make forwarding an email with anything
  // bigger than maxInlineBytes throw "too large for inline delivery" instead
  // of just forwarding it.
  async getAttachmentForForward(emailId: string, attachmentId: string): Promise<{
    filename: string;
    content: string;
    contentType?: string;
    cid?: string;
    contentDisposition?: string;
  }> {
    const attachment = await this.getParsedAttachment(emailId, attachmentId);
    return {
      filename: attachment.filename ?? "attachment",
      content: attachment.content.toString("base64"),
      contentType: attachment.contentType,
      cid: attachment.cid,
      contentDisposition: attachment.disposition,
    };
  }

  async getAttachmentContent(
    emailId: string,
    attachmentId: string,
    includeBase64 = false,
  ): Promise<AttachmentContentResult> {
    await this.assertAttachmentWithinInlineLimit(emailId, attachmentId);
    const attachment = await this.getParsedAttachment(emailId, attachmentId);
    const base64 = attachment.content.toString("base64");

    return {
      emailId,
      attachment: {
        id: attachment.id,
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.size,
        disposition: attachment.disposition,
        cid: attachment.cid,
        checksum: attachment.checksum,
        isInline: attachment.isInline,
        kind: attachment.kind,
        isCalendarInvite: attachment.isCalendarInvite,
        isSignature: attachment.isSignature,
      },
      text: this.extractAttachmentText(attachment),
      base64: includeBase64 ? base64 : undefined,
    };
  }

  // First-class text extraction, deliberately NOT gated by the base64-oriented
  // maxInlineBytes limit (assertAttachmentWithinInlineLimit) — that guard exists
  // to bound base64 payload size, which is a different (larger) concern than
  // returning plain extracted text. Gated instead by MAX_ATTACHMENT_TEXT_BYTES,
  // same as getAttachmentContent's own text field. text/* MIME types only for
  // now (PDF extraction would need a new dependency — deliberately out of scope,
  // avoids re-triggering the CI allowScripts/native-binding issues just fixed).
  async getAttachmentText(emailId: string, attachmentId: string): Promise<{
    emailId: string;
    attachment: AttachmentContentResult["attachment"];
    text?: string;
  }> {
    const attachment = await this.getParsedAttachment(emailId, attachmentId);
    const text = this.extractAttachmentText(attachment);
    if (text === undefined) {
      const reason =
        !attachment.content || attachment.content.length === 0
          ? "the attachment is empty"
          : attachment.content.length > MAX_ATTACHMENT_TEXT_BYTES
            ? `it exceeds the ${MAX_ATTACHMENT_TEXT_BYTES} byte text-extraction limit`
            : `its content type (${attachment.contentType ?? "unknown"}) is not a supported text format`;
      throw new Error(`Cannot extract text from attachment ${attachmentId}: ${reason}. Use get_attachment_content or save_attachment instead.`);
    }

    return {
      emailId,
      attachment: {
        id: attachment.id,
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.size,
        disposition: attachment.disposition,
        cid: attachment.cid,
        checksum: attachment.checksum,
        isInline: attachment.isInline,
        kind: attachment.kind,
        isCalendarInvite: attachment.isCalendarInvite,
        isSignature: attachment.isSignature,
      },
      text,
    };
  }

  async saveAttachment(
    emailId: string,
    attachmentId: string,
    outputPath?: string,
  ): Promise<AttachmentContentResult> {
    const attachment = await this.getParsedAttachment(emailId, attachmentId);
    return this.writeAttachmentToPath(emailId, attachment, outputPath);
  }

  /** Re-FETCH flags after a STORE op and return any flags the server silently dropped. */
  private async verifyFlags(
    client: ImapFlow,
    uid: number,
    expectedFlags: string[],
    expectPresent: boolean,
  ): Promise<string[]> {
    const notApplied: string[] = [];
    const msg = await client.fetchOne(String(uid), { flags: true }, { uid: true });
    if (msg === false) {
      // IMAP's STORE command silently no-ops for a UID that doesn't exist —
      // no error, no exception — so the preceding messageFlagsAdd/Remove
      // call above already "succeeded" against nothing. This re-FETCH is
      // the only signal that the target never existed at all; treating it
      // as "best-effort, ignore" (the old behavior) made every flag
      // operation on a stale/wrong/nonexistent UID silently report success
      // with an empty notApplied — found live via batch_email_action on a
      // deliberately-fake UID.
      throw new Error(`Email not found for uid ${uid} in ${client.mailbox && "path" in client.mailbox ? client.mailbox.path : "mailbox"}`);
    }
    const actual = new Set(Array.from(msg.flags ?? []).map((f: string) => f.toLowerCase()));
    for (const flag of expectedFlags) {
      const present = actual.has(flag.toLowerCase());
      if (expectPresent && !present) notApplied.push(flag);
      if (!expectPresent && present) notApplied.push(flag);
    }
    return notApplied;
  }

  async markEmailRead(emailId: string, isRead = true, uidValidity?: string): Promise<{
    emailId: string;
    folder: string;
    uid: number;
    isRead: boolean;
    notApplied: string[];
  }> {
    const { folder, uid } = parseEmailId(emailId);
    let notApplied: string[] = [];

    await this.withMailbox(folder, false, async (client) => {
      this.assertMailboxUidValidity(client, uidValidity);
      if (isRead) {
        await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
      } else {
        await client.messageFlagsRemove(String(uid), ["\\Seen"], { uid: true });
      }
      notApplied = await this.verifyFlags(client, uid, ["\\Seen"], isRead);
    });

    this.updateCachedMessage(emailId, (email) => ({ ...email, isRead }));
    return { emailId, folder, uid, isRead, notApplied };
  }

  async starEmail(emailId: string, isStarred = true, uidValidity?: string): Promise<{
    emailId: string;
    folder: string;
    uid: number;
    isStarred: boolean;
    notApplied: string[];
  }> {
    const { folder, uid } = parseEmailId(emailId);
    let notApplied: string[] = [];

    await this.withMailbox(folder, false, async (client) => {
      this.assertMailboxUidValidity(client, uidValidity);
      if (isStarred) {
        await client.messageFlagsAdd(String(uid), ["\\Flagged"], { uid: true });
      } else {
        await client.messageFlagsRemove(String(uid), ["\\Flagged"], { uid: true });
      }
      notApplied = await this.verifyFlags(client, uid, ["\\Flagged"], isStarred);
    });

    this.updateCachedMessage(emailId, (email) => ({ ...email, isStarred }));
    return { emailId, folder, uid, isStarred, notApplied };
  }

  async moveEmail(emailId: string, targetFolder: string, uidValidity?: string): Promise<{
    emailId: string;
    sourceEmailId: string;
    fromFolder: string;
    targetFolder: string;
    uid: number;
    targetUid?: number;
    targetEmailId?: string;
  }> {
    const { folder, uid } = parseEmailId(emailId);
    let targetUid: number | undefined;

    await this.withMailbox(folder, false, async (client) => {
      this.assertMailboxUidValidity(client, uidValidity);
      const moved = await client.messageMove(String(uid), targetFolder, { uid: true });
      if (moved === false) {
        throw new Error(`Server did not move email ${emailId} to ${targetFolder}`);
      }
      targetUid = moved.uidMap?.get(uid);
      // `moved === false` above only catches an empty/invalid range given to
      // the client, not a UID that's syntactically valid but doesn't match
      // any message on the server — IMAP's MOVE command silently succeeds
      // with nothing moved in that case (same class of bug just fixed in
      // verifyFlags). Without this check the caller got a success-shaped
      // response with no `error` field, just a silently-missing targetUid,
      // making move_email on a stale/wrong/nonexistent id look like it
      // worked. Found live via move_email on a deliberately-fake UID.
      // `uidMap` is only populated when the server has UIDPLUS (Proton
      // Bridge does, confirmed live) — gate on that capability so a server
      // without it doesn't get a false failure here for a move that
      // actually succeeded.
      if (targetUid === undefined && client.capabilities.has("UIDPLUS")) {
        throw new Error(`Email not found for id ${emailId}`);
      }
    });

    const cached = this.messageCache.get(emailId);
    this.messageCache.delete(emailId);
    const targetEmailId = targetUid ? createEmailId(targetFolder, targetUid) : undefined;
    if (cached && targetUid && targetEmailId) {
      this.messageCache.set(targetEmailId, {
        ...cached,
        id: targetEmailId,
        folder: targetFolder,
        uid: targetUid,
      });
    }
    this.lastSyncAt = new Date().toISOString();

    return {
      emailId,
      sourceEmailId: emailId,
      fromFolder: folder,
      targetFolder,
      uid,
      targetUid,
      targetEmailId,
    };
  }

  async deleteEmail(emailId: string, uidValidity?: string): Promise<{
    emailId: string;
    folder: string;
    uid: number;
    deleted: true;
  }> {
    const { folder, uid } = parseEmailId(emailId);

    await this.withMailbox(folder, false, async (client) => {
      this.assertMailboxUidValidity(client, uidValidity);
      // messageDelete's own truthy/falsy result only reflects whether the
      // server accepted the EXPUNGE command, not whether any message
      // actually matched — a nonexistent UID's preceding \Deleted flag add
      // is itself a silent no-op (same class of bug fixed elsewhere in
      // this file), so EXPUNGE legitimately "succeeds" having deleted
      // nothing. This is the most severe instance of that bug class since
      // deletion is irreversible: found live, delete_email on a
      // deliberately-fake UID reported deleted:true. Confirm the message
      // actually exists before issuing a permanent delete against it.
      const exists = await client.fetchOne(String(uid), { uid: true }, { uid: true });
      if (exists === false) {
        throw new Error(`Email not found for id ${emailId}`);
      }
      const deleted = await client.messageDelete(String(uid), { uid: true });
      if (!deleted) {
        throw new Error(`Server did not delete email ${emailId}`);
      }
    });

    this.messageCache.delete(emailId);
    this.lastSyncAt = new Date().toISOString();

    return {
      emailId,
      folder,
      uid,
      deleted: true,
    };
  }

  async updateMessageLabels(
    emailId: string,
    labelsToAdd: string[],
    labelsToRemove: string[],
  ): Promise<{ emailId: string; added: string[]; removed: string[]; notFound: string[]; failedLabels?: string[] }> {
    const { folder, uid } = parseEmailId(emailId);
    const added: string[] = [];
    const removed: string[] = [];
    const notFound: string[] = [];
    const failedLabels: string[] = [];

    // Retrieve the Message-ID header once (needed for label removal lookup).
    // Also doubles as an existence check: messageCopy's own `result ===
    // false` check below only catches an empty/invalid range, not a
    // syntactically valid UID that doesn't match any message — IMAP's COPY
    // command silently "succeeds" with nothing copied in that case (same
    // class of bug as markEmailRead/moveEmail/bulkUpdateFlags). Without
    // failing here first, a fake/stale UID reported added:[<label>] for
    // every label requested. Found live: update_message_labels on a
    // deliberately-fake UID against a real label folder. Checked via
    // `msg !== false` rather than a defined messageId, since a genuinely
    // existing message could still legitimately lack a Message-ID header.
    let messageId: string | undefined;
    let sourceExists = false;
    await this.withMailbox(folder, true, async (client) => {
      const msg = await client.fetchOne(String(uid), { uid: true, envelope: true }, { uid: true });
      if (msg !== false) {
        sourceExists = true;
        messageId = msg.envelope?.messageId;
      }
    });
    if (!sourceExists) {
      throw new Error(`Email not found for id ${emailId}`);
    }

    // Add labels: COPY can partially succeed if multiple labels are added and a later COPY fails.
    for (const label of labelsToAdd) {
      const labelFolder = label.startsWith("Labels/") ? label : `Labels/${label}`;
      try {
        await this.withMailbox(folder, false, async (client) => {
          const result = await client.messageCopy(String(uid), labelFolder, { uid: true });
          if (result === false) {
            throw new Error(`Server did not copy message to ${labelFolder}`);
          }
        });
        added.push(labelFolder);
      } catch {
        notFound.push(labelFolder);
        failedLabels.push(labelFolder);
      }
    }

    // Remove labels: find the UID in Labels/<name> by Message-ID, then delete it
    for (const label of labelsToRemove) {
      const labelFolder = label.startsWith("Labels/") ? label : `Labels/${label}`;
      try {
        if (messageId) {
          const deleted = await this.withMailbox(labelFolder, false, async (client) => {
            const uids = await client.search({ header: { "Message-ID": messageId! } }, { uid: true });
            const labelUid = Array.isArray(uids) ? uids[0] : undefined;
            if (!labelUid) {
              return false;
            }
            await client.messageDelete(String(labelUid), { uid: true });
            return true;
          });
          if (deleted) {
            removed.push(labelFolder);
          } else {
            notFound.push(labelFolder);
          }
        } else {
          notFound.push(labelFolder);
        }
      } catch {
        notFound.push(labelFolder);
      }
    }

    return { emailId, added, removed, notFound, failedLabels: failedLabels.length > 0 ? failedLabels : undefined };
  }

  async updateMessageFlags(
    emailId: string,
    flagsToAdd: string[],
    flagsToRemove: string[],
    uidValidity?: string,
  ): Promise<{ emailId: string; added: string[]; removed: string[]; notApplied: string[] }> {
    const { folder, uid } = parseEmailId(emailId);
    let notApplied: string[] = [];

    await this.withMailbox(folder, false, async (client) => {
      this.assertMailboxUidValidity(client, uidValidity);
      if (flagsToAdd.length > 0) {
        await client.messageFlagsAdd(String(uid), flagsToAdd, { uid: true });
      }
      if (flagsToRemove.length > 0) {
        await client.messageFlagsRemove(String(uid), flagsToRemove, { uid: true });
      }
      // Verify adds
      const notAppliedAdds = flagsToAdd.length > 0
        ? await this.verifyFlags(client, uid, flagsToAdd, true)
        : [];
      // Verify removes
      const notAppliedRemoves = flagsToRemove.length > 0
        ? await this.verifyFlags(client, uid, flagsToRemove, false)
        : [];
      notApplied = [...notAppliedAdds, ...notAppliedRemoves];
    });

    return { emailId, added: flagsToAdd, removed: flagsToRemove, notApplied };
  }

  async countMessages(input: SearchEmailsInput = {}): Promise<{
    folder: string;
    count: number;
  }> {
    const folder = input.folder ?? "INBOX";
    const query = this.buildSearchQuery(input);

    const count = await this.withMailbox(folder, true, async (client) => {
      const uids = await client.search(query, { uid: true });
      return Array.isArray(uids) ? uids.length : 0;
    });

    return { folder, count };
  }

  async getFolderStats(folder?: string, scanLimit?: number): Promise<{
    folder: string;
    total: number;
    unseen: number;
    uidNext?: number;
    uidValidity?: string;
  }> {
    const target = folder ?? "INBOX";

    return this.withMailbox(target, true, async (client) => {
      const mailbox = client.mailbox || undefined;
      const status = await client.status(target, { messages: true, unseen: true, uidNext: true, uidValidity: true });
      return {
        folder: target,
        total: status?.messages ?? mailbox?.exists ?? 0,
        unseen: status?.unseen ?? 0,
        uidNext: status?.uidNext ?? mailbox?.uidNext,
        uidValidity: (status?.uidValidity ?? mailbox?.uidValidity)?.toString(),
      };
    });
  }

  async emptyFolder(folder: string): Promise<{ folder: string; deleted: number }> {
    if (folder.toUpperCase() === "INBOX") {
      throw new Error("emptyFolder cannot be used on INBOX. Move messages to Trash first.");
    }

    const uids: number[] = await this.withMailbox(folder, true, async (client) => {
      const found = await client.search({ all: true }, { uid: true });
      return Array.isArray(found) ? found : [];
    });

    if (uids.length === 0) {
      return { folder, deleted: 0 };
    }

    const uidSet = uids.join(",");
    await this.withMailbox(folder, false, async (client) => {
      await client.messageDelete(uidSet, { uid: true });
    });

    // Purge from cache
    for (const uid of uids) {
      this.messageCache.delete(createEmailId(folder, uid));
    }

    return { folder, deleted: uids.length };
  }

  private async resolveUidsForBulkOp(
    folder: string,
    emailIds: string[] | undefined,
    match: BulkMatchCriteria | undefined,
  ): Promise<number[]> {
    if (emailIds !== undefined && match !== undefined) {
      throw new Error("Provide either emailIds or match, not both");
    }
    if (emailIds === undefined && match === undefined) {
      throw new Error("Provide either emailIds or match");
    }

    if (emailIds !== undefined) {
      return emailIds
        .map((id) => parseEmailId(id))
        .filter((parsed) => parsed.folder === folder)
        .map((parsed) => parsed.uid);
    }

    // match path
    const searchInput: SearchEmailsInput = {
      folder,
      from: match!.from,
      subject: match!.subject,
      query: match!.text,
      dateFrom: match!.since,
      dateTo: match!.before,
      isRead: match!.isRead,
      isStarred: match!.isStarred,
      sizeLarger: match!.sizeLarger,
      sizeSmaller: match!.sizeSmaller,
    };
    const query = this.buildSearchQuery(searchInput);
    return this.withMailbox(folder, true, async (client) => {
      const found = await client.search(query, { uid: true });
      return Array.isArray(found) ? found : [];
    });
  }

  async bulkMove(input: {
    emailIds?: string[];
    match?: BulkMatchCriteria;
    folder?: string;
    targetFolder: string;
    dryRun?: boolean;
  }): Promise<BulkOperationResult> {
    const folder = input.folder?.trim() || "INBOX";
    const uids = await this.resolveUidsForBulkOp(folder, input.emailIds, input.match);

    if (input.dryRun) {
      return {
        dryRun: true,
        total: uids.length,
        succeeded: 0,
        failed: 0,
        notFound: 0,
        results: [],
      };
    }

    let succeeded = 0;
    let failed = 0;
    const results: BulkOperationResult["results"] = [];

    if (uids.length > 0) {
      const uidSet = uids.join(",");
      try {
        let uidMap: Map<number, number> | undefined;
        let hasUidPlus = false;
        await this.withMailbox(folder, false, async (client) => {
          const moved = await client.messageMove(uidSet, input.targetFolder, { uid: true });
          if (moved === false) {
            throw new Error(`Server did not move uid set ${uidSet}`);
          }
          uidMap = moved.uidMap;
          hasUidPlus = client.capabilities.has("UIDPLUS");
        });
        for (const uid of uids) {
          const emailId = createEmailId(folder, uid);
          // `moved === false` above only catches an empty/invalid range,
          // not a syntactically valid UID that doesn't match any message —
          // IMAP's MOVE silently succeeds with nothing moved in that case
          // (same class of bug fixed in moveEmail/bulkUpdateFlags/
          // updateMessageLabels/deleteEmail). uidMap only reflects reality
          // when UIDPLUS is active (confirmed live on this Bridge account);
          // without it, fall back to trusting the bulk result as before —
          // no reliable per-UID signal exists on such a server. Found live:
          // bulk_move with one real id and one deliberately fake one
          // reported ok:true for both.
          if (hasUidPlus && !uidMap?.has(uid)) {
            results.push({ uid, emailId, ok: false, error: `Email not found for uid ${uid}` });
            failed++;
            continue;
          }
          this.messageCache.delete(emailId);
          results.push({ uid, emailId, ok: true });
          succeeded++;
        }
      } catch (err) {
        for (const uid of uids) {
          const emailId = createEmailId(folder, uid);
          results.push({ uid, emailId, ok: false, error: String(err) });
          failed++;
        }
      }
    }

    this.lastSyncAt = new Date().toISOString();
    return { dryRun: false, total: uids.length, succeeded, failed, notFound: 0, results };
  }

  async bulkDelete(input: {
    emailIds?: string[];
    match?: BulkMatchCriteria;
    folder?: string;
    permanent?: boolean;
    dryRun?: boolean;
  }): Promise<BulkOperationResult> {
    const folder = input.folder?.trim() || "INBOX";
    const uids = await this.resolveUidsForBulkOp(folder, input.emailIds, input.match);

    if (input.dryRun) {
      return {
        dryRun: true,
        total: uids.length,
        succeeded: 0,
        failed: 0,
        notFound: 0,
        results: [],
      };
    }

    const trashFolder = input.permanent
      ? undefined
      : await this.resolveSpecialFolder("\\Trash", ["Trash", "INBOX.Trash"]);

    let succeeded = 0;
    let failed = 0;
    const results: BulkOperationResult["results"] = [];

    if (uids.length > 0) {
      const uidSet = uids.join(",");
      try {
        let existingUids: Set<number>;
        if (input.permanent || !trashFolder) {
          // messageDelete's EXPUNGE gives no reliable per-UID signal at
          // all — its truthy result only means the server accepted the
          // command, not that any given UID actually matched a message
          // (same class of bug fixed in deleteEmail). Since this branch is
          // permanent and irreversible, confirm existence with a search
          // *before* issuing the delete rather than trying to infer it
          // after the fact. Found live: bulk_delete with one real id and
          // one deliberately fake one reported ok:true for both.
          existingUids = await this.withMailbox(folder, true, async (client) => {
            const found = await client.search({ uid: uidSet }, { uid: true });
            return new Set(Array.isArray(found) ? found : []);
          });
          await this.withMailbox(folder, false, async (client) => {
            const deleted = await client.messageDelete(uidSet, { uid: true });
            if (!deleted) throw new Error(`Server did not delete uid set ${uidSet}`);
          });
        } else {
          let uidMap: Map<number, number> | undefined;
          let hasUidPlus = false;
          await this.withMailbox(folder, false, async (client) => {
            const moved = await client.messageMove(uidSet, trashFolder, { uid: true });
            if (moved === false) throw new Error(`Server did not move uid set ${uidSet} to trash`);
            uidMap = moved.uidMap;
            hasUidPlus = client.capabilities.has("UIDPLUS");
          });
          // Same UIDPLUS-gated check as bulkMove — see its comment for why
          // a server lacking UIDPLUS falls back to trusting the bulk result.
          existingUids = hasUidPlus && uidMap ? new Set(uidMap.keys()) : new Set(uids);
        }
        for (const uid of uids) {
          const emailId = createEmailId(folder, uid);
          if (!existingUids.has(uid)) {
            results.push({ uid, emailId, ok: false, error: `Email not found for uid ${uid}` });
            failed++;
            continue;
          }
          this.messageCache.delete(emailId);
          results.push({ uid, emailId, ok: true });
          succeeded++;
        }
      } catch (err) {
        for (const uid of uids) {
          const emailId = createEmailId(folder, uid);
          results.push({ uid, emailId, ok: false, error: String(err) });
          failed++;
        }
      }
    }

    this.lastSyncAt = new Date().toISOString();
    return { dryRun: false, total: uids.length, succeeded, failed, notFound: 0, results };
  }

  async bulkUpdateFlags(input: {
    emailIds?: string[];
    match?: BulkMatchCriteria;
    folder?: string;
    flagsToAdd?: string[];
    flagsToRemove?: string[];
    dryRun?: boolean;
  }): Promise<BulkOperationResult> {
    const folder = input.folder?.trim() || "INBOX";
    const uids = await this.resolveUidsForBulkOp(folder, input.emailIds, input.match);

    if (input.dryRun) {
      return {
        dryRun: true,
        total: uids.length,
        succeeded: 0,
        failed: 0,
        notFound: 0,
        results: [],
      };
    }

    const flagsToAdd = input.flagsToAdd ?? [];
    const flagsToRemove = input.flagsToRemove ?? [];
    let succeeded = 0;
    let failed = 0;
    const results: BulkOperationResult["results"] = [];

    if (uids.length > 0) {
      const uidSet = uids.join(",");
      try {
        const notAppliedByUid = new Map<number, string[]>();
        await this.withMailbox(folder, false, async (client) => {
          if (flagsToAdd.length > 0) {
            await client.messageFlagsAdd(uidSet, flagsToAdd, { uid: true });
          }
          if (flagsToRemove.length > 0) {
            await client.messageFlagsRemove(uidSet, flagsToRemove, { uid: true });
          }
          for await (const message of client.fetch(uidSet, { uid: true, flags: true }, { uid: true })) {
            const actual = new Set(Array.from(message.flags ?? []).map((flag: string) => flag.toLowerCase()));
            const notApplied = [
              ...flagsToAdd.filter((flag) => !actual.has(flag.toLowerCase())),
              ...flagsToRemove.filter((flag) => actual.has(flag.toLowerCase())),
            ];
            notAppliedByUid.set(message.uid, notApplied);
          }
        });
        for (const uid of uids) {
          const emailId = createEmailId(folder, uid);
          // A UID absent from the fetch loop above (never got a
          // notAppliedByUid entry) means the IMAP FETCH found no message
          // for it — the earlier STORE call already silently no-op'd for
          // it too (same class of bug fixed in markEmailRead/moveEmail).
          // The old code defaulted to notApplied:[] here, reporting
          // ok:true for a UID that was never actually touched. Found live
          // via bulk_update_flags with one real id and one deliberately
          // fake one.
          if (!notAppliedByUid.has(uid)) {
            results.push({ uid, emailId, ok: false, error: `Email not found for uid ${uid}` });
            failed++;
            continue;
          }
          results.push({ uid, emailId, ok: true, notApplied: notAppliedByUid.get(uid) as string[] });
          succeeded++;
        }
      } catch (err) {
        for (const uid of uids) {
          const emailId = createEmailId(folder, uid);
          results.push({ uid, emailId, ok: false, error: String(err) });
          failed++;
        }
      }
    }

    return { dryRun: false, total: uids.length, succeeded, failed, notFound: 0, results };
  }

  async bulkUpdateLabels(input: {
    emailIds?: string[];
    match?: BulkMatchCriteria;
    folder?: string;
    labelsToAdd?: string[];
    labelsToRemove?: string[];
    dryRun?: boolean;
  }): Promise<BulkOperationResult> {
    const folder = input.folder?.trim() || "INBOX";
    const uids = await this.resolveUidsForBulkOp(folder, input.emailIds, input.match);

    if (input.dryRun) {
      return {
        dryRun: true,
        total: uids.length,
        succeeded: 0,
        failed: 0,
        notFound: 0,
        results: [],
      };
    }

    const labelsToAdd = input.labelsToAdd ?? [];
    const labelsToRemove = input.labelsToRemove ?? [];
    let succeeded = 0;
    let failed = 0;
    const results: BulkOperationResult["results"] = [];

    for (const uid of uids) {
      const emailId = createEmailId(folder, uid);
      try {
        await this.updateMessageLabels(emailId, labelsToAdd, labelsToRemove);
        results.push({ uid, emailId, ok: true });
        succeeded++;
      } catch (err) {
        results.push({ uid, emailId, ok: false, error: String(err) });
        failed++;
      }
    }

    return { dryRun: false, total: uids.length, succeeded, failed, notFound: 0, results };
  }

  async topSenders(input: {
    folder?: string;
    since?: string;
    before?: string;
    limit?: number;
    scanLimit?: number;
    excludeSelf?: boolean;
  }): Promise<{ folder: string; scanned: number; senders: SenderFrequency[] }> {
    const folder = input.folder?.trim() || "INBOX";
    const scanLimit = input.scanLimit ?? 5000;
    const topLimit = input.limit ?? 20;
    const selfAddress = this.config.smtp.username.toLowerCase();

    const searchInput: SearchEmailsInput = {
      folder,
      dateFrom: input.since,
      dateTo: input.before,
    };
    const query = this.buildSearchQuery(searchInput);

    const uids: number[] = await this.withMailbox(folder, true, async (client) => {
      const found = await client.search(query, { uid: true });
      return Array.isArray(found) ? found : [];
    });

    const page = uids.slice(-scanLimit);
    if (page.length === 0) {
      return { folder, scanned: 0, senders: [] };
    }

    const uidSet = page.join(",");
    const freq = new Map<string, SenderFrequency>();

    await this.withMailbox(folder, true, async (client) => {
      for await (const message of client.fetch(uidSet, FETCH_SUMMARY_QUERY, { uid: true })) {
        const fromAddrs = mapEnvelopeAddresses(message.envelope?.from);
        if (fromAddrs.length === 0) continue;
        const addr = (fromAddrs[0].address ?? "").toLowerCase();
        if (!addr) continue;
        if (input.excludeSelf && addr === selfAddress) continue;
        const existing = freq.get(addr);
        if (existing) {
          existing.count++;
        } else {
          freq.set(addr, {
            address: addr,
            name: fromAddrs[0].name,
            count: 1,
            direction: addr === selfAddress ? "self" : "received",
          });
        }
      }
    });

    const sorted = Array.from(freq.values()).sort((a, b) => b.count - a.count).slice(0, topLimit);
    return { folder, scanned: page.length, senders: sorted };
  }

  private async resolveThreadUids(
    messageId: string,
    acrossFolders = true,
    folders?: string[],
  ): Promise<Array<{ folder: string; uid: number; emailId: string }>> {
    const results: Array<{ folder: string; uid: number; emailId: string }> = [];

    // acrossFolders was previously accepted and documented ("Also search
    // Sent and All Mail.", default false) but silently discarded — every
    // call unconditionally scanned every selectable folder (up to 20),
    // regardless of what the caller asked for. On a real account with more
    // than a handful of folders/labels this reliably exceeds a client's
    // request timeout (confirmed live: 14 folders -> 28 sequential
    // Message-ID/References searches -> guaranteed 60s+ timeout on every
    // move_thread/delete_thread/flag_thread call). Honor it: the narrow
    // default only searches INBOX and Sent (where a thread's own messages
    // realistically live), expanding to every selectable folder only when
    // the caller opts in.
    let foldersToSearch: string[];
    if (folders && folders.length > 0) {
      foldersToSearch = folders;
    } else if (acrossFolders) {
      foldersToSearch = await this.resolveSelectableFolderPaths(20);
    } else {
      const allFolders = await this.getFolders();
      foldersToSearch = allFolders
        .filter((entry) => entry.specialUse === "\\Sent" || entry.path === "INBOX")
        .map((entry) => entry.path);
    }

    for (const folder of foldersToSearch) {
      try {
        const [byMsgId, byRefs] = await Promise.all([
          this.withMailbox(folder, true, async (client) => {
            const found = await client.search({ header: { "Message-ID": messageId } }, { uid: true });
            return Array.isArray(found) ? found : [];
          }).catch(() => [] as number[]),
          this.withMailbox(folder, true, async (client) => {
            const found = await client.search({ header: { "References": messageId } }, { uid: true });
            return Array.isArray(found) ? found : [];
          }).catch(() => [] as number[]),
        ]);
        const seen = new Set<number>();
        for (const uid of [...byMsgId, ...byRefs]) {
          if (!seen.has(uid)) {
            seen.add(uid);
            results.push({ folder, uid, emailId: createEmailId(folder, uid) });
          }
        }
      } catch { /* skip inaccessible folders */ }
    }

    return results;
  }

  async moveThread(input: {
    messageId: string;
    destination: string;
    acrossFolders?: boolean;
    dryRun?: boolean;
  }): Promise<{ messageId: string; destination: string; moved: number; notMoved: number; dryRun: boolean }> {
    const matches = await this.resolveThreadUids(input.messageId, input.acrossFolders ?? false);

    if (input.dryRun) {
      return { messageId: input.messageId, destination: input.destination, moved: matches.length, notMoved: 0, dryRun: true };
    }

    let moved = 0;
    let notMoved = 0;

    for (const { folder, uid, emailId } of matches) {
      try {
        await this.withMailbox(folder, false, async (client) => {
          const result = await client.messageMove(String(uid), input.destination, { uid: true });
          if (result === false) throw new Error(`Server did not move uid ${uid}`);
        });
        this.messageCache.delete(emailId);
        moved++;
      } catch {
        notMoved++;
      }
    }

    this.lastSyncAt = new Date().toISOString();
    return { messageId: input.messageId, destination: input.destination, moved, notMoved, dryRun: false };
  }

  async deleteThread(input: {
    messageId: string;
    permanent?: boolean;
    acrossFolders?: boolean;
    dryRun?: boolean;
  }): Promise<{ messageId: string; deleted: number; dryRun: boolean }> {
    const matches = await this.resolveThreadUids(input.messageId, input.acrossFolders ?? false);

    if (input.dryRun) {
      return { messageId: input.messageId, deleted: matches.length, dryRun: true };
    }

    // No .catch() here — a Trash-resolution failure must propagate as a
    // hard error rather than silently falling into the permanent-delete
    // branch below when the caller explicitly asked for permanent:false.
    // Matches bulkDelete's (correct) handling of the identical situation;
    // this method previously swallowed the rejection and permanent-deleted
    // instead, contradicting its own documented "false moves to Trash".
    const trashFolder = input.permanent
      ? undefined
      : await this.resolveSpecialFolder("\\Trash", ["Trash", "INBOX.Trash"]);

    let deleted = 0;

    for (const { folder, uid, emailId } of matches) {
      try {
        if (input.permanent || !trashFolder) {
          await this.withMailbox(folder, false, async (client) => {
            await client.messageDelete(String(uid), { uid: true });
          });
        } else {
          await this.withMailbox(folder, false, async (client) => {
            await client.messageMove(String(uid), trashFolder, { uid: true });
          });
        }
        this.messageCache.delete(emailId);
        deleted++;
      } catch { /* best-effort */ }
    }

    this.lastSyncAt = new Date().toISOString();
    return { messageId: input.messageId, deleted, dryRun: false };
  }

  async flagThread(input: {
    messageId: string;
    flagsToAdd?: string[];
    flagsToRemove?: string[];
    acrossFolders?: boolean;
    dryRun?: boolean;
  }): Promise<{ messageId: string; affected: number; notApplied: string[]; dryRun: boolean }> {
    const matches = await this.resolveThreadUids(input.messageId, input.acrossFolders ?? false);

    if (input.dryRun) {
      return { messageId: input.messageId, affected: matches.length, notApplied: [], dryRun: true };
    }

    const flagsToAdd = input.flagsToAdd ?? [];
    const flagsToRemove = input.flagsToRemove ?? [];
    let affected = 0;
    const allNotApplied: string[] = [];

    for (const { folder, uid } of matches) {
      try {
        await this.withMailbox(folder, false, async (client) => {
          if (flagsToAdd.length > 0) {
            await client.messageFlagsAdd(String(uid), flagsToAdd, { uid: true });
          }
          if (flagsToRemove.length > 0) {
            await client.messageFlagsRemove(String(uid), flagsToRemove, { uid: true });
          }
          const notAppliedAdds = flagsToAdd.length > 0
            ? await this.verifyFlags(client, uid, flagsToAdd, true)
            : [];
          const notAppliedRemoves = flagsToRemove.length > 0
            ? await this.verifyFlags(client, uid, flagsToRemove, false)
            : [];
          allNotApplied.push(...notAppliedAdds, ...notAppliedRemoves);
        });
        affected++;
      } catch { /* best-effort */ }
    }

    return { messageId: input.messageId, affected, notApplied: [...new Set(allNotApplied)], dryRun: false };
  }

  async syncEmails(input: SyncEmailsInput = {}): Promise<{
    syncedAt: string;
    full: boolean;
    folders: Array<MailboxSyncCheckpoint>;
    cachedMessages: number;
  }> {
    const snapshot = await this.collectEmailsForIndex(input);
    return {
      syncedAt: snapshot.syncedAt,
      full: snapshot.full,
      folders: snapshot.folderStats,
      cachedMessages: this.messageCache.size,
    };
  }

  async collectEmailsForIndex(input: SyncEmailsInput = {}): Promise<{
    syncedAt: string;
    full: boolean;
    folders: FolderInfo[];
    folderStats: Array<MailboxSyncCheckpoint>;
    emails: EmailSummary[];
  }> {
    const folders = await this.resolveFolders(input.folder);
    const full = Boolean(input.full);
    const limit = normalizeLimit(input.limitPerFolder, full ? 250 : 50, 1, 500);
    const includeAttachmentText = input.includeAttachmentText !== false;
    const folderStats: Array<MailboxSyncCheckpoint> = [];
    const emails: EmailSummary[] = [];
    const syncedAt = new Date().toISOString();

    for (const folder of folders) {
      const batch = await this.collectFolderForIndex(folder, {
        full,
        limit,
        includeAttachmentText,
        checkpoint: input.checkpoints?.[folder],
        syncedAt,
      });
      folderStats.push(batch.checkpoint);
      emails.push(...batch.emails);
    }

    this.lastSyncAt = syncedAt;
    return {
      syncedAt,
      full,
      folders: await this.getFolders(true),
      folderStats,
      emails,
    };
  }

  private async collectFolderForIndex(
    folder: string,
    input: {
      full: boolean;
      limit: number;
      includeAttachmentText: boolean;
      checkpoint?: MailboxSyncCheckpoint;
      syncedAt: string;
    },
  ): Promise<{
    checkpoint: MailboxSyncCheckpoint;
    emails: EmailSummary[];
  }> {
    return this.withMailbox(folder, true, async (client) => {
      const mailbox = client.mailbox || undefined;
      const uidNext = mailbox?.uidNext;
      const uidValidity = mailbox?.uidValidity?.toString();
      const exists = mailbox?.exists ?? 0;
      const plan = planFolderSync({
        folder,
        exists,
        uidNext,
        uidValidity,
        full: input.full,
        limit: input.limit,
        checkpoint: input.checkpoint,
      });

      if (!plan.startUid || !plan.endUid || plan.endUid < plan.startUid) {
        return {
          checkpoint: {
            folder,
            uidValidity,
            uidNext,
            highestUid: plan.highestKnownUid,
            lastSyncAt: input.syncedAt,
            lastFullSyncAt:
              plan.strategy === "full"
                ? input.syncedAt
                : input.checkpoint?.lastFullSyncAt,
            strategy: plan.strategy,
            changed: plan.changed,
            fetched: 0,
            total: exists,
          },
          emails: [],
        };
      }

      // On an unchanged incremental window (nothing new, checkpoint still matches),
      // the overlap range only needs a flags refresh — IMAP content for a given UID
      // never changes, so re-fetching source and re-parsing preview/attachmentText
      // on every idle sync tick is pure waste. recordSnapshot's upsert preserves the
      // existing preview/attachment_text via COALESCE when they come back unset here.
      const needsFullDetail = plan.strategy !== "incremental_window";
      const fetchQuery = needsFullDetail ? FETCH_INDEX_DETAIL_QUERY : FETCH_INDEX_QUERY;

      const emails: EmailSummary[] = [];
      for await (const message of client.fetch(`${plan.startUid}:${plan.endUid}`, fetchQuery, { uid: true })) {
        const summary = this.toSummary(folder, message);
        const enriched = message.source
          ? this.enrichSummaryFromParsed(summary, await this.parseSource(message.source), input.includeAttachmentText)
          : summary;
        emails.push(enriched);
        this.messageCache.set(enriched.id, enriched);
      }

      const highestUid = emails.reduce((max, email) => Math.max(max, email.uid), 0) || plan.highestKnownUid;
      return {
        checkpoint: {
          folder,
          uidValidity,
          uidNext,
          highestUid,
          lastSyncAt: input.syncedAt,
          lastFullSyncAt:
            plan.strategy === "full"
              ? input.syncedAt
              : input.checkpoint?.lastFullSyncAt,
          strategy: plan.strategy,
          changed: plan.changed,
          fetched: emails.length,
          total: exists,
        },
        emails,
      };
    });
  }

  async archiveEmail(emailId: string): Promise<{
    emailId: string;
    sourceEmailId: string;
    fromFolder: string;
    targetFolder: string;
    uid: number;
    targetUid?: number;
    targetEmailId?: string;
  }> {
    const targetFolder = await this.resolveSpecialFolder("\\Archive", ["Archive", "All Mail"]);
    return this.moveEmail(emailId, targetFolder);
  }

  async trashEmail(emailId: string): Promise<{
    emailId: string;
    sourceEmailId: string;
    fromFolder: string;
    targetFolder: string;
    uid: number;
    targetUid?: number;
    targetEmailId?: string;
  }> {
    const targetFolder = await this.resolveSpecialFolder("\\Trash", ["Trash"]);
    return this.moveEmail(emailId, targetFolder);
  }

  async restoreEmail(
    emailId: string,
    targetFolder?: string,
  ): Promise<{
    emailId: string;
    sourceEmailId: string;
    fromFolder: string;
    targetFolder: string;
    uid: number;
    targetUid?: number;
    targetEmailId?: string;
  }> {
    const destination =
      targetFolder?.trim() || (await this.resolveSpecialFolder("\\Inbox", ["INBOX"]));
    return this.moveEmail(emailId, destination);
  }

  async getAnalyticsSample(days = 30, limitPerFolder = 100): Promise<EmailSummary[]> {
    const dateFrom = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const folders = await this.resolveFolders();
    const emails: EmailSummary[] = [];

    for (const folder of folders) {
      const result = await this.searchEmails({
        folder,
        dateFrom,
        limit: limitPerFolder,
      });
      emails.push(...result.emails);
    }

    return sortEmailsByNewest(dedupeEmails(emails));
  }

  clearCache(): { clearedMessages: number; clearedFolders: boolean } {
    const clearedMessages = this.messageCache.size;
    const clearedFolders = Boolean(this.folderCache);
    this.messageCache.clear();
    this.folderCache = undefined;
    this.lastSyncAt = undefined;

    return { clearedMessages, clearedFolders };
  }

  async listRemoteDrafts(limit = 50, offset = 0): Promise<{
    folder: string;
    total: number;
    limit: number;
    offset: number;
    emails: EmailSummary[];
  }> {
    const folder = await this.resolveSpecialFolder("\\Drafts", ["Drafts"]);
    return this.getEmails({ folder, limit, offset });
  }

  async upsertRemoteDraft(input: {
    raw: Buffer;
    messageId: string;
    existingEmailId?: string;
  }): Promise<RemoteDraftRef> {
    const folder = await this.resolveSpecialFolder("\\Drafts", ["Drafts"]);

    const client = await this.ensureConnected();
    const appended = await client.append(folder, input.raw, ["\\Draft"], new Date());
    if (!appended) {
      throw new Error("Server did not append the draft message");
    }

    let uid = appended.uid;
    if (!uid) {
      uid = await this.findUidByHeader(folder, "message-id", input.messageId);
    }

    if (input.existingEmailId) {
      await this.deleteEmail(input.existingEmailId);
    }

    this.folderCache = undefined;
    this.lastSyncAt = new Date().toISOString();

    return {
      folder,
      uid,
      emailId: uid ? createEmailId(folder, uid) : undefined,
      messageId: input.messageId,
      syncedAt: this.lastSyncAt,
    };
  }

  async deleteRemoteDraft(emailId: string): Promise<{
    emailId: string;
    folder: string;
    uid: number;
    deleted: true;
  }> {
    return this.deleteEmail(emailId);
  }

  private async ensureConnected(): Promise<ImapFlow> {
    if (!this.client?.usable) {
      await this.connect();
    }

    if (!this.client) {
      throw new Error("Failed to initialize IMAP client");
    }

    return this.client;
  }

  private shouldRelaxTlsVerification(): boolean {
    const host = this.config.imap.host.trim().toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  }

  private async withMailbox<T>(
    folder: string,
    readOnly: boolean,
    action: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    await this._throttle(this.opDelayMs);
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(folder, { readOnly });

    try {
      return await action(client);
    } finally {
      lock.release();
    }
  }

  private buildSearchQuery(input: SearchEmailsInput): SearchObject {
    const query: SearchObject = {};

    if (input.query) {
      query.text = input.query;
    }
    if (input.from) {
      query.from = input.from;
    }
    if (input.to) {
      query.to = input.to;
    }
    if (input.cc) {
      query.cc = input.cc;
    }
    if (input.bcc) {
      query.bcc = input.bcc;
    }
    if (input.subject) {
      query.subject = input.subject;
    }
    if (typeof input.isRead === "boolean") {
      query.seen = input.isRead;
    }
    if (typeof input.isStarred === "boolean") {
      query.flagged = input.isStarred;
    }

    const dateFrom = parseDateInput(input.dateFrom);
    const dateTo = parseDateInput(input.dateTo);

    if (dateFrom) {
      query.since = dateFrom;
    }
    if (dateTo) {
      query.before = nextDay(dateTo);
    }

    // typeof checks, not truthy checks: sizeSmaller:0 is a legitimate,
    // meaningful value ("smaller than 0 bytes" — logically always zero
    // results) that a truthy check silently dropped, turning it into "no
    // size filter at all" and returning every message instead. Found live:
    // count_messages with sizeSmaller:0 returned the full unfiltered count.
    if (typeof input.sizeLarger === "number") {
      query.larger = input.sizeLarger;
    }
    if (typeof input.sizeSmaller === "number") {
      query.smaller = input.sizeSmaller;
    }
    if (input.listId || input.messageId) {
      const headers: Record<string, string> = { ...(query.header as Record<string, string> | undefined) };
      if (input.listId) headers["List-ID"] = input.listId;
      if (input.messageId) headers["Message-ID"] = input.messageId;
      query.header = headers;
    }

    if (Object.keys(query).length === 0) {
      query.all = true;
    }

    return query;
  }

  private async resolveSelectableFolderPaths(maxFolders?: number): Promise<string[]> {
    const folders = await this.getFolders();
    return folders
      .filter((entry) => !Array.from(entry.flags ?? []).some((flag) => {
        const normalized = flag.replace(/^\\/, "").toLowerCase();
        return normalized === "noselect";
      }))
      .map((entry) => entry.path)
      .slice(0, maxFolders);
  }

  private async resolveFolders(folder?: string): Promise<string[]> {
    if (folder?.trim()) {
      // Comma-separated list of folder paths, same convention as batch_email_action's
      // emailIds — lets a single sync/search call scope to e.g. "INBOX,Sent" instead
      // of only ever a single folder or every folder.
      return folder
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    }

    const folders = await this.getFolders();
    return folders
      .filter((entry) => !entry.flags.includes("\\Noselect"))
      .map((entry) => entry.path);
  }

  private async resolveSpecialFolder(
    specialUse: string,
    fallbacks: string[],
  ): Promise<string> {
    const folders = await this.getFolders();

    const bySpecialUse = folders.find((folder) => folder.specialUse === specialUse);
    if (bySpecialUse) {
      return bySpecialUse.path;
    }

    const byFallback = folders.find((folder) =>
      fallbacks.some((fallback) => folder.path.toLowerCase() === fallback.toLowerCase()),
    );
    if (byFallback) {
      return byFallback.path;
    }

    throw new Error(`Unable to find target folder for ${specialUse}`);
  }

  private async findUidByHeader(
    folder: string,
    header: string,
    value: string,
  ): Promise<number | undefined> {
    return this.withMailbox(folder, true, async (client) => {
      const result = await client.search(
        {
          header: {
            [header]: value,
          },
        },
        { uid: true },
      );

      if (!result || result.length === 0) {
        return undefined;
      }

      return [...result].sort((left, right) => right - left)[0];
    });
  }

  private toSummary(folder: string, message: FetchMessageObject): EmailSummary {
    const flags = [...(message.flags ?? [])];
    const attachments = extractAttachments(message.bodyStructure);

    return {
      id: createEmailId(folder, message.uid),
      folder,
      uid: message.uid,
      seq: message.seq,
      messageId: message.envelope?.messageId,
      inReplyTo: message.envelope?.inReplyTo,
      references: [],
      threadId: message.threadId,
      subject: message.envelope?.subject || "(no subject)",
      from: mapEnvelopeAddresses(message.envelope?.from),
      to: mapEnvelopeAddresses(message.envelope?.to),
      cc: mapEnvelopeAddresses(message.envelope?.cc),
      bcc: mapEnvelopeAddresses(message.envelope?.bcc),
      replyTo: mapEnvelopeAddresses(message.envelope?.replyTo),
      date: message.envelope?.date?.toISOString(),
      internalDate:
        message.internalDate instanceof Date
          ? message.internalDate.toISOString()
          : message.internalDate,
      isRead: flags.includes("\\Seen"),
      isStarred: flags.includes("\\Flagged"),
      flags,
      size: message.size,
      preview: undefined,
      hasAttachments: attachments.length > 0,
      attachments,
      attachmentText: undefined,
      labels: [...(message.labels ?? [])],
    };
  }

  private enrichSummaryFromParsed(
    summary: EmailSummary,
    parsed: ParsedMail,
    includeAttachmentText: boolean,
  ): EmailSummary {
    const parsedAttachments = this.mapParsedAttachments(parsed);
    const htmlText = stripHtmlToText(typeof parsed.html === "string" ? parsed.html : undefined);
    const references = extractMessageIdList(this.readHeaderValue(parsed, "references"));

    return {
      ...summary,
      subject: parsed.subject || summary.subject,
      from: parsed.from ? mapParsedAddresses(parsed.from) : summary.from,
      to: parsed.to ? mapParsedAddresses(parsed.to) : summary.to,
      cc: parsed.cc ? mapParsedAddresses(parsed.cc) : summary.cc,
      bcc: parsed.bcc ? mapParsedAddresses(parsed.bcc) : summary.bcc,
      replyTo: parsed.replyTo ? mapParsedAddresses(parsed.replyTo) : summary.replyTo,
      preview: previewText(parsed.text || htmlText || summary.preview),
      references,
      attachments:
        parsedAttachments.length > 0 && parsedAttachments.length >= summary.attachments.length
          ? parsedAttachments
          : summary.attachments,
      hasAttachments: summary.hasAttachments || parsedAttachments.length > 0,
      attachmentText: includeAttachmentText ? this.extractAttachmentSearchText(parsed) : undefined,
    };
  }

  private async parseSource(source: Buffer): Promise<ParsedMail> {
    return simpleParser(source);
  }

  private async getParsedMailDetail(emailId: string): Promise<{
    detail: EmailDetail;
    parsed: ParsedMail;
  }> {
    const { folder, uid } = parseEmailId(emailId);

    const { enriched, parsed } = await this.withMailbox(folder, true, async (client) => {
      // NOTE: UIDs can be reused after mailbox recreation (UIDVALIDITY change).
      // assertMailboxUidValidity handles this at the withMailbox level for mutating
      // ops. For read-only fetches, callers should re-sync after a UIDVALIDITY
      // change to avoid fetching the wrong message with a recycled UID.
      const message = await client.fetchOne(String(uid), FETCH_DETAIL_QUERY, { uid: true });
      if (!message || !message.source) {
        throw new Error(`Email not found for id ${emailId}`);
      }

      const summary = this.toSummary(folder, message);
      const parsed = await this.parseSource(message.source);
      const enriched = this.enrichSummaryFromParsed(summary, parsed, true);
      return { enriched, parsed };
    });

    // toSummary's `labels` comes from imapflow's `labels` fetch field, which
    // maps to Gmail's X-GM-LABELS extension — Proton Bridge doesn't
    // implement it, so that field is always empty here regardless of the
    // message's real Proton labels (applied via updateMessageLabels's COPY
    // to a Labels/<name> virtual folder). Found live: a message freshly
    // labeled and confirmed present in Labels/mcptest-label still read back
    // labels:[]. Resolve them the same way updateMessageLabels's own
    // label-removal path already does — a bounded Message-ID search across
    // known label folders — for this single-message detail fetch only;
    // doing this per-message in a bulk list (getEmails/searchEmails) would
    // multiply IMAP round-trips by folder count and isn't worth that cost.
    // Must run AFTER the mailbox lock above is released: withMailbox holds a
    // single-client exclusive lock per call, and resolveMessageLabels needs
    // to select other folders on that same client — calling it from inside
    // the outer withMailbox's callback deadlocked (found immediately, live,
    // the very first time this ran: `read` never returned).
    const resolvedLabels = await this.resolveMessageLabels(enriched.messageId, folder);
    const detail: EmailDetail = {
      ...enriched,
      labels: resolvedLabels.length > 0 ? resolvedLabels : enriched.labels,
      // parsed.text (the sender's own authored plain-text part, when
      // present) is left untouched — only the HTML-only fallback goes
      // through Markdown conversion instead of stripHtmlToText, so links,
      // lists, and emphasis survive instead of being discarded outright.
      // This raw text is reused as-is by reply/forward composition
      // (buildReplyText/buildForwardText in index.ts) — quote-folding for
      // display happens later, only in the tool-output formatting layer
      // (formatEmailDetailOutput), so composing a reply or forward still
      // quotes the real original rather than a folded marker.
      text: parsed.text || htmlToMarkdown(typeof parsed.html === "string" ? parsed.html : undefined),
      html: parsed.html,
      headers: this.mapHeaders(parsed),
    };

    this.messageCache.set(detail.id, detail);
    return { detail, parsed };
  }

  private async resolveMessageLabels(messageId: string | undefined, ownFolder: string): Promise<string[]> {
    if (!messageId) {
      return [];
    }

    const folders = await this.getFolders();
    const labelFolders = folders
      .map((entry) => entry.path)
      .filter((path) => path.startsWith("Labels/") && path !== ownFolder)
      // Same bound as resolveSelectableFolderPaths — caps worst-case IMAP
      // round-trips for accounts with many labels.
      .slice(0, 20);

    const labels: string[] = [];
    for (const labelFolder of labelFolders) {
      try {
        const found = await this.withMailbox(labelFolder, true, async (client) => {
          const uids = await client.search({ header: { "Message-ID": messageId } }, { uid: true });
          return Array.isArray(uids) && uids.length > 0;
        });
        if (found) {
          labels.push(labelFolder);
        }
      } catch {
        // Best-effort — a transient SELECT/SEARCH failure on one label
        // folder shouldn't fail the whole read.
      }
    }
    return labels;
  }

  private readHeaderValue(parsed: ParsedMail | undefined, headerName: string): string | undefined {
    if (!parsed) {
      return undefined;
    }

    const value = parsed.headers.get(headerName);
    if (Array.isArray(value)) {
      return value.map((entry) => String(entry)).join(" ");
    }
    if (value === undefined || value === null) {
      return undefined;
    }
    return String(value);
  }

  private extractAttachmentSearchText(parsed: ParsedMail): string | undefined {
    const parts = (parsed.attachments ?? [])
      .flatMap((attachment) => {
        // Guard against zero-byte attachments to avoid calling toString() on empty content
        if (!attachment.content || attachment.content.length === 0) {
          return [];
        }

        if (attachment.content.length > MAX_ATTACHMENT_TEXT_BYTES) {
          return [];
        }

        const contentType = attachment.contentType?.toLowerCase();
        if (contentType === "text/html") {
          return [stripHtmlToText(attachment.content.toString("utf8")) || ""];
        }

        if (contentType === "text/calendar") {
          return [summarizeCalendarText(attachment.content.toString("utf8")) || ""];
        }

        if (isTextLikeMimeType(contentType)) {
          // GAP-13: mailparser decodes text/* parts to UTF-8 before populating
          // attachment.content, so utf8 is correct here. If a charset parameter
          // is present on a non-utf8/ascii encoding and mailparser couldn't convert
          // it (e.g. an obscure EBCDIC variant), we fall back to latin1, which is
          // a safe lossless representation of any single-byte encoding.
          // iconv-lite would handle multi-byte non-UTF charsets more correctly but
          // is not a current dependency.
          let decoded: string;
          try {
            decoded = attachment.content.toString("utf8");
            // Detect common replacement-character pattern indicating wrong encoding
            if (decoded.includes("�")) {
              decoded = attachment.content.toString("latin1");
            }
          } catch {
            decoded = attachment.content.toString("latin1");
          }
          return [previewText(decoded, 8_000) || ""];
        }

        return [];
      })
      .filter(Boolean);

    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }

  private mapParsedAttachments(parsed?: ParsedMail): EmailDetail["attachments"] {
    return (parsed?.attachments ?? []).map((attachment, index) => {
      const classification = classifyAttachment({
        filename: attachment.filename,
        contentType: attachment.contentType,
        disposition: attachment.contentDisposition,
        cid: attachment.cid,
      });

      return {
        id: createParsedAttachmentId(attachment, index),
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.size,
        disposition: attachment.contentDisposition,
        cid: attachment.cid,
        checksum: attachment.checksum,
        isInline: attachment.contentDisposition === "inline",
        kind: classification.kind,
        isCalendarInvite: classification.isCalendarInvite,
        isSignature: classification.isSignature,
      };
    });
  }

  private mapParsedAttachmentsWithContent(
    parsed: ParsedMail,
  ): Array<EmailDetail["attachments"][number] & { content: Buffer; checksum?: string }> {
    return (parsed.attachments ?? []).map((attachment, index) => ({
      id: createParsedAttachmentId(attachment, index),
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.size,
      disposition: attachment.contentDisposition,
      cid: attachment.cid,
      checksum: attachment.checksum,
      isInline: attachment.contentDisposition === "inline",
      ...classifyAttachment({
        filename: attachment.filename,
        contentType: attachment.contentType,
        disposition: attachment.contentDisposition,
        cid: attachment.cid,
      }),
      content: attachment.content,
    }));
  }

  private mapHeaders(parsed?: ParsedMail): Record<string, unknown> {
    if (!parsed) {
      return {};
    }

    return Object.fromEntries(
      [...parsed.headers.entries()].map(([key, value]) => [key, mapHeaderValue(value)]),
    );
  }

  private updateCachedMessage(
    emailId: string,
    updater: (email: EmailSummary) => EmailSummary,
  ): void {
    const cached = this.messageCache.get(emailId);
    if (!cached) {
      return;
    }

    this.messageCache.set(emailId, updater(cached));
  }

  private async getParsedAttachment(
    emailId: string,
    attachmentId: string,
  ): Promise<
    EmailDetail["attachments"][number] & {
      content: Buffer;
      checksum?: string;
    }
  > {
    const { detail, parsed } = await this.getParsedMailDetail(emailId);
    const attachments = this.mapParsedAttachmentsWithContent(parsed);

    const match = attachments.find(
      (attachment) =>
        attachment.id === attachmentId ||
        attachment.filename === attachmentId ||
        attachment.checksum === attachmentId,
    );

    if (!match) {
      throw new Error(`Attachment ${attachmentId} not found on email ${detail.id}`);
    }

    return match;
  }

  private async assertAttachmentWithinInlineLimit(emailId: string, attachmentId: string): Promise<void> {
    const { folder, uid } = parseEmailId(emailId);
    const estimatedSize = await this.withMailbox(folder, true, async (client) => {
      const message = await client.fetchOne(String(uid), FETCH_SUMMARY_QUERY, { uid: true });
      if (!message) {
        throw new Error(`Email not found for id ${emailId}`);
      }

      const attachment = extractAttachments(message.bodyStructure).find(
        (candidate) =>
          candidate.id === attachmentId ||
          candidate.part === attachmentId ||
          candidate.filename === attachmentId ||
          candidate.checksum === attachmentId,
      );
      return attachment?.size ?? this.findAttachmentEstimatedSize(message.bodyStructure, attachmentId);
    });

    const maxInlineBytes = (this.config.runtime.maxInlineBytes ?? 40) * 1024;
    if (estimatedSize !== undefined && estimatedSize > maxInlineBytes * 1.5) {
      throw new Error(
        `Attachment too large for inline delivery (estimated ${estimatedSize} bytes). Use saveTo parameter.`,
      );
    }
  }

  private findAttachmentEstimatedSize(structure: unknown, attachmentId: string): number | undefined {
    if (!structure || typeof structure !== "object") {
      return undefined;
    }

    const node = structure as {
      part?: unknown;
      id?: unknown;
      size?: unknown;
      octets?: unknown;
      dispositionParameters?: { filename?: unknown };
      parameters?: { name?: unknown; filename?: unknown };
      childNodes?: unknown[];
    };
    const filename =
      typeof node.dispositionParameters?.filename === "string"
        ? node.dispositionParameters.filename
        : typeof node.parameters?.name === "string"
          ? node.parameters.name
          : typeof node.parameters?.filename === "string"
            ? node.parameters.filename
            : undefined;

    if (node.part === attachmentId || node.id === attachmentId || filename === attachmentId) {
      if (typeof node.size === "number") {
        return node.size;
      }
      if (typeof node.octets === "number") {
        return node.octets;
      }
    }

    for (const child of node.childNodes ?? []) {
      const childSize = this.findAttachmentEstimatedSize(child, attachmentId);
      if (childSize !== undefined) {
        return childSize;
      }
    }

    return undefined;
  }

  async sentCopyVerify(
    messageId: string,
    sentFolder: string,
    maxWaitMs = 30_000,
  ): Promise<{ found: boolean; uid?: number }> {
    const intervalMs = 3_000;
    const deadline = Date.now() + maxWaitMs;

    try {
      const folders = await this.getFolders();
      const sentNames = ["Sent", "Sent Mail", "Sent Messages", "INBOX.Sent"];
      const bySpecialUse = folders.find((folder) => folder.specialUse === "\\Sent");
      const byName = sentNames
        .map((name) => folders.find((folder) => folder.name === name || folder.path === name))
        .find((folder): folder is FolderInfo => Boolean(folder));
      const resolvedSentFolder = bySpecialUse?.path ?? byName?.path ?? sentFolder;

      while (Date.now() < deadline) {
        const uid = await this.withMailbox(resolvedSentFolder, true, async (client) => {
          const result = await client.search(
            { header: { "Message-ID": messageId } },
            { uid: true },
          );
          return Array.isArray(result) && result.length > 0 ? result[0] : undefined;
        }).catch(() => undefined);

        if (uid !== undefined) {
          return { found: true, uid };
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
      }
    } catch {
      // never throw
    }

    return { found: false };
  }

  private async _throttle(delayMs: number): Promise<void> {
    if (delayMs <= 0) {
      return;
    }
    const elapsed = Date.now() - this._lastOpTs;
    const gap = delayMs - elapsed;
    if (gap > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, gap));
    }
    this._lastOpTs = Date.now();
  }

  private assertMailboxUidValidity(client: ImapFlow, expectedUidValidity?: string): void {
    if (!expectedUidValidity) {
      return;
    }

    const mailbox = client.mailbox || undefined;
    if (mailbox?.uidValidity?.toString() !== expectedUidValidity) {
      throw new Error(UID_VALIDITY_MISMATCH_ERROR);
    }
  }

  private async writeAttachmentToPath(
    emailId: string,
    attachment: EmailDetail["attachments"][number] & { content: Buffer; checksum?: string },
    outputPath?: string,
  ): Promise<AttachmentContentResult> {
    const outputFilePath = await this.resolveAttachmentOutputPath(emailId, attachment, outputPath);
    await mkdir(dirname(outputFilePath), { recursive: true });
    await writeFile(outputFilePath, attachment.content);

    return {
      emailId,
      attachment: {
        id: attachment.id,
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.size,
        disposition: attachment.disposition,
        cid: attachment.cid,
        checksum: attachment.checksum,
        isInline: attachment.isInline,
        kind: attachment.kind,
        isCalendarInvite: attachment.isCalendarInvite,
        isSignature: attachment.isSignature,
      },
      outputPath: basename(outputFilePath),
    };
  }

  private guardAttachmentOutputPath(outputPath: string): void {
    const allowDir = process.env.PROTONMAIL_ALLOW_FILE_DOWNLOAD_DIR?.trim();
    if (!allowDir) {
      throw new Error("outputPath requires PROTONMAIL_ALLOW_FILE_DOWNLOAD_DIR to be configured.");
    }

    const targetPath = resolve(outputPath);
    const allowedRealPath = realpathSync(resolve(allowDir));
    let targetRealPath: string;
    try {
      targetRealPath = realpathSync(targetPath);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code === "ENOENT"
      ) {
        try {
          targetRealPath = realpathSync(dirname(targetPath)) + sep + basename(targetPath);
        } catch {
          throw new Error(`Output directory does not exist: ${dirname(targetPath)}`);
        }
      } else {
        throw error;
      }
    }

    if (!targetRealPath.startsWith(`${allowedRealPath}/`) && targetRealPath !== allowedRealPath) {
      throw new Error("outputPath path escapes the allowed directory.");
    }
  }

  private async resolveAttachmentOutputPath(
    emailId: string,
    attachment: { id?: string; filename?: string },
    outputPath?: string,
  ): Promise<string> {
    const filename = sanitizeFileName(attachment.filename, attachment.id || "attachment");
    if (!outputPath) {
      return join(this.config.dataDir, "attachments", encodeURIComponent(emailId), filename);
    }

    const resolved = resolve(outputPath);
    try {
      const existing = await stat(resolved);
      if (existing.isDirectory()) {
        const directoryTarget = join(resolved, filename);
        this.guardAttachmentOutputPath(directoryTarget);
        return directoryTarget;
      }
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code !== "ENOENT"
      ) {
        throw error;
      }
    }

    if (resolved.endsWith("/") || resolved.endsWith("\\")) {
      const directoryTarget = join(resolved, filename);
      this.guardAttachmentOutputPath(directoryTarget);
      return directoryTarget;
    }

    this.guardAttachmentOutputPath(resolved);
    return resolved;
  }

  // Saves a message's raw RFC822 source to disk as a .eml file — the migration/
  // backup counterpart to importEmail. Reuses the same PROTONMAIL_ALLOW_FILE_DOWNLOAD_DIR
  // guard as attachment saving, since this writes arbitrary caller-controlled paths.
  async exportEmail(emailId: string, outputPath?: string): Promise<{ emailId: string; outputPath: string }> {
    // Validate the output path (PROTONMAIL_ALLOW_FILE_DOWNLOAD_DIR, escape
    // guard) before the IMAP fetch, not after — no point spending a network
    // round-trip on a request that was always going to fail validation.
    const resolvedPath = await this.resolveAttachmentOutputPath(
      emailId,
      { filename: `${emailId.replace(/[/:]/g, "_")}.eml` },
      outputPath,
    );

    const { folder, uid } = parseEmailId(emailId);
    const source = await this.withMailbox(folder, true, async (client) => {
      const message = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
      if (!message || !message.source) {
        throw new Error(`Email not found for id ${emailId}`);
      }
      return message.source;
    });

    await mkdir(dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, source);

    return { emailId, outputPath: basename(resolvedPath) };
  }

  // Imports a raw RFC822 message (e.g. a .eml exported from another provider)
  // into a folder via IMAP APPEND — the migration/backup counterpart to
  // exportEmail. Mirrors upsertRemoteDraft's APPEND + APPENDUID-or-fallback
  // pattern.
  async importEmail(input: {
    raw: Buffer;
    targetFolder?: string;
    flags?: string[];
    internalDate?: Date;
  }): Promise<{ folder: string; uid?: number; emailId?: string }> {
    const folder = input.targetFolder?.trim() || (await this.resolveSpecialFolder("\\Inbox", ["INBOX"]));
    const client = await this.ensureConnected();
    const appended = await client.append(folder, input.raw, input.flags ?? [], input.internalDate ?? new Date());
    if (!appended) {
      throw new Error(`Server did not append the imported message into ${folder}`);
    }

    let uid = appended.uid;
    if (!uid) {
      const parsed = await this.parseSource(input.raw);
      const messageId = parsed.messageId;
      if (messageId) {
        uid = await this.findUidByHeader(folder, "message-id", messageId);
      }
    }

    this.folderCache = undefined;
    this.lastSyncAt = new Date().toISOString();

    return { folder, uid, emailId: uid ? createEmailId(folder, uid) : undefined };
  }
}
