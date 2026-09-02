import { randomUUID } from "node:crypto";
import { copyFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DeliveryQueueKind, DeliveryQueueRecord, ProtonMailConfig, SendEmailInput } from "../types/index.js";
import { ensureOutboundRecipientsAllowed, ensureSendAllowed } from "../utils/runtime-policy.js";
import { logger, type Logger } from "../utils/logger.js";
import { SMTPService } from "./smtp-service.js";

// Local, persistent send queue shared by undo-send (seconds-long hold) and
// scheduled-send (minutes/hours/days out). Mirrors DraftStoreService's
// persistence pattern: atomic temp+rename writes, corrupted-file backup
// instead of silent data loss, orphaned .tmp cleanup, in-process lock.
//
// IMPORTANT CAVEAT (see PR #8 / the exit-on-stdin-close fix): this is a
// stdio MCP server that exits as soon as its client disconnects. A queued
// item only fires while the server process is alive. If the app wasn't
// open at sendAt, the item fires on the NEXT server start (checkDue() runs
// once at startup to catch up) — not necessarily anywhere near the
// originally requested time. Every caller-facing surface (tool descriptions,
// enqueue's return value) must say so plainly; this is not a reliable
// scheduler, it's best-effort tied to the app being open.

interface DeliveryQueueFile {
  version: number;
  items: Record<string, DeliveryQueueRecord>;
}

function createEmptyStore(): DeliveryQueueFile {
  return { version: 1, items: {} };
}

const CHECK_INTERVAL_MS = 15_000;

export class DeliveryQueueService {
  private readonly queuePath: string;
  private _lock: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private started = false;

