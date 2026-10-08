import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProtonMailConfig } from "../types/index.js";
import { ensureAccountIdentityMatches } from "../utils/account-identity.js";
import { withFileLock } from "../utils/file-lock.js";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { isFileNotFound, setAsideCorruptStore } from "../utils/corrupt-store.js";
import { InvalidArgumentError } from "../utils/helpers.js";
import { logger, type Logger } from "../utils/logger.js";
import { ownRecord } from "../utils/own-record.js";

// "Tell me if nobody answers this by <date>": a reminder on a message you sent (or any message). It is only a note
// kept next to the account's other local stores; whether it has been answered is worked out when it is read, from the
// local index, so there is nothing to keep in step with the mailbox. Persistence mirrors TemplateService.

export interface ReplyReminderRecord {
  id: string;
  /** The message to be answered, as the account's own email id. */
  emailId: string;
  /** Its Message-ID header: replies are recognised by it. */
  messageId: string;
  subject: string;
  to: string[];
  createdAt: string;
  remindAt: string;
  note?: string;
  canceled?: boolean;
}

interface ReminderFile {
  version: number;
  items: Record<string, ReplyReminderRecord>;
}

const MAX_REMINDERS = 500;
const MAX_NOTE_LENGTH = 500;

function createEmptyStore(): ReminderFile {
  return { version: 1, items: {} };
}

export class ReplyReminderService {
  private readonly storePath: string;
  private _lock: Promise<void> = Promise.resolve();
  private identityChecked = false;

  constructor(
    private readonly config: ProtonMailConfig,
    private readonly log: Logger = logger,
  ) {
    this.storePath = join(this.config.dataDir, "reply-reminders.json");
  }

  /** Sets a reminder for the message, or moves the existing one for the same Message-ID to the new date. */
  async set(input: { emailId: string; messageId: string; subject: string; to: string[]; remindAt: Date; note?: string; now?: Date }): Promise<ReplyReminderRecord> {
    const now = input.now ?? new Date();
    if (Number.isNaN(input.remindAt.getTime()) || input.remindAt.getTime() <= now.getTime()) {
      throw new InvalidArgumentError("The reminder date must be in the future.");
    }
    const note = input.note?.trim() || undefined;
    if (note !== undefined && note.length > MAX_NOTE_LENGTH) {
      throw new InvalidArgumentError(`note must be at most ${MAX_NOTE_LENGTH} characters.`);
    }
    return this.withLock(async () => {
      const store = await this.loadUnlocked();
      const existing = Object.values(store.items).find((item) => item.messageId === input.messageId && !item.canceled);
      if (!existing && Object.values(store.items).filter((item) => !item.canceled).length >= MAX_REMINDERS) {
        throw new InvalidArgumentError(`There are already ${MAX_REMINDERS} open reminders; cancel some first.`);
      }
      const record: ReplyReminderRecord = {
        id: existing?.id ?? randomUUID(),
        emailId: input.emailId,
        messageId: input.messageId,
        subject: input.subject.slice(0, 300),
        to: input.to.slice(0, 50).map((address) => address.slice(0, 320)),
        createdAt: existing?.createdAt ?? now.toISOString(),
        remindAt: input.remindAt.toISOString(),
        note,
      };
      store.items[record.id] = record;
      await this.save(store);
      return record;
    });
  }

  async list(): Promise<ReplyReminderRecord[]> {
    const store = await this.withLock(() => this.loadUnlocked());
    return Object.values(store.items).filter((item) => !item.canceled).sort((left, right) => String(left.remindAt ?? "").localeCompare(String(right.remindAt ?? "")));
  }

  async cancel(id: string): Promise<{ id: string; canceled: boolean }> {
    return this.withLock(async () => {
      const store = await this.loadUnlocked();
      const record = ownRecord(store.items, id);
      if (!record || record.canceled) {
        return { id, canceled: false };
      }
      // Dropped rather than kept: a cancelled reminder has nothing left worth showing.
      delete store.items[id];
      await this.save(store);
      return { id, canceled: true };
    });
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const locked = () => withFileLock(this.storePath, fn);
    const run = this._lock.then(locked, locked);
    this._lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async loadUnlocked(): Promise<ReminderFile> {
    if (!this.identityChecked) {
      await ensureAccountIdentityMatches(this.config.dataDir, this.config.smtp.username);
      this.identityChecked = true;
    }
    await this.cleanOrphanedTempFiles();
    try {
      const raw = await readFile(this.storePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<ReminderFile>;
      return { ...createEmptyStore(), ...parsed, items: parsed.items && typeof parsed.items === "object" ? parsed.items : {} };
    } catch (error) {
      if (isFileNotFound(error)) {
        return createEmptyStore();
      }
      setAsideCorruptStore(this.storePath, error, this.log, "ReplyReminderService");
      return createEmptyStore();
    }
  }

  private async cleanOrphanedTempFiles(): Promise<void> {
    const dir = dirname(this.storePath);
    try {
      const entries = await readdir(dir);
      await Promise.all(
        entries
          .filter((name) => name.startsWith("reply-reminders.json") && name.endsWith(".tmp"))
          .map((name) => unlink(join(dir, name)).catch((err) => this.log.warn(`Failed to remove orphaned temp file: ${name}`, "ReplyReminderService", err))),
      );
    } catch {
      // The directory may not exist yet.
    }
  }

  private async save(store: ReminderFile): Promise<void> {
    await mkdir(dirname(this.storePath), { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.storePath, JSON.stringify(store, null, 2));
  }
}
