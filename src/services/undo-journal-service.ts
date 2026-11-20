import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { isFileNotFound, setAsideCorruptStore } from "../utils/corrupt-store.js";
import { withFileLock } from "../utils/file-lock.js";
import { logger } from "../utils/logger.js";
import { readRegularFile } from "../utils/regular-file.js";

// What a bulk operation did, written down before it runs so undo_plan (with the undoId) can put it back: where each message
// was, which flags and labels it carried, and, once the operation finished, what actually happened to each one. Only changes
// that can be taken back are undoable; a permanent delete or a forward is recorded as such and never pretends otherwise.

export type UndoTool = "bulk_move" | "bulk_update_flags" | "bulk_delete" | "apply_rules";

export interface JournalItem {
  /** Id of the message before the operation: its folder, UID and the folder's UIDVALIDITY. */
  emailId: string;
  folder: string;
  /** The Message-ID header: finds the message again when a move gave it a new UID. */
  messageId?: string;
  flagsBefore?: string[];
  /** Set when the operation finished. Absent: the outcome is unknown (the server stopped during the run). */
  ok?: boolean;
  error?: string;
  movedTo?: { folder: string; emailId?: string };
  /** Flags the operation really set (they were not there before) and really cleared (they were there before). */
  flagsAdded?: string[];
  flagsRemoved?: string[];
  labelsAdded?: string[];
  /** What was done to this message and cannot be put back ("forwarded to x", "deleted for good"). */
  irreversible?: string[];
  undone?: boolean;
  undoError?: string;
}

export interface UndoJournal {
  id: string;
  tool: UndoTool;
  createdAt: string;
  /** pending: the operation was started, not finished. done: finished. undoing: an undo is running. undone: everything reversible was put back. */
  status: "pending" | "done" | "undoing" | "undone";
  undoStartedAt?: string;
  undoneAt?: string;
  /** Set when the whole operation cannot be undone (a permanent delete). */
  irreversible?: string;
  items: JournalItem[];
}

interface UndoState {
  journals: UndoJournal[];
}

export const DEFAULT_UNDO_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_UNDO_JOURNALS = 100;
// An undo that has been "running" this long was cut short (the process stopped): it may be claimed again.
const STALE_UNDO_MS = 5 * 60 * 1000;

/** Whether undo has something to put back for this item. */
export function isReversible(item: JournalItem): boolean {
  return item.ok === true && !item.undone && Boolean(item.movedTo || item.flagsAdded?.length || item.flagsRemoved?.length || item.labelsAdded?.length);
}

export class UndoJournalService {
  private readonly storePath: string;
  readonly ttlMs: number;

  constructor(options: { dataDir: string; ttlMs?: number }) {
    this.storePath = join(options.dataDir, "undo-journals.json");
    this.ttlMs = options.ttlMs ?? DEFAULT_UNDO_TTL_MS;
  }

  expiresAt(journal: UndoJournal): string {
    return new Date(Date.parse(journal.createdAt) + this.ttlMs).toISOString();
  }

  isExpired(journal: UndoJournal, now = Date.now()): boolean {
    return now > Date.parse(journal.createdAt) + this.ttlMs;
  }

  /** Stored before the operation runs. Expired journals are dropped, and the oldest beyond the cap. */
  async begin(tool: UndoTool, items: JournalItem[], irreversible?: string, now = new Date()): Promise<UndoJournal> {
    return this.withLock(async () => {
      const state = await this.load();
      const journal: UndoJournal = { id: `undo-${randomUUID().slice(0, 8)}`, tool, createdAt: now.toISOString(), status: "pending", items, ...(irreversible ? { irreversible } : {}) };
      const kept = state.journals.filter((entry) => !this.isExpired(entry, now.getTime()));
      state.journals = [...kept, journal].slice(-MAX_UNDO_JOURNALS);
      await this.save(state);
      return journal;
    });
  }

  async complete(id: string, items: JournalItem[]): Promise<UndoJournal> {
    return this.withLock(async () => {
      const state = await this.load();
      const journal = this.find(state, id);
      journal.items = items;
      journal.status = "done";
      await this.save(state);
      return journal;
    });
  }

  async get(id: string): Promise<UndoJournal | undefined> {
    return (await this.load()).journals.find((journal) => journal.id === id);
  }

  async list(): Promise<UndoJournal[]> {
    return (await this.load()).journals;
  }

  /** done (or a stale undoing) -> undoing, in one locked step: a retry of the same undo must not run it twice. */
  async beginUndo(id: string, now = new Date()): Promise<UndoJournal> {
    return this.withLock(async () => {
      const state = await this.load();
      const journal = state.journals.find((entry) => entry.id === id);
      if (!journal) throw new Error(`No undo journal ${id}. Journals are kept for ${Math.round(this.ttlMs / 86_400_000)} days.`);
      if (journal.irreversible) throw new Error(`${id} cannot be undone: ${journal.irreversible}.`);
      if (this.isExpired(journal, now.getTime())) throw new Error(`Undo journal ${id} expired at ${this.expiresAt(journal)}: undo data is kept for ${Math.round(this.ttlMs / 86_400_000)} days.`);
      if (journal.status === "pending") throw new Error(`${id} was never finished (the server stopped while the operation ran), so what it did is not known and it cannot be undone safely. Check the folders.`);
      if (journal.status === "undone") throw new Error(`${id} was already undone.`);
      if (journal.status === "undoing" && now.getTime() - Date.parse(journal.undoStartedAt ?? journal.createdAt) < STALE_UNDO_MS) throw new Error(`${id} is being undone right now.`);
      journal.status = "undoing";
      journal.undoStartedAt = now.toISOString();
      await this.save(state);
      return journal;
    });
  }

  async finishUndo(id: string, items: JournalItem[], now = new Date()): Promise<UndoJournal> {
    return this.withLock(async () => {
      const state = await this.load();
      const journal = this.find(state, id);
      journal.items = items;
      const allBack = !items.some(isReversible);
      journal.status = allBack ? "undone" : "done";
      if (allBack) journal.undoneAt = now.toISOString();
      await this.save(state);
      return journal;
    });
  }

  private find(state: UndoState, id: string): UndoJournal {
    const journal = state.journals.find((entry) => entry.id === id);
    if (!journal) throw new Error(`No undo journal ${id}.`);
    return journal;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.storePath), { recursive: true, mode: 0o700 });
    return withFileLock(this.storePath, fn);
  }

  private async load(): Promise<UndoState> {
    try {
      const parsed = JSON.parse(await readRegularFile(this.storePath)) as Partial<UndoState>;
      return { journals: Array.isArray(parsed.journals) ? parsed.journals : [] };
    } catch (error) {
      if (isFileNotFound(error)) return { journals: [] };
      setAsideCorruptStore(this.storePath, error, logger, "UndoJournalService");
      return { journals: [] };
    }
  }

  private async save(state: UndoState): Promise<void> {
    await writeFileAtomic(this.storePath, JSON.stringify(state, null, 2));
  }
}
