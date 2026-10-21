import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EmailSummary, ProtonMailConfig } from "../types/index.js";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { isFileNotFound, setAsideCorruptStore } from "../utils/corrupt-store.js";
import { withFileLock } from "../utils/file-lock.js";
import { InvalidArgumentError } from "../utils/helpers.js";
import { logger, type Logger } from "../utils/logger.js";

// An automatic reply to incoming mail for one address, plus a note appended to what that address sends while the
// reply is active. It sends mail without anyone looking, so every default is the cautious one: off, only to a human
// sender who wrote to this address, once per sender for a number of days, never to a list or an automatic message,
// never for mail that arrived before it was switched on, and a cap per day. A reply is recorded before it is sent,
// so a crash cannot cause a second one.

export interface AutoresponderRule {
  enabled: boolean;
  /** Subject of the reply; {subject} is replaced by the subject of the message answered. */
  subject: string;
  body: string;
  /** Only mail that arrived inside this window is answered, and the outgoing note shows only inside it. */
  startsAt?: string;
  endsAt?: string;
  /** A sender gets at most one reply in this many days. */
  replyEveryDays: number;
  /** Appended to every mail sent from this address while the rule is active. */
  outgoingNote?: string;
  updatedAt: string;
  /** When the rule was last switched on; mail from before that moment is never answered. */
  activatedAt?: string;
}

interface AutoresponderState {
  version: number;
  rule?: AutoresponderRule;
  /** Last reply per sender address (lower case). */
  replies: Record<string, string>;
  /** Message-Ids already dealt with, newest last. */
  handled: string[];
  daily: { date: string; count: number };
  sentTotal: number;
}

export const AUTORESPONDER_MAX_PER_DAY = 50;
const HANDLED_LIMIT = 1000;
const DEFAULT_SUBJECT = "Automatic reply: {subject}";
const NO_REPLY_SENDER = /(^|[._+-])(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|mailer[-_.]?daemon|postmaster|bounces?|notifications?|alerts?|automated?|daemon)([._+-]|@)/i;

export type AutoresponderSkipReason =
  | "not-active"
  | "wrong-folder"
  | "before-activation"
  | "outside-window"
  | "not-human"
  | "no-sender"
  | "own-address"
  | "no-reply-sender"
  | "not-addressed-to-us"
  | "already-handled"
  | "replied-recently"
  | "daily-limit";

function emptyState(): AutoresponderState {
  return { version: 1, replies: {}, handled: [], daily: { date: "", count: 0 }, sentTotal: 0 };
}

function parseDate(value: string | undefined, name: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new InvalidArgumentError(`${name} must be a date, for example 2026-12-24 or 2026-12-24T18:00:00+01:00.`);
  return new Date(time).toISOString();
}

export function isActive(rule: AutoresponderRule | undefined, now: number): boolean {
  if (!rule?.enabled) return false;
  if (rule.startsAt && now < Date.parse(rule.startsAt)) return false;
  if (rule.endsAt && now > Date.parse(rule.endsAt)) return false;
  return true;
}

/** Why a message must not get a reply, or undefined when it may. Pure: nothing is recorded here. */
export function skipReason(
  email: EmailSummary,
  state: AutoresponderState,
  ownAddresses: string[],
  now: number,
): AutoresponderSkipReason | undefined {
  const rule = state.rule;
  if (!isActive(rule, now) || !rule) return "not-active";
  if (email.folder.toUpperCase() !== "INBOX") return "wrong-folder";
  const arrived = Date.parse(email.internalDate ?? email.date ?? "");
  if (rule.activatedAt && !(arrived >= Date.parse(rule.activatedAt))) return "before-activation";
  if (rule.startsAt && arrived < Date.parse(rule.startsAt)) return "outside-window";
  if (rule.endsAt && arrived > Date.parse(rule.endsAt)) return "outside-window";
  // Only a message positively known to be from a person: automatic and list mail, and mail whose headers were not
  // read, are left alone.
  if (email.isAutomated !== false) return "not-human";
  const sender = email.from[0]?.address?.trim().toLowerCase();
  if (!sender?.includes("@")) return "no-sender";
  const own = new Set(ownAddresses.map((address) => address.trim().toLowerCase()));
  if (own.has(sender)) return "own-address";
  if (NO_REPLY_SENDER.test(sender)) return "no-reply-sender";
  const direct = [...email.to, ...email.cc].some((entry) => entry.address && own.has(entry.address.trim().toLowerCase()));
  const delivered = email.deliveredTo ? own.has(email.deliveredTo.trim().toLowerCase()) : false;
  if (!direct && !delivered) return "not-addressed-to-us";
  if (email.messageId && state.handled.includes(email.messageId)) return "already-handled";
  const last = state.replies[sender];
  if (last && now - Date.parse(last) < rule.replyEveryDays * 24 * 60 * 60 * 1000) return "replied-recently";
  const today = new Date(now).toISOString().slice(0, 10);
  if (state.daily.date === today && state.daily.count >= AUTORESPONDER_MAX_PER_DAY) return "daily-limit";
  return undefined;
}

