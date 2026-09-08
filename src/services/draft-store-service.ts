import { randomUUID } from "node:crypto";
import { copyFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  DraftMode,
  DraftRecord,
  RemoteDraftRef,
  DraftSendResult,
  ProtonMailConfig,
} from "../types/index.js";
import { withFileLock } from "../utils/file-lock.js";
import { extractDomain } from "../utils/helpers.js";
import { logger, type Logger } from "../utils/logger.js";

interface DraftStoreFile {
  version: number;
  updatedAt?: string;
  drafts: Record<string, DraftRecord>;
}

// A "sent" draft is a completed historical record, same as a terminal
// delivery-queue/snooze entry — it has no more state transitions ahead of it,
// so keeping it forever only grows drafts.json (every draft operation does a
// full JSON.parse/JSON.stringify of the whole file, so that growth is a real
// cost, not just disk). Active "draft" records are never pruned, regardless
// of age — only ones already marked sent, and only once they're old enough
// that nobody is realistically still looking them up.
const SENT_DRAFT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function createEmptyStore(): DraftStoreFile {
  return {
    version: 1,
    updatedAt: undefined,
    drafts: {},
  };
}

export class DraftStoreService {
  private readonly draftPath: string;
  private _lock: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: ProtonMailConfig,
    private readonly log: Logger = logger,
  ) {
    this.draftPath = join(this.config.dataDir, "drafts.json");
  }

  async listDrafts(includeSent = false): Promise<DraftRecord[]> {
    const store = await this.load();
    return Object.values(store.drafts)
      // A draft stuck in "sending" (e.g. the process crashed between
      // claimForSending() and markSent()) is not a completed record like
      // "sent" — it still needs a human to notice and resolve it, so it's
      // treated as active here rather than being hidden from the default
      // (non-includeSent) listing.
      .filter((draft) => includeSent || draft.status !== "sent")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getDraft(id: string): Promise<DraftRecord> {
    const store = await this.load();
    const draft = store.drafts[id];
    if (!draft) {
      throw new Error(`Draft not found for id ${id}`);
    }
    return draft;
  }

  async createDraft(input: {
    mode?: DraftMode;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    body: string;
    isHtml?: boolean;
    priority?: "high" | "normal" | "low";
    replyTo?: string;
    inReplyTo?: string;
    references?: string[];
    attachments?: DraftRecord["attachments"];
    sourceEmailId?: string;
    sourceMessageId?: string;
    notes?: string;
  }): Promise<DraftRecord> {
    return this.withLock(async () => {
      const store = await this.loadUnlocked();
      const now = new Date().toISOString();
      const draft: DraftRecord = {
        id: randomUUID(),
        status: "draft",
        mode: input.mode ?? "compose",
        createdAt: now,
        updatedAt: now,
        to: [...(input.to ?? [])],
        cc: [...(input.cc ?? [])],
        bcc: [...(input.bcc ?? [])],
        subject: input.subject,
        body: input.body,
        isHtml: Boolean(input.isHtml),
        priority: input.priority,
        replyTo: input.replyTo,
        inReplyTo: input.inReplyTo,
        references: input.references ? [...input.references] : undefined,
        draftMessageId: this.createDraftMessageId(),
        attachments: [...(input.attachments ?? [])],
        sourceEmailId: input.sourceEmailId,
        sourceMessageId: input.sourceMessageId,
        notes: input.notes,
        remoteSyncState: "local_only",
      };

      store.updatedAt = now;
      store.drafts[draft.id] = draft;
      await this.save(store);
      return draft;
    });
  }

  async updateDraft(
    id: string,
    patch: {
      to?: string[];
      cc?: string[];
      bcc?: string[];
      subject?: string;
      body?: string;
      isHtml?: boolean;
      priority?: "high" | "normal" | "low";
      replyTo?: string;
      inReplyTo?: string;
      references?: string[];
      attachments?: DraftRecord["attachments"];
      notes?: string;
    },
  ): Promise<DraftRecord> {
    return this.withLock(async () => {
      const store = await this.loadUnlocked();
      const existing = store.drafts[id];
      if (!existing) {
        throw new Error(`Draft not found for id ${id}`);
      }

      const updatedAt = new Date().toISOString();
      const nextDraft: DraftRecord = {
        ...existing,
        updatedAt,
        to: patch.to ? [...patch.to] : existing.to,
        cc: patch.cc ? [...patch.cc] : existing.cc,
        bcc: patch.bcc ? [...patch.bcc] : existing.bcc,
        subject: patch.subject ?? existing.subject,
        body: patch.body ?? existing.body,
        isHtml: typeof patch.isHtml === "boolean" ? patch.isHtml : existing.isHtml,
        priority: patch.priority ?? existing.priority,
        replyTo: patch.replyTo ?? existing.replyTo,
        inReplyTo: patch.inReplyTo ?? existing.inReplyTo,
        references: patch.references ? [...patch.references] : existing.references,
        attachments: patch.attachments ? [...patch.attachments] : existing.attachments,
        notes: patch.notes ?? existing.notes,
      };

      store.updatedAt = updatedAt;
      store.drafts[id] = nextDraft;
      await this.save(store);
      return nextDraft;
    });
  }

  async markSent(id: string, result: DraftSendResult): Promise<DraftRecord> {
    return this.withLock(async () => {
      const store = await this.loadUnlocked();
      const existing = store.drafts[id];
      if (!existing) {
        throw new Error(`Draft not found for id ${id}`);
      }

      const sentAt = new Date().toISOString();
      const nextDraft: DraftRecord = {
        ...existing,
        status: "sent",
        sentAt,
        updatedAt: sentAt,
        lastSendResult: result,
      };

      store.updatedAt = sentAt;
      store.drafts[id] = nextDraft;
      await this.save(store);
      return nextDraft;
    });
  }

  // Atomically claims a draft for sending: only succeeds when the draft is
  // still "draft", flipping it to "sending" under the same lock that reads
  // it. Found live: two concurrent send_draft calls for the same draft id
  // both read status "draft", both passed the old plain-getDraft check, and
  // both called SMTP — a genuine duplicate send. Routing the read+write
  // through withLock closes that window: whichever call wins the claim sees
  // "draft" and flips it, and every other caller — a second concurrent
  // send_draft, an already-completed send, or a scheduled send that already
  // fired via DeliveryQueueService.checkDue() — sees a non-"draft" status
  // and is rejected before ever reaching SMTP.
  async claimForSending(id: string): Promise<DraftRecord> {
    return this.withLock(async () => {
      const store = await this.loadUnlocked();
      const existing = store.drafts[id];
      if (!existing) {
        throw new Error(`Draft not found for id ${id}`);
      }
      if (existing.status !== "draft") {
        throw new Error(`Draft ${id} is not sendable (status: ${existing.status})`);
      }

      const updatedAt = new Date().toISOString();
      const nextDraft: DraftRecord = {
        ...existing,
        status: "sending",
        updatedAt,
      };

      store.updatedAt = updatedAt;
      store.drafts[id] = nextDraft;
      await this.save(store);
      return nextDraft;
    });
  }

  // Reverts a failed send's claim back to "draft" so the draft can be
  // retried, mirroring SnoozeService.wake()'s catch handler reverting
  // "waking" back to "pending" on a failed moveEmail. Only writes if the
  // record is still "sending" — if something else already moved it on
  // (e.g. a concurrent finalize), this must not clobber that outcome.
  async revertSending(id: string): Promise<void> {
    await this.withLock(async () => {
      const store = await this.loadUnlocked();
      const existing = store.drafts[id];
      if (!existing || existing.status !== "sending") {
        return;
      }

      const updatedAt = new Date().toISOString();
      store.drafts[id] = { ...existing, status: "draft", updatedAt };
      store.updatedAt = updatedAt;
      await this.save(store);
    });
  }

  async markRemoteSynced(id: string, remoteDraft: RemoteDraftRef): Promise<DraftRecord> {
    return this.withLock(async () => {
      const store = await this.loadUnlocked();
      const existing = store.drafts[id];
      if (!existing) {
        throw new Error(`Draft not found for id ${id}`);
      }

      const updatedAt = new Date().toISOString();
      const nextDraft: DraftRecord = {
        ...existing,
        updatedAt,
        remoteSyncState: "synced",
        remoteSyncError: undefined,
        remoteDraft,
      };

      store.updatedAt = updatedAt;
      store.drafts[id] = nextDraft;
      await this.save(store);
      return nextDraft;
    });
  }

  async markRemoteSyncError(id: string, message: string): Promise<DraftRecord> {
    return this.withLock(async () => {
      const store = await this.loadUnlocked();
      const existing = store.drafts[id];
      if (!existing) {
        throw new Error(`Draft not found for id ${id}`);
      }

      const updatedAt = new Date().toISOString();
      const nextDraft: DraftRecord = {
        ...existing,
        updatedAt,
        remoteSyncState: "sync_failed",
        remoteSyncError: message,
      };

      store.updatedAt = updatedAt;
      store.drafts[id] = nextDraft;
      await this.save(store);
      return nextDraft;
    });
  }

  async clearRemoteSync(id: string): Promise<DraftRecord> {
    return this.withLock(async () => {
      const store = await this.loadUnlocked();
      const existing = store.drafts[id];
      if (!existing) {
        throw new Error(`Draft not found for id ${id}`);
      }

      const updatedAt = new Date().toISOString();
      const nextDraft: DraftRecord = {
        ...existing,
        updatedAt,
        remoteSyncState: "local_only",
        remoteSyncError: undefined,
        remoteDraft: undefined,
      };

      store.updatedAt = updatedAt;
      store.drafts[id] = nextDraft;
      await this.save(store);
      return nextDraft;
    });
  }

  async deleteDraft(id: string): Promise<{ id: string; removed: boolean }> {
    return this.withLock(async () => {
      const store = await this.loadUnlocked();
      if (!store.drafts[id]) {
        return { id, removed: false };
      }

      delete store.drafts[id];
      store.updatedAt = new Date().toISOString();
      await this.save(store);
      return { id, removed: true };
    });
  }

  async clear(): Promise<{ path: string; removed: boolean }> {
    return this.withLock(async () => {
      try {
        await rm(this.draftPath);
        return { path: this.draftPath, removed: true };
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error as { code?: string }).code === "ENOENT"
        ) {
          return { path: this.draftPath, removed: false };
        }
        this.log.warn("Failed to clear draft store", "DraftStoreService", error);
        throw error;
      }
    });
  }

  // In-process chain (cheap, no I/O) still serializes calls within this
  // process; withFileLock additionally serializes against every OTHER
  // process sharing this dataDir — see file-lock.ts for why that's a real,
  // everyday scenario here, not just a testing artifact. This closes GAP-16
  // (below), which used to warn that concurrent server instances weren't
  // supported at all.
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const locked = () => withFileLock(this.draftPath, fn);
    const run = this._lock.then(locked, locked);
    this._lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async load(): Promise<DraftStoreFile> {
    return this.withLock(() => this.loadUnlocked());
  }

  // Always reads from disk (no in-memory cache) — same reasoning as
  // DeliveryQueueService.loadUnlocked: a second process sharing this
  // dataDir must never be invisible to this instance, and its write must
  // never be silently clobbered by a stale in-memory copy on the next save().
  private async loadUnlocked(): Promise<DraftStoreFile> {
    // GAP-09: Clean up orphaned .tmp files left by a previous crashed write.
    await this.cleanOrphanedTempFiles();

    try {
      const raw = await readFile(this.draftPath, "utf8");
      const parsed = JSON.parse(raw) as DraftStoreFile;
      const drafts = Object.fromEntries(
        Object.entries(parsed.drafts ?? {}).map(([id, draft]) => [id, this.normalizeDraft(draft)]),
      );
      return {
        ...createEmptyStore(),
        ...parsed,
        drafts,
      };
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code === "ENOENT"
      ) {
        return createEmptyStore();
      }

      // GAP-09: JSON parse failure means the file is corrupted. Back it up so the
      // user can attempt manual recovery, then recreate an empty store.
      const corruptPath = `${this.draftPath}.corrupt`;
      try {
        copyFileSync(this.draftPath, corruptPath);
        this.log.error(
          `Corrupted drafts.json backed up to ${corruptPath} — recreating empty store`,
          "DraftStoreService",
          error,
        );
      } catch (backupError) {
        this.log.error(
          "Failed to back up corrupted drafts.json — recreating empty store without backup",
          "DraftStoreService",
          { parseError: error, backupError },
        );
      }

      return createEmptyStore();
    }
  }

  private async cleanOrphanedTempFiles(): Promise<void> {
    const dir = dirname(this.draftPath);
    try {
      const entries = await readdir(dir);
      // Every sibling store (delivery-queue/snooze/template) scopes this to
      // its own filename — this one didn't, so it deleted *any* .tmp file in
      // the shared dataDir. cleanOrphanedTempFiles runs on nearly every draft
      // operation (loadUnlocked), so a draft read/write racing another
      // store's in-flight atomic save (e.g. TemplateService's
      // templates.json.tmp mid-write-before-rename) could delete that other
      // store's temp file out from under it, making its rename() throw ENOENT
      // and silently lose whatever it was saving.
      const tmpFiles = entries.filter((name) => name.startsWith("drafts.json") && name.endsWith(".tmp"));
      await Promise.all(
        tmpFiles.map((name) =>
          unlink(join(dir, name)).catch((err) => {
            this.log.warn(`Failed to remove orphaned temp file: ${name}`, "DraftStoreService", err);
          }),
        ),
      );
    } catch {
      // Directory may not exist yet — ignore.
    }
  }

  private async save(store: DraftStoreFile): Promise<void> {
    this.pruneSentDrafts(store);
    await mkdir(dirname(this.draftPath), { recursive: true, mode: 0o700 });
    const tempPath = `${this.draftPath}.tmp`;
    await writeFile(tempPath, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, this.draftPath);
  }

  // Pruning here (a write-path helper called opportunistically from save())
  // rather than in load()/loadUnlocked() means read-only listDrafts() calls
  // never rewrite the file — only an operation that was already going to
  // write pays the pruning cost.
  private pruneSentDrafts(store: DraftStoreFile): void {
    const cutoff = Date.now() - SENT_DRAFT_RETENTION_MS;
    for (const [id, draft] of Object.entries(store.drafts)) {
      if (draft.status !== "sent") {
        continue;
      }
      // Falls back to createdAt when sentAt is missing, mirroring
      // delivery-queue-service.ts/snooze-service.ts's own pruning — every
      // current "sent" draft always has sentAt (set in the same object
      // literal as the status change), so this path isn't reachable today,
      // but a future migration/import producing a "sent" draft without it
      // would otherwise never be pruned, silently reintroducing the
      // unbounded growth this method exists to prevent.
      const referenceTime = draft.sentAt ?? draft.createdAt;
      const referenceMs = Date.parse(referenceTime);
      if (!Number.isNaN(referenceMs) && referenceMs < cutoff) {
        delete store.drafts[id];
      }
    }
  }

  private normalizeDraft(draft: DraftRecord): DraftRecord {
    return {
      ...draft,
      draftMessageId: draft.draftMessageId || this.createDraftMessageId(),
      remoteSyncState: draft.remoteSyncState || "local_only",
      attachments: [...(draft.attachments ?? [])],
      cc: [...(draft.cc ?? [])],
      bcc: [...(draft.bcc ?? [])],
      to: [...(draft.to ?? [])],
    };
  }

  private createDraftMessageId(): string {
    const domain = extractDomain(this.config.smtp.username) || "localhost";
    return `<draft-${randomUUID()}@${domain}>`;
  }
}
