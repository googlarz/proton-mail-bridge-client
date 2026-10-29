import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { readRegularFile } from "../utils/regular-file.js";
import { join } from "node:path";
import type { ProtonMailConfig } from "../types/index.js";
import { ensureAccountIdentityMatches } from "../utils/account-identity.js";
import { withFileLock } from "../utils/file-lock.js";
import { isFileNotFound } from "../utils/corrupt-store.js";
import { logger, type Logger } from "../utils/logger.js";

// What happened on an account while nobody was asking: new mail, a snooze that woke, a reply that came due, a scheduled
// send that went out or failed, a rule or autoresponder that acted, a plan that was applied. An append-only JSONL file
// per account, shared by every server process on the data directory (appends and reads go through the same file lock
// as the other stores). It holds no message bodies: a type, a time, an id, and the sender address and subject cut
// short and stripped of anything invisible or that could end the line.

export const EVENT_TYPES = [
  "mail.new",
  "mail.new_overflow",
  "snooze.woke",
  "snooze.failed",
  "reply_reminder.due",
  "send.sent",
  "send.failed",
  "rule.acted",
  "autoresponder.replied",
  "autoresponder.drafted",
  "autoresponder.failed",
  "plan.applied",
  "plan.undone",
  "delegation.used",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface NewEvent {
  type: EventType;
  /** The message the event is about, as the account's own email id. */
  emailId?: string;
  /** Sender address (mail-derived). */
  from?: string;
  /** Subject (mail-derived). */
  subject?: string;
  /** The snooze, queued send, reminder, rule or plan the event is about. */
  refId?: string;
  /** A few words of non-mail context: what a rule did, why a send failed. */
  detail?: string;
  /** An event with the same key already in the log is not added again. */
  key?: string;
}

export interface StoredEvent {
  /** Position in this account's log: increases by one per event and never goes back, also across restarts and rotations. */
  seq: number;
  at: string;
  type: EventType;
  emailId?: string;
  from?: string;
  subject?: string;
  refId?: string;
  detail?: string;
  /** Set when `from`, `subject` or `detail` may carry text somebody else wrote (a message, an SMTP server's answer). */
  untrusted?: true;
  key?: string;
}

export type EventSink = (event: NewEvent) => void;

const MAX_EVENTS_PER_FILE = 1000;
const MAX_BYTES_PER_FILE = 512 * 1024;
const SUBJECT_MAX = 160;
const ADDRESS_MAX = 254;
const ID_MAX = 300;
const DETAIL_MAX = 300;
const HOUR_MS = 60 * 60 * 1000;
// A sender, or a burst of spam, must not be able to fill the log: mail.new is limited per hour (the excess is counted in
// one mail.new_overflow event), and the newest events of the types that matter are kept through rotation whatever else arrives.
const MAIL_NEW_PER_SENDER_PER_HOUR = 50;
const MAIL_NEW_PER_HOUR = 200;
const OVERFLOW_PER_HOUR = 20;
const KEEP_PER_IMPORTANT_TYPE = 200;
const IMPORTANT_TYPES: ReadonlySet<string> = new Set<EventType>([
  "send.sent",
  "send.failed",
  "delegation.used",
  "plan.applied",
  "plan.undone",
  "rule.acted",
  "reply_reminder.due",
  "snooze.woke",
  "snooze.failed",
]);

const BREAKS = /[\t\n\r\u000b\u000c\u0085\u2028\u2029]/g;
// Controls, soft hyphen, bidi marks and overrides/isolates, zero-width and word-joiner characters, the BOM, the interlinear anchors.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;

/** Text from a message made safe to keep on one line and show: no control, invisible or direction-changing character, one space between words, cut at `max` characters. */
export function cleanEventText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(BREAKS, " ").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  const characters = Array.from(cleaned);
  return characters.length > max ? `${characters.slice(0, max - 1).join("")}…` : cleaned;
}