export function replySubject(rule: AutoresponderRule, original: string): string {
  const template = rule.subject || DEFAULT_SUBJECT;
  const subject = template.replace(/\{subject\}/g, original.replace(/^(re|aw|odp)\s*:\s*/i, "").trim() || "(no subject)");
  return subject.replace(/[\r\n]+/g, " ").slice(0, 200);
}

export interface AutoresponderReply {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references: string[];
  headers: Record<string, string>;
}

export class AutoresponderService {
  private readonly storePath: string;

  constructor(
    config: ProtonMailConfig,
    private readonly log: Logger = logger,
  ) {
    this.storePath = join(config.dataDir, "autoresponder.json");
    void this.refreshCache();
  }

  // A mail is built synchronously, so the rule the outgoing note comes from is kept in memory and re-read now and
  // then (another process, such as the CLI, may have changed the file).
  private cache?: { rule?: AutoresponderRule; loadedAt: number };

  private async refreshCache(): Promise<void> {
    try {
      this.cache = { rule: (await this.loadUnlocked()).rule, loadedAt: Date.now() };
    } catch {
      this.cache = { rule: undefined, loadedAt: Date.now() };
    }
  }

  /** The note for a mail built right now. Never waits for the disk; an out-of-date cache is refreshed for the next one. */
  outgoingNoteNow(now = Date.now()): string | undefined {
    if (!this.cache || now - this.cache.loadedAt > 30_000) void this.refreshCache();
    return isActive(this.cache?.rule, now) ? this.cache?.rule?.outgoingNote : undefined;
  }

  async get(): Promise<{ rule?: AutoresponderRule; active: boolean; sentTotal: number; repliedSenders: number; sentToday: number }> {
    const state = await this.load();
    const today = new Date().toISOString().slice(0, 10);
    return {
      rule: state.rule,
      active: isActive(state.rule, Date.now()),
      sentTotal: state.sentTotal,
      repliedSenders: Object.keys(state.replies).length,
      sentToday: state.daily.date === today ? state.daily.count : 0,
    };
  }

  /** Create or change the rule. Switching it on (from off) restarts "mail from before this moment is not answered". */
  async set(
    patch: {
      enabled?: boolean;
      subject?: string;
      body?: string;
      startsAt?: string;
      endsAt?: string;
      replyEveryDays?: number;
      outgoingNote?: string;
    },
    now = Date.now(),
  ): Promise<AutoresponderRule> {
    return this.withLock(async () => {
      const state = await this.loadUnlocked();
      const before = state.rule;
      const next: AutoresponderRule = {
        enabled: before?.enabled ?? false,
        subject: before?.subject ?? DEFAULT_SUBJECT,
        body: before?.body ?? "",
        startsAt: before?.startsAt,
        endsAt: before?.endsAt,
        replyEveryDays: before?.replyEveryDays ?? 7,
        outgoingNote: before?.outgoingNote,
        updatedAt: new Date(now).toISOString(),
        activatedAt: before?.activatedAt,
      };
      if (patch.enabled !== undefined) next.enabled = patch.enabled;
      if (patch.subject !== undefined) {
        if (patch.subject.length > 200) throw new InvalidArgumentError("subject is limited to 200 characters.");
        next.subject = patch.subject.trim() || DEFAULT_SUBJECT;
      }
      if (patch.body !== undefined) {
        if (patch.body.length > 4000) throw new InvalidArgumentError("body is limited to 4000 characters.");
        next.body = patch.body.trim();
      }
      if (patch.startsAt !== undefined) next.startsAt = parseDate(patch.startsAt, "startsAt");
      if (patch.endsAt !== undefined) next.endsAt = parseDate(patch.endsAt, "endsAt");
      if (patch.replyEveryDays !== undefined) {
        if (!Number.isInteger(patch.replyEveryDays) || patch.replyEveryDays < 1 || patch.replyEveryDays > 90) {
          throw new InvalidArgumentError("replyEveryDays must be a whole number from 1 to 90.");
        }
        next.replyEveryDays = patch.replyEveryDays;
      }
      if (patch.outgoingNote !== undefined) {
        if (patch.outgoingNote.length > 1000) throw new InvalidArgumentError("outgoingNote is limited to 1000 characters.");
        next.outgoingNote = patch.outgoingNote.trim() || undefined;
      }
      if (next.startsAt && next.endsAt && Date.parse(next.endsAt) <= Date.parse(next.startsAt)) {
        throw new InvalidArgumentError("endsAt must be after startsAt.");
      }
      if (next.enabled && !next.body && !next.outgoingNote) {
        throw new InvalidArgumentError("Give a body (the reply) or an outgoingNote before switching the autoresponder on.");
      }
      if (next.enabled && !before?.enabled) next.activatedAt = new Date(now).toISOString();
      state.rule = next;
      await this.save(state);
      this.cache = { rule: next, loadedAt: Date.now() };
      return next;
    });
  }

