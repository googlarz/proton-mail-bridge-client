import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { isFileNotFound, setAsideCorruptStore } from "../utils/corrupt-store.js";
import { withFileLock } from "../utils/file-lock.js";
import { InvalidArgumentError } from "../utils/helpers.js";
import { logger } from "../utils/logger.js";

// What was promised, by you or to you: a small local ledger. An entry is open until it is closed; whether the thread
// moved on since is worked out from the index each time the list is read (see the tool), not stored here.

export type CommitmentDirection = "mine" | "theirs";
export type CommitmentStatus = "open" | "done" | "dismissed";

export interface Commitment {
  id: string;
  direction: CommitmentDirection;
  text: string;
  /** YYYY-MM-DD */
  due?: string;
  /** The other party's address. */
  with?: string;
  /** The message the promise was made in (own email id) and its Message-ID header, to follow the thread. */
  emailId?: string;
  messageId?: string;
  createdAt: string;
  status: CommitmentStatus;
  closedAt?: string;
}

interface CommitmentFile {
  items: Commitment[];
}

const MAX_ITEMS = 2000;

export class CommitmentService {
  private readonly storePath: string;

  constructor(options: { dataDir: string }) {
    this.storePath = join(options.dataDir, "commitments.json");
  }

  async add(input: { direction: CommitmentDirection; text: string; due?: string; with?: string; emailId?: string; messageId?: string }, now = new Date()): Promise<Commitment> {
    const text = input.text.replace(/\s+/g, " ").trim();
    if (!text) throw new InvalidArgumentError("A commitment needs text.");
    if (input.direction !== "mine" && input.direction !== "theirs") throw new InvalidArgumentError('direction must be "mine" or "theirs".');
    if (input.due !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.due)) throw new InvalidArgumentError("due must be a date like 2026-11-05.");
    return this.withLock(async () => {
      const state = await this.load();
      const duplicate = state.items.find((item) => item.status === "open" && item.messageId && item.messageId === input.messageId && item.text === text.slice(0, 300));
      if (duplicate) return duplicate;
      const item: Commitment = {
        id: `c-${randomUUID().slice(0, 8)}`,
        direction: input.direction,
        text: text.slice(0, 300),
        ...(input.due ? { due: input.due } : {}),
        ...(input.with ? { with: input.with.toLowerCase().slice(0, 320) } : {}),
        ...(input.emailId ? { emailId: input.emailId } : {}),
        ...(input.messageId ? { messageId: input.messageId } : {}),
        createdAt: now.toISOString(),
        status: "open",
      };
      state.items = [...state.items, item].slice(-MAX_ITEMS);
      await this.save(state);
      return item;
    });
  }

  async close(id: string, status: "done" | "dismissed", now = new Date()): Promise<Commitment | undefined> {
    return this.withLock(async () => {
      const state = await this.load();
      const item = state.items.find((candidate) => candidate.id === id);
      if (!item) return undefined;
      item.status = status;
      item.closedAt = now.toISOString();
      await this.save(state);
      return item;
    });
  }

  async list(): Promise<Commitment[]> {
    return (await this.load()).items;
  }

  /** Message-IDs already turned into commitments, so a scan does not offer them again. */
  async knownMessageIds(): Promise<Set<string>> {
    return new Set((await this.load()).items.flatMap((item) => (item.messageId ? [item.messageId] : [])));
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.storePath), { recursive: true, mode: 0o700 });
    return withFileLock(this.storePath, fn);
  }

  private async load(): Promise<CommitmentFile> {
    try {
      const parsed = JSON.parse(await readFile(this.storePath, "utf8")) as Partial<CommitmentFile>;
      return { items: Array.isArray(parsed.items) ? parsed.items : [] };
    } catch (error) {
      if (isFileNotFound(error)) return { items: [] };
      setAsideCorruptStore(this.storePath, error, logger, "CommitmentService");
      return { items: [] };
    }
  }

  private async save(state: CommitmentFile): Promise<void> {
    await writeFileAtomic(this.storePath, JSON.stringify(state, null, 2));
  }
}