function parseEvents(text: string): StoredEvent[] {
  const events: StoredEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<StoredEvent>;
      if (parsed && typeof parsed === "object" && Number.isSafeInteger(parsed.seq) && typeof parsed.type === "string" && typeof parsed.at === "string") events.push(parsed as StoredEvent);
    } catch {
      // A line cut short by a crash: skipped.
    }
  }
  return events;
}

/** The events of `older` that stay when it is dropped: those still among the newest KEEP_PER_IMPORTANT_TYPE of their type once `newer` is counted. */
function importantToKeep(older: StoredEvent[], newer: StoredEvent[]): StoredEvent[] {
  const counts = new Map<string, number>();
  for (const event of newer) if (IMPORTANT_TYPES.has(event.type)) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  const kept: StoredEvent[] = [];
  for (let index = older.length - 1; index >= 0; index--) {
    const event = older[index];
    const count = counts.get(event.type) ?? 0;
    if (!IMPORTANT_TYPES.has(event.type) || count >= KEEP_PER_IMPORTANT_TYPE) continue;
    counts.set(event.type, count + 1);
    kept.push(event);
  }
  return kept.reverse();
}

export class EventLogService {
  private readonly path: string;
  private readonly rotatedPath: string;
  private _lock: Promise<void> = Promise.resolve();
  private chain: Promise<void> = Promise.resolve();
  private pending: NewEvent[] = [];
  private identityChecked = false;
  private readonly listeners = new Set<(events: StoredEvent[]) => void>();

  constructor(
    private readonly config: Pick<ProtonMailConfig, "dataDir"> & { smtp: { username: string } },
    private readonly log: Logger = logger,
  ) {
    this.path = join(config.dataDir, "events.jsonl");
    this.rotatedPath = join(config.dataDir, "events.1.jsonl");
  }

  /** Where the current file is, for a caller that wants to see whether another process has appended. */
  get filePath(): string {
    return this.path;
  }