  /** The note to append to a mail sent now, or undefined when the rule is off or outside its window. */
  async outgoingNote(now = Date.now()): Promise<string | undefined> {
    const state = await this.load();
    return isActive(state.rule, now) ? state.rule?.outgoingNote : undefined;
  }

  /**
   * Answers what may be answered among `emails` by calling `send`. A reply is recorded before it is sent. Returns
   * what happened to each message, so the caller can log it; a failing send is reported and not retried.
   */
  async process(
    emails: EmailSummary[],
    ownAddresses: string[],
    send: (reply: AutoresponderReply) => Promise<void>,
    now = Date.now(),
  ): Promise<{ replied: string[]; skipped: Array<{ id: string; reason: AutoresponderSkipReason }>; failed: Array<{ id: string; error: string }> }> {
    const outcome = {
      replied: [] as string[],
      skipped: [] as Array<{ id: string; reason: AutoresponderSkipReason }>,
      failed: [] as Array<{ id: string; error: string }>,
    };
    // Oldest first, so the daily limit and "once per sender" favour the first message of a burst.
    const ordered = [...emails].sort((a, b) => Date.parse(a.internalDate ?? a.date ?? "") - Date.parse(b.internalDate ?? b.date ?? ""));
    for (const email of ordered) {
      const reply = await this.withLock(async () => {
        const state = await this.loadUnlocked();
        const reason = skipReason(email, state, ownAddresses, now);
        if (reason) {
          // Not-active and similar are the common case on every sync; only the interesting ones are worth returning.
          if (reason !== "not-active" && reason !== "wrong-folder" && reason !== "before-activation" && reason !== "already-handled") {
            outcome.skipped.push({ id: email.id, reason });
          }
          return undefined;
        }
        const rule = state.rule as AutoresponderRule;
        const sender = (email.from[0]?.address ?? "").trim().toLowerCase();
        const today = new Date(now).toISOString().slice(0, 10);
        state.replies[sender] = new Date(now).toISOString();
        if (email.messageId) {
          state.handled.push(email.messageId);
          if (state.handled.length > HANDLED_LIMIT) state.handled.splice(0, state.handled.length - HANDLED_LIMIT);
        }
        state.daily = { date: today, count: (state.daily.date === today ? state.daily.count : 0) + 1 };
        state.sentTotal += 1;
        await this.save(state);
        return {
          to: sender,
          subject: replySubject(rule, email.subject),
          body: rule.body || "",
          inReplyTo: email.messageId,
          references: [...(email.references ?? []), ...(email.messageId ? [email.messageId] : [])],
          headers: { "Auto-Submitted": "auto-replied", Precedence: "bulk", "X-Auto-Response-Suppress": "All" },
        } satisfies AutoresponderReply;
      });
      if (!reply) continue;
      if (!reply.body) {
        outcome.skipped.push({ id: email.id, reason: "not-active" });
        continue;
      }
      try {
        await send(reply);
        outcome.replied.push(email.id);
      } catch (error) {
        outcome.failed.push({ id: email.id, error: error instanceof Error ? error.message : String(error) });
        this.log.warn("Autoresponder reply could not be sent", "AutoresponderService", { id: email.id, error });
      }
    }
    return outcome;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.storePath), { recursive: true, mode: 0o700 });
    return withFileLock(this.storePath, fn);
  }

  private async load(): Promise<AutoresponderState> {
    return this.loadUnlocked();
  }

  private async loadUnlocked(): Promise<AutoresponderState> {
    try {
      const parsed = JSON.parse(await readFile(this.storePath, "utf8")) as Partial<AutoresponderState>;
      return {
        ...emptyState(),
        ...parsed,
        replies: parsed.replies && typeof parsed.replies === "object" ? parsed.replies : {},
        handled: Array.isArray(parsed.handled) ? parsed.handled.filter((entry): entry is string => typeof entry === "string") : [],
        daily: parsed.daily && typeof parsed.daily.date === "string" ? parsed.daily : { date: "", count: 0 },
      };
    } catch (error) {
      if (isFileNotFound(error)) return emptyState();
      setAsideCorruptStore(this.storePath, error, this.log, "AutoresponderService");
      return emptyState();
    }
  }

  private async save(state: AutoresponderState): Promise<void> {
    await writeFileAtomic(this.storePath, JSON.stringify(state, null, 2));
  }
}