  constructor(
    private readonly config: ProtonMailConfig,
    private readonly smtpService: SMTPService,
    private readonly log: Logger = logger,
  ) {
    this.queuePath = join(this.config.dataDir, "delivery-queue.json");
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // A "sending" record left over from a process that died mid-send has an
    // unknown outcome — resolve those before the catch-up pass can touch
    // anything, so we never guess and double-send.
    await this.recoverInterruptedSends();
    // Catch-up pass immediately, then check periodically.
    void this.checkDue();
    this.scheduleNext();
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private scheduleNext(): void {
    if (!this.started) return;
    this.timer = setTimeout(() => {
      void this.checkDue().finally(() => this.scheduleNext());
    }, CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  async enqueue(
    payload: SendEmailInput,
    sendAt: string,
    kind: DeliveryQueueKind,
    sourceDraftId?: string,
  ): Promise<DeliveryQueueRecord> {
    const record: DeliveryQueueRecord = {
      id: randomUUID(),
      kind,
      createdAt: new Date().toISOString(),
      sendAt,
      status: "pending",
      payload,
      ...(sourceDraftId ? { sourceDraftId } : {}),
    };
    await this.withLock(async () => {
      const store = await this.loadUnlocked();
      store.items[record.id] = record;
      await this.save(store);
    });
    return record;
  }

  async cancel(id: string): Promise<{ id: string; canceled: boolean; status: string }> {
    return this.withLock(async () => {
      const store = await this.loadUnlocked();
      const record = store.items[id];
      if (!record) {
        throw new Error(`Queued send not found for id ${id}`);
      }
      if (record.status !== "pending") {
        return { id, canceled: false, status: record.status };
      }
      record.status = "canceled";
      await this.save(store);
      return { id, canceled: true, status: record.status };
    });
  }

  async get(id: string): Promise<DeliveryQueueRecord> {
    const store = await this.load();
    const record = store.items[id];
    if (!record) {
      throw new Error(`Queued send not found for id ${id}`);
    }
    return record;
  }

  async list(): Promise<DeliveryQueueRecord[]> {
    const store = await this.load();
    return Object.values(store.items).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  // Sends every pending item whose sendAt has passed. Safe to call repeatedly,
  // and safe to run concurrently with another checkDue() pass (e.g. an
  // overlapping catch-up + timer tick) or a cancel(): each item is first
  // *claimed* — flipped from "pending" to "sending" under the lock — and
  // only the caller that wins the claim proceeds to send it. cancel() and a
  // second checkDue() both see "sending" (not "pending") and leave it alone,
  // so a send already in flight can no longer be reported as canceled while
  // it actually goes out, and no item can be sent twice.
  async checkDue(): Promise<{ sent: number; failed: number }> {
    const now = Date.now();
    const dueIds = (await this.list())
      .filter((item) => item.status === "pending" && new Date(item.sendAt).getTime() <= now)
      .map((item) => item.id);

    let sent = 0;
    let failed = 0;
    for (const id of dueIds) {
      const claimed = await this.withLock(async () => {
        const store = await this.loadUnlocked();
        const record = store.items[id];
        if (!record || record.status !== "pending") return undefined;
        record.status = "sending";
        await this.save(store);
        return record;
      });
      if (!claimed) continue;

      try {
        // Runtime policy (allowSend/readOnly/restrictOutboundToSelf) is only
        // checked at enqueue time by the tool handler — re-check it here too,
        // since the server may have been restarted under different policy
        // (e.g. locked to read-only) since the item was queued.
        ensureSendAllowed(this.config.runtime);
        ensureOutboundRecipientsAllowed(
          this.config.runtime,
          this.config.smtp.username,
          [...claimed.payload.to, ...(claimed.payload.cc ?? []), ...(claimed.payload.bcc ?? [])],
        );

        const result = await this.smtpService.sendEmail(claimed.payload);
        await this.withLock(async () => {
          const store = await this.loadUnlocked();
          const record = store.items[id];
          if (record && record.status === "sending") {
            record.status = "sent";
            record.sentAt = new Date().toISOString();
            record.sentMessageId = result.messageId;
            await this.save(store);
          }
        });
        sent += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn("Delivery queue item failed to send", "DeliveryQueueService", { id, error });
        await this.withLock(async () => {
          const store = await this.loadUnlocked();
          const record = store.items[id];
          if (record && record.status === "sending") {
            record.status = "failed";
            record.failureReason = message;
            await this.save(store);
          }
        });
        failed += 1;
      }
    }
    return { sent, failed };
  }

  // Runs once at start(), before the catch-up checkDue() pass. A record
  // stuck in "sending" means the previous process died between claiming the
  // item and recording the outcome — whether the SMTP call actually
  // completed is unknown, so it is never auto-resent. It is marked "failed"
  // with a reason that says so explicitly, for the caller to verify by hand.
  private async recoverInterruptedSends(): Promise<void> {
    await this.withLock(async () => {
      const store = await this.loadUnlocked();
      let changed = false;
      for (const record of Object.values(store.items)) {
        if (record.status !== "sending") continue;
        record.status = "failed";
        record.failureReason = "Interrupted by a server restart while sending — delivery outcome is unknown. Not auto-resent; check the mailbox's Sent folder to confirm whether it actually went out before resending manually.";
        changed = true;
      }
      if (changed) await this.save(store);
    });
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this._lock.then(fn, fn);
    this._lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async load(): Promise<DeliveryQueueFile> {
    return this.withLock(() => this.loadUnlocked());
  }

  // Always reads from disk (no in-memory cache) so a second process sharing
  // this dataDir — e.g. a `proton-mail-bridge-client cancel-send` CLI
  // invocation running alongside a long-lived MCP server — is never invisible
  // to this instance and never gets its write silently clobbered by a stale
  // in-memory copy on the next save().
  private async loadUnlocked(): Promise<DeliveryQueueFile> {
    await this.cleanOrphanedTempFiles();

    try {
      const raw = await readFile(this.queuePath, "utf8");
      const parsed = JSON.parse(raw) as DeliveryQueueFile;
      return { ...createEmptyStore(), ...parsed };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
        return createEmptyStore();
      }

      const corruptPath = `${this.queuePath}.corrupt`;
      try {
        copyFileSync(this.queuePath, corruptPath);
        this.log.error(`Corrupted delivery-queue.json backed up to ${corruptPath} — recreating empty store`, "DeliveryQueueService", error);
      } catch (backupError) {
        this.log.error("Failed to back up corrupted delivery-queue.json — recreating empty store without backup", "DeliveryQueueService", { parseError: error, backupError });
      }

      return createEmptyStore();
    }
  }

  private async cleanOrphanedTempFiles(): Promise<void> {
    const dir = dirname(this.queuePath);
    try {
      const entries = await readdir(dir);
      const tmpFiles = entries.filter((name) => name.startsWith("delivery-queue.json") && name.endsWith(".tmp"));
      await Promise.all(
        tmpFiles.map((name) =>
          unlink(join(dir, name)).catch((err) => {
            this.log.warn(`Failed to remove orphaned temp file: ${name}`, "DeliveryQueueService", err);
          }),
        ),
      );
    } catch {
      // Directory may not exist yet — ignore.
    }
  }

  // ponytail: withLock only serializes calls within this process — two
  // separate processes sharing this dataDir (e.g. a CLI `cancel-send` racing
  // this server's own checkDue()) can still interleave load-modify-save and
  // lose one side's update. No OS-level lock (flock/lockfile) is taken. A
  // bespoke cross-process lockfile trades a rare millisecond-window lost
  // update for a worse failure mode (a crash mid-lock leaves a stale lockfile
  // that blocks every future send). Real upgrade path if this ever matters:
  // move this JSON store into the SQLite index already used elsewhere
  // (better-sqlite3), which has real cross-process locking for free.
  private async save(store: DeliveryQueueFile): Promise<void> {
    await mkdir(dirname(this.queuePath), { recursive: true });
    const tempPath = `${this.queuePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(store, null, 2), "utf8");
    await rename(tempPath, this.queuePath);
  }
}
