import { randomUUID } from "node:crypto";
import { copyFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProtonMailConfig, SnoozeRecord } from "../types/index.js";
import { isProcessAlive, withFileLock } from "../utils/file-lock.js";
import { parseEmailId } from "../utils/helpers.js";
import { logger, type Logger } from "../utils/logger.js";
import { SimpleIMAPService } from "./simple-imap-service.js";

// Same persistence pattern as DeliveryQueueService/DraftStoreService: atomic
// temp+rename writes, corrupted-file backup, orphaned .tmp cleanup, in-process
// lock. Same process-lifetime caveat as the delivery queue: wake only fires
// while this server stays running — see DeliveryQueueService's doc comment.
// "Folders/Snoozed" (without the MCP- prefix) is rejected by Proton's own
// API with "Invalid name" (Code=2011) — confirmed against a live account.
// Proton reserves that exact label name for its own native Snooze feature.
const SNOOZE_FOLDER = "Folders/MCP-Snoozed";
const CHECK_INTERVAL_MS = 15_000;
// After this many consecutive failed wake attempts (e.g. the email was moved
// or deleted before wakeAt so moveEmail can no longer find it), stop retrying
// every 15s forever and mark the snooze terminally "failed" instead.
const MAX_WAKE_FAILURES = 5;
const SNOOZE_WAKE_TIMEOUT_MS = 30_000;
// How long a terminal (woken/canceled/failed) record is kept before
// checkDue() prunes it — otherwise this JSON file grows without bound for
// the lifetime of the account, since nothing else ever removes a record.
const TERMINAL_RECORD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// How stale a "waking" record's claim must be before recoverInterruptedWakes
// will reclaim it even though its owner PID looks alive (or can't be
// determined) — guards against PID reuse: the original owner exited and,
// after enough time, the OS handed that same PID to an unrelated process
// (see file-lock.ts's isStale for the identical reasoning). Generous relative
// to SNOOZE_WAKE_TIMEOUT_MS, since a live owner should resolve "waking"
// within that bound.
const RECOVERY_STALE_MS = 5 * 60 * 1000;

interface SnoozeFile {
  version: number;
  items: Record<string, SnoozeRecord>;
}

function createEmptyStore(): SnoozeFile {
  return { version: 1, items: {} };
}

export class SnoozeService {
  private readonly storePath: string;
  private _lock: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private started = false;

