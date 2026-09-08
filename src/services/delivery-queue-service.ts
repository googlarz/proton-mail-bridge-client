import { randomUUID } from "node:crypto";
import { copyFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DeliveryQueueKind, DeliveryQueueRecord, ProtonMailConfig, SendEmailInput } from "../types/index.js";
import { isProcessAlive, withFileLock } from "../utils/file-lock.js";
import { ensureOutboundRecipientsAllowed, ensureSendAllowed } from "../utils/runtime-policy.js";
import { logger, type Logger } from "../utils/logger.js";
import { withTimeout } from "../utils/helpers.js";
import { SMTPService } from "./smtp-service.js";

const SEND_ITEM_TIMEOUT_MS = 30_000;
// How long a terminal (sent/failed) record is kept before checkDue() prunes
// it — otherwise this JSON file grows without bound for the lifetime of the
// account, since nothing else ever removes a record.
const TERMINAL_RECORD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// How stale a "sending" record's claim must be before recoverInterruptedSends
// will reclaim it even though its owner PID looks alive (or can't be
// determined) — guards against PID reuse: the original owner exited and,
// after enough time, the OS handed that same PID to an unrelated process
// (see file-lock.ts's isStale for the identical reasoning). Generous relative
// to SEND_ITEM_TIMEOUT_MS, since a live owner should resolve "sending" within
// that bound.
const RECOVERY_STALE_MS = 5 * 60 * 1000;

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
    // Catch-up pass immediately, then check periodically. Fire-and-forget,
    // but guarded: an unhandled rejection here (e.g. a file-lock acquisition
    // timeout) would otherwise propagate to index.ts's global handler and
    // take down the whole server over one bad tick.
    void this.checkDue().catch((error) => this.log.error("checkDue failed", "DeliveryQueueService", error));
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
      // .catch() before .finally() so a rejection (e.g. a lock-acquire
      // timeout) is swallowed here — logged, not left to become an unhandled
      // rejection — while .finally() still always re-arms the next tick.
      void this.checkDue()
        .catch((error) => this.log.error("checkDue failed", "DeliveryQueueService", error))
        .finally(() => this.scheduleNext());
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
        // Tag the claim with this process's identity — see the ownerPid
        // comment on DeliveryQueueRecord and recoverInterruptedSends() below
        // for why a second process's startup recovery needs this to avoid
        // stomping on a still-live send.
        record.ownerPid = process.pid;
        record.claimedAt = new Date().toISOString();
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

        // No bound here used to mean one wedged send (e.g. a stalled SMTP
        // socket to Bridge) silently stalled every other queued/scheduled
        // item indefinitely: checkDue() only reschedules its next tick
        // (scheduleNext()) after the whole pass settles, and this loop
        // wouldn't even reach later dueIds until the current send resolved.
        const result = await withTimeout(
          this.smtpService.sendEmail(claimed.payload),
          SEND_ITEM_TIMEOUT_MS,
          `Timed out after ${SEND_ITEM_TIMEOUT_MS}ms sending queued item ${id}`,
        );
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
        const rawMessage = error instanceof Error ? error.message : String(error);
        // withTimeout() races the send against a timer — it can't actually
        // cancel sendMail() (SMTP over a network socket has no cancellation
        // hook), so the real send keeps running in the background after the
        // race "loses" and may still complete successfully moments later.
        // A bare timeout message here reads as a definite failure, but the
        // true outcome is exactly as unknown as recoverInterruptedSends'
        // restart-recovery case (see its comment) — say so explicitly
        // instead of implying delivery didn't happen.
        const message = rawMessage.startsWith("Timed out after")
          ? `${rawMessage} — delivery outcome is unknown, the send may still complete in the background. Check the mailbox's Sent folder to confirm before resending.`
          : rawMessage;
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

    // Prune once per tick, after processing — not on every read-only list()
    // call — and only write if something actually changed.
    await this.withLock(async () => {
      const store = await this.loadUnlocked();
      if (this.pruneOldRecords(store)) await this.save(store);
    });

    return { sent, failed };
  }

  // Removes terminal (sent/failed) records past TERMINAL_RECORD_RETENTION_MS
  // so this JSON file doesn't grow without bound over the account's lifetime.
  // Mutates store.items in place; returns whether anything was pruned.
  private pruneOldRecords(store: DeliveryQueueFile): boolean {
    const cutoff = Date.now() - TERMINAL_RECORD_RETENTION_MS;
    let changed = false;
    for (const [id, record] of Object.entries(store.items)) {
      if (record.status !== "sent" && record.status !== "failed") continue;
      // "failed" records have no dedicated completion timestamp — fall back
      // to createdAt, which is an earlier (more conservative) bound anyway.
      const timestamp = record.status === "sent" ? record.sentAt ?? record.createdAt : record.createdAt;
      if (new Date(timestamp).getTime() < cutoff) {
        delete store.items[id];
        changed = true;
      }
    }
    return changed;
  }

  // Runs once at start(), before the catch-up checkDue() pass. A "sending"
  // record does NOT necessarily mean the previous process died mid-send —
  // this dataDir can be, and regularly is, shared by more than one live
  // server process (see withLock's comment), and that other process may
  // still be in the middle of a perfectly healthy send right now. Blindly
  // "recovering" every "sending" record found here would let a second
  // instance's startup stomp on a first instance's live, in-flight send.
  // Instead, only reclaim a record whose owning process is demonstrably gone
  // — see isAbandonedClaim below — mirroring file-lock.ts's PID-liveness
  // check for stale locks. Only then is the outcome truly unknown, so it is
  // never auto-resent; it's marked "failed" with a reason that says so
  // explicitly, for the caller to verify by hand.
  private async recoverInterruptedSends(): Promise<void> {
    await this.withLock(async () => {
      const store = await this.loadUnlocked();
      const now = Date.now();
      let changed = false;
      for (const record of Object.values(store.items)) {
        if (record.status !== "sending") continue;
        if (!this.isAbandonedClaim(record.ownerPid, record.claimedAt ?? record.createdAt, now)) continue;
        record.status = "failed";
        record.failureReason = "Interrupted by a server restart while sending — delivery outcome is unknown. Not auto-resent; check the mailbox's Sent folder to confirm whether it actually went out before resending manually.";
        changed = true;
      }
      if (changed) await this.save(store);
    });
  }

  // Decides whether a "sending" claim belongs to a process that's actually
  // gone, rather than just "in a transient status" — the two used to be
  // treated as the same thing, which is the bug this exists to fix. Reuses
  // file-lock.ts's exact PID-liveness mechanism (process.kill(pid, 0)) rather
  // than reimplementing it.
  //
  // - ownerPid missing entirely (a record written before this field
  //   existed): there's no PID to check, so fall back to this module's
  //   original unconditional-recovery behavior rather than leave a genuinely
  //   crashed pre-fix record stuck in "sending" forever.
  // - ownerPid confirmed dead (ESRCH): abandoned, reclaim now regardless of
  //   age.
  // - ownerPid alive, or the liveness probe was inconclusive: a live owner
  //   is actively working this record, so leave it alone — UNLESS the claim
  //   is older than RECOVERY_STALE_MS, which is treated as abandoned anyway
  //   to guard against PID reuse (the original owner exited and the OS later
  //   handed that same PID to an unrelated process). A live owner's send
  //   should resolve well within that window.
  private isAbandonedClaim(ownerPid: number | undefined, referenceTimestamp: string, now: number): boolean {
    if (ownerPid === undefined) {
      return true;
    }
    if (isProcessAlive(ownerPid) === false) {
      return true;
    }
    const ageMs = now - new Date(referenceTimestamp).getTime();
    return ageMs > RECOVERY_STALE_MS;
  }

  // In-process chain (cheap, no I/O) still serializes calls within this
  // process; withFileLock additionally serializes against every OTHER
  // process sharing this dataDir — see file-lock.ts for why that's a real,
  // everyday scenario here, not just a testing artifact.
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const locked = () => withFileLock(this.queuePath, fn);
    const run = this._lock.then(locked, locked);
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
    await mkdir(dirname(this.queuePath), { recursive: true, mode: 0o700 });
    const tempPath = `${this.queuePath}.tmp`;
    // Restrictive mode on the temp file itself, not just the final renamed
    // path — rename() preserves the mode it's given, but a mode passed only
    // after the fact wouldn't retroactively cover the temp file's brief
    // window on disk.
    await writeFile(tempPath, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, this.queuePath);
  }
}