  /** Called with each batch that was appended by this process. Returns the function that removes the listener. */
  onAppend(listener: (events: StoredEvent[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** What the services call: never throws and never waits. Events emitted in the same tick are appended together. */
  emit(event: NewEvent): void {
    this.pending.push(event);
    this.chain = this.chain.then(() => this.flushPending()).catch(() => undefined);
  }

  /** Resolves once everything emitted so far is in the file. */
  async flush(): Promise<void> {
    await this.chain;
  }

  private async flushPending(): Promise<void> {
    const batch = this.pending;
    this.pending = [];
    if (batch.length === 0) return;
    try {
      await this.append(batch);
    } catch (error) {
      this.log.warn("Could not record events", "EventLogService", { count: batch.length, error });
    }
  }

  async append(events: NewEvent[], now = new Date()): Promise<StoredEvent[]> {
    return this.withLock(async () => {
      let current = await this.readText(this.path);
      const existing = parseEvents(current);
      const rotating = existing.length >= MAX_EVENTS_PER_FILE || Buffer.byteLength(current) >= MAX_BYTES_PER_FILE;
      // The file before is read only when it can matter: for the last seq of a log that has just rotated, for keys, for the mail.new quota and for rotating.
      const rotated = rotating || existing.length === 0 || events.some((event) => event.key || event.type === "mail.new") ? parseEvents(await this.readText(this.rotatedPath)) : [];
      let lastSeq = existing.at(-1)?.seq ?? rotated.at(-1)?.seq ?? Date.now() - 1;
      const seen = new Set([...rotated, ...existing].map((event) => event.key).filter((key): key is string => Boolean(key)));

      const windowStart = now.getTime() - HOUR_MS;
      let mailThisHour = 0;
      let overflowThisHour = 0;
      const perSender = new Map<string, number>();
      for (const event of [...rotated, ...existing]) {
        if (!(Date.parse(event.at) > windowStart)) continue;
        if (event.type === "mail.new") {
          mailThisHour++;
          perSender.set(event.from ?? "", (perSender.get(event.from ?? "") ?? 0) + 1);
        } else if (event.type === "mail.new_overflow") {
          overflowThisHour++;
        }
      }
      let dropped = 0;

      const stored: StoredEvent[] = [];
      for (const event of events) {
        if (event.key && seen.has(event.key)) continue;
        const from = cleanEventText(event.from, ADDRESS_MAX)?.toLowerCase();
        if (event.type === "mail.new") {
          if (mailThisHour >= MAIL_NEW_PER_HOUR || (perSender.get(from ?? "") ?? 0) >= MAIL_NEW_PER_SENDER_PER_HOUR) {
            dropped++;
            continue;
          }
          mailThisHour++;
          perSender.set(from ?? "", (perSender.get(from ?? "") ?? 0) + 1);
        } else if (event.type === "mail.new_overflow") {
          overflowThisHour++;
        }
        const subject = cleanEventText(event.subject, SUBJECT_MAX);
        const detail = event.detail ? cleanEventText(event.detail, DETAIL_MAX) : undefined;
        const entry: StoredEvent = {
          seq: ++lastSeq,
          at: now.toISOString(),
          type: event.type,
          ...(event.emailId ? { emailId: cleanEventText(event.emailId, ID_MAX) } : {}),
          ...(from ? { from } : {}),
          ...(subject ? { subject } : {}),
          ...(event.refId ? { refId: cleanEventText(event.refId, ID_MAX) } : {}),
          ...(detail ? { detail } : {}),
          // The overflow note is the one detail nobody else wrote.
          ...(from || subject || (detail && event.type !== "mail.new_overflow") ? { untrusted: true as const } : {}),
          ...(event.key ? { key: cleanEventText(event.key, ID_MAX) } : {}),
        };
        if (event.key) seen.add(event.key);
        stored.push(entry);
      }
      if (dropped > 0 && overflowThisHour < OVERFLOW_PER_HOUR) {
        stored.push({ seq: ++lastSeq, at: now.toISOString(), type: "mail.new_overflow", detail: `${dropped} more new messages not listed (too many in an hour)` });
      }
      if (stored.length === 0) return [];

      await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
      if (rotating) {
        // The newest events are always in the current file or the one before it; the oldest generation is dropped,
        // except for the newest events of the important types, which move on with the current file.
        const keep = importantToKeep(rotated, existing);
        if (keep.length === 0) {
          await rename(this.path, this.rotatedPath);
        } else {
          const temporary = `${this.rotatedPath}.tmp`;
          await writeFile(temporary, [...keep, ...existing].map((event) => `${JSON.stringify(event)}\n`).join(""), { encoding: "utf8", mode: 0o600 });
          await rename(temporary, this.rotatedPath);
          await rm(this.path, { force: true });
        }
        current = "";
      }
      const handle = await open(this.path, "a", 0o600);
      try {
        // A file that does not end in a newline was cut short by a crash: the next event must not join its last line.
        await handle.writeFile(`${current && !current.endsWith("\n") ? "\n" : ""}${stored.map((entry) => `${JSON.stringify(entry)}\n`).join("")}`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      for (const listener of this.listeners) {
        try {
          listener(stored);
        } catch (error) {
          this.log.warn("An event listener failed", "EventLogService", error);
        }
      }
      return stored;
    });
  }

  /** Every retained event, oldest first (the rotated file, then the current one). */
  async readAll(): Promise<StoredEvent[]> {
    return this.withLock(async () => {
      const older = parseEvents(await this.readText(this.rotatedPath));
      const current = parseEvents(await this.readText(this.path));
      // A crash while rotating can leave the current events in both files for a moment.
      const newest = new Set(current.map((event) => event.seq));
      return [...older.filter((event) => !newest.has(event.seq)), ...current];
    });
  }

  private async readText(path: string): Promise<string> {
    try {
      return await readRegularFile(path);
    } catch (error) {
      if (isFileNotFound(error)) return "";
      throw error;
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const locked = async () => {
      if (!this.identityChecked) {
        await ensureAccountIdentityMatches(this.config.dataDir, this.config.smtp.username);
        this.identityChecked = true;
      }
      await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
      return withFileLock(this.path, fn);
    };
    const run = this._lock.then(locked, locked);
    this._lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