  constructor(
    private readonly config: ProtonMailConfig,
    private readonly imapService: SimpleIMAPService,
    private readonly log: Logger = logger,
  ) {
    this.storePath = join(this.config.dataDir, "snoozed.json");
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // A record stuck in "waking" means the previous process died between
    // claiming it and recording the outcome — mirrors
    // DeliveryQueueService.recoverInterruptedSends(). Unlike a queued send,
    // retrying a move is safe (worst case: "not found" if it already moved),
    // so this reverts to "pending" for a normal retry on the next
    // checkDue() pass, rather than a terminal "failed".
    // Fire-and-forget, but guarded: an unhandled rejection here (e.g. a
    // file-lock acquisition timeout) would otherwise propagate to index.ts's
    // global handler and take down the whole server over one bad tick.
    void this.recoverInterruptedWakes()
      .then(() => this.checkDue())
      .catch((error) => this.log.error("Startup recovery/checkDue failed", "SnoozeService", error));
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
        .catch((error) => this.log.error("checkDue failed", "SnoozeService", error))
        .finally(() => this.scheduleNext());
    }, CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  async snooze(emailId: string, wakeAt: string): Promise<SnoozeRecord> {
    const { folder: originalFolder } = parseEmailId(emailId);
    await this.ensureSnoozeFolder();
    const moved = await this.imapService.moveEmail(emailId, SNOOZE_FOLDER);
    if (!moved.targetEmailId) {
      throw new Error(`Failed to move ${emailId} into the snooze folder.`);
    }

    const record: SnoozeRecord = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      wakeAt,
      status: "pending",
      originalFolder,
      currentEmailId: moved.targetEmailId,
    };
    await this.withLock(async () => {
      const store = await this.loadUnlocked();
      store.items[record.id] = record;
      await this.save(store);
    });
    return record;
  }

  // Wakes a snooze immediately (used by both cancel and the timer). Moves the
  // email back to its original folder and marks the record accordingly.
  //
  // Two-phase, mirroring DeliveryQueueService.checkDue()'s claim pattern:
  // claim under a brief lock (flip pending -> waking, so a second wake()
  // racing the same id — e.g. the 15s timer firing while a manual cancel is
  // in flight — sees "waking" and backs off instead of double-moving), do
  // the real network IMAP move OUTSIDE any lock, then re-lock briefly to
  // record the outcome. Doing the move *inside* the lock held the new
  // cross-process file lock (file-lock.ts) for a real network round trip —
  // long enough, under real degraded network conditions, to exceed its
  // stale-lock timeout and have the lock stolen mid-move by another
  // process, silently reintroducing the exact lost-update race that lock
  // exists to prevent.
  private async wake(id: string, status: "woken" | "canceled"): Promise<SnoozeRecord> {
    const claimed = await this.withLock(async () => {
      const store = await this.loadUnlocked();
      const record = store.items[id];
      if (!record) {
        throw new Error(`Snoozed email not found for id ${id}`);
      }
      if (record.status !== "pending") {
        return record;
      }
      record.status = "waking";
      // Tag the claim with this process's identity — see the ownerPid
      // comment on SnoozeRecord and recoverInterruptedWakes() below for why
      // a second process's startup recovery needs this to avoid stomping on
      // a still-live wake.
      record.ownerPid = process.pid;
      record.claimedAt = new Date().toISOString();
      await this.save(store);
      return record;
    });

    if (claimed.status !== "waking") {
      // Already resolved by another wake() call, or nothing to do.
      return claimed;
    }

    let moved: Awaited<ReturnType<SimpleIMAPService["moveEmail"]>>;
    try {
      // No bound here used to mean one wedged move (same shared IMAP
      // connection, same churn from the perpetual IDLE watcher) silently
      // stalled every other pending snooze indefinitely — checkDue() only
      // reschedules its next tick after the whole pass settles, so this
      // wake() call blocking the loop blocked every later due item too.
      moved = await this.imapService.withTimeout(
        this.imapService.moveEmail(claimed.currentEmailId, claimed.originalFolder),
        SNOOZE_WAKE_TIMEOUT_MS,
        `Timed out after ${SNOOZE_WAKE_TIMEOUT_MS}ms waking snooze ${id}`,
      );
    } catch (error) {
      // Revert the claim so checkDue()'s existing failure-counting catch
      // handler (which only updates a record still "pending") still finds
      // it there, and the item gets retried on the next checkDue() pass
      // instead of getting stuck in "waking" forever.
      await this.withLock(async () => {
        const store = await this.loadUnlocked();
        const record = store.items[id];
        if (record && record.status === "waking") {
          record.status = "pending";
          await this.save(store);
        }
      });
      throw error;
    }

    return this.withLock(async () => {
      const store = await this.loadUnlocked();
      const record = store.items[id];
      if (!record) {
        throw new Error(`Snoozed email not found for id ${id}`);
      }
      // Re-check the status fresh under this lock, mirroring
      // DeliveryQueueService.checkDue()'s finalize (only writes if the
      // record is still "sending"): a concurrent process's
      // recoverInterruptedWakes() may have already reverted this record to
      // "pending" (e.g. this process died between the claim above and here),
      // and a second wake() could already be in flight for it. Skip the
      // write rather than clobbering whatever that other path recorded.
      if (record.status !== "waking") {
        this.log.warn("Skipped duplicate snooze finalize — record no longer \"waking\"", "SnoozeService", { id, status: record.status });
        return record;
      }
      record.currentEmailId = moved.targetEmailId ?? record.currentEmailId;
      record.status = status;
      record.wokenAt = new Date().toISOString();
      await this.save(store);
      return record;
    });
  }

  async cancel(id: string): Promise<SnoozeRecord> {
    return this.wake(id, "canceled");
  }

  async get(id: string): Promise<SnoozeRecord> {
    const store = await this.load();
    const record = store.items[id];
    if (!record) {
      throw new Error(`Snoozed email not found for id ${id}`);
    }
    return record;
  }

  async list(): Promise<SnoozeRecord[]> {
    const store = await this.load();
    return Object.values(store.items).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async checkDue(): Promise<{ woken: number; failed: number }> {
    const now = Date.now();
    const due = (await this.list()).filter(
      (item) => item.status === "pending" && new Date(item.wakeAt).getTime() <= now,
    );

    let woken = 0;
    let failed = 0;
    for (const item of due) {
      try {
        await this.wake(item.id, "woken");
        woken += 1;
      } catch (error) {
        this.log.warn("Snooze wake failed", "SnoozeService", { id: item.id, error });
        await this.withLock(async () => {
          const store = await this.loadUnlocked();
          const record = store.items[item.id];
          if (record && record.status === "pending") {
            record.failureReason = error instanceof Error ? error.message : String(error);
            record.failureCount = (record.failureCount ?? 0) + 1;
            // Cap retries — e.g. the email was moved or deleted before
            // wakeAt, so moveEmail will never succeed. Without this, checkDue
            // would retry the same doomed wake every 15s forever.
            if (record.failureCount >= MAX_WAKE_FAILURES) {
              record.status = "failed";
            }
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

    return { woken, failed };
  }

  // Removes terminal (woken/canceled/failed) records past
  // TERMINAL_RECORD_RETENTION_MS so this JSON file doesn't grow without
  // bound over the account's lifetime. Mutates store.items in place; returns
  // whether anything was pruned.
  private pruneOldRecords(store: SnoozeFile): boolean {
    const cutoff = Date.now() - TERMINAL_RECORD_RETENTION_MS;
    let changed = false;
    for (const [id, record] of Object.entries(store.items)) {
      if (record.status !== "woken" && record.status !== "canceled" && record.status !== "failed") continue;
      // A terminally "failed" record (retry cap exceeded) has no dedicated
      // completion timestamp — fall back to createdAt, an earlier (more
      // conservative) bound anyway.
      const timestamp = record.wokenAt ?? record.createdAt;
      if (new Date(timestamp).getTime() < cutoff) {
        delete store.items[id];
        changed = true;
      }
    }
    return changed;
  }

  // A "waking" record does NOT necessarily mean the previous process died
  // mid-wake — this dataDir can be, and regularly is, shared by more than one
  // live server process (see withLock's comment), and that other process may
  // still be in the middle of a perfectly healthy wake right now. Blindly
  // reverting every "waking" record found here would let a second instance's
  // startup stomp on a first instance's live, in-flight wake. Instead, only
  // reclaim a record whose owning process is demonstrably gone — see
  // isAbandonedClaim below — mirroring file-lock.ts's PID-liveness check for
  // stale locks.
  private async recoverInterruptedWakes(): Promise<void> {
    await this.withLock(async () => {
      const store = await this.loadUnlocked();
      const now = Date.now();
      let changed = false;
      for (const record of Object.values(store.items)) {
        if (record.status !== "waking") continue;
        if (!this.isAbandonedClaim(record.ownerPid, record.claimedAt ?? record.createdAt, now)) continue;
        record.status = "pending";
        changed = true;
      }
      if (changed) await this.save(store);
    });
  }

  // Decides whether a "waking" claim belongs to a process that's actually
  // gone, rather than just "in a transient status" — the two used to be
  // treated as the same thing, which is the bug this exists to fix. Reuses
  // file-lock.ts's exact PID-liveness mechanism (process.kill(pid, 0)) rather
  // than reimplementing it.
  //
  // - ownerPid missing entirely (a record written before this field
  //   existed): there's no PID to check, so fall back to this module's
  //   original unconditional-recovery behavior rather than leave a genuinely
  //   crashed pre-fix record stuck in "waking" forever.
  // - ownerPid confirmed dead (ESRCH): abandoned, reclaim now regardless of
  //   age.
  // - ownerPid alive, or the liveness probe was inconclusive: a live owner
  //   is actively working this record, so leave it alone — UNLESS the claim
  //   is older than RECOVERY_STALE_MS, which is treated as abandoned anyway
  //   to guard against PID reuse (the original owner exited and the OS later
  //   handed that same PID to an unrelated process). A live owner's wake
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

  private async ensureSnoozeFolder(): Promise<void> {
    try {
      await this.imapService.createFolder(SNOOZE_FOLDER);
    } catch {
      // Idempotent by design elsewhere in this codebase (createFolder is
      // already safe to call when the folder exists); ignore failures here
      // since the subsequent moveEmail call will surface a real problem.
    }
  }

  // In-process chain (cheap, no I/O) still serializes calls within this
  // process; withFileLock additionally serializes against every OTHER
  // process sharing this dataDir — a real, everyday scenario, not just a
  // testing artifact: Claude Desktop can and does run more than one MCP
  // server instance against the same account (confirmed live: two server
  // processes, both children of one Claude.app, running concurrently).
  // Without this, two processes racing a load-modify-save cycle silently
  // lost one side's write — confirmed live via a snooze wake racing a
  // manual cancel on the same id.
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const locked = () => withFileLock(this.storePath, fn);
    const run = this._lock.then(locked, locked);
    this._lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async load(): Promise<SnoozeFile> {
    return this.withLock(() => this.loadUnlocked());
  }

  // Always reads from disk (no in-memory cache) — see the identical comment
  // in DeliveryQueueService.loadUnlocked for why.
  private async loadUnlocked(): Promise<SnoozeFile> {
    await this.cleanOrphanedTempFiles();

    try {
      const raw = await readFile(this.storePath, "utf8");
      const parsed = JSON.parse(raw) as SnoozeFile;
      return { ...createEmptyStore(), ...parsed };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
        return createEmptyStore();
      }

      const corruptPath = `${this.storePath}.corrupt`;
      try {
        copyFileSync(this.storePath, corruptPath);
        this.log.error(`Corrupted snoozed.json backed up to ${corruptPath} — recreating empty store`, "SnoozeService", error);
      } catch (backupError) {
        this.log.error("Failed to back up corrupted snoozed.json — recreating empty store without backup", "SnoozeService", { parseError: error, backupError });
      }

      return createEmptyStore();
    }
  }

  private async cleanOrphanedTempFiles(): Promise<void> {
    const dir = dirname(this.storePath);
    try {
      const entries = await readdir(dir);
      const tmpFiles = entries.filter((name) => name.startsWith("snoozed.json") && name.endsWith(".tmp"));
      await Promise.all(
        tmpFiles.map((name) =>
          unlink(join(dir, name)).catch((err) => {
            this.log.warn(`Failed to remove orphaned temp file: ${name}`, "SnoozeService", err);
          }),
        ),
      );
    } catch {
      // Directory may not exist yet — ignore.
    }
  }

  // ponytail: same cross-process race as DeliveryQueueService.save — see that
  // comment for why it's left unlocked and the real upgrade path (SQLite).
  private async save(store: SnoozeFile): Promise<void> {
    await mkdir(dirname(this.storePath), { recursive: true, mode: 0o700 });
    const tempPath = `${this.storePath}.tmp`;
    // Restrictive mode on the temp file itself, not just the final renamed
    // path — rename() preserves the mode it's given, but a mode passed only
    // after the fact wouldn't retroactively cover the temp file's brief
    // window on disk.
    await writeFile(tempPath, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, this.storePath);
  }
}
