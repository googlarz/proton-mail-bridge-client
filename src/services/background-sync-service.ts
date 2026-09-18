import type { BackgroundSyncStatus, ProtonMailConfig } from "../types/index.js";
import { logger, type Logger } from "../utils/logger.js";
import { LocalIndexService } from "./local-index-service.js";
import { isLikelyAuthenticationError, SimpleIMAPService } from "./simple-imap-service.js";

const AUTH_BACKOFF_MIN_MS = 5 * 60_000;
const AUTH_BACKOFF_MAX_MS = 30 * 60_000;
const TRANSIENT_BACKOFF_MIN_MS = 15_000;
const TRANSIENT_BACKOFF_MAX_MS = 2 * 60_000;
// Minimum wall-clock time a change-free IDLE watch iteration must occupy. Acts
// as a hard floor so the idle loop can never busy-spin, independent of how the
// underlying IMAP client behaves.
const IDLE_ITERATION_FLOOR_MS = 1_000;

export class BackgroundSyncService {
  private readonly status: BackgroundSyncStatus;
  private timer?: NodeJS.Timeout;
  private activeRun?: Promise<void>;
  private idleLoop?: Promise<void>;
  private started = false;
  private authFailureCount = 0;
  private transientFailureCount = 0;

  constructor(
    private readonly config: ProtonMailConfig,
    private readonly imapService: SimpleIMAPService,
    private readonly localIndexService: LocalIndexService,
    private readonly log: Logger = logger,
  ) {
    this.status = {
      enabled: this.config.autoSync,
      running: false,
      intervalMinutes: this.config.syncInterval,
      folder: this.config.runtime.autoSyncFolder,
      full: this.config.runtime.autoSyncFull,
      limitPerFolder: this.config.runtime.autoSyncLimitPerFolder,
      startupSync: this.config.runtime.startupSync,
      idleEnabled: this.config.runtime.idleWatchEnabled,
      idleWatching: false,
      idleMaxSeconds: this.config.runtime.idleMaxSeconds,
    };
  }

  start(): void {
    if (this.started || !this.status.enabled) {
      return;
    }

    this.started = true;
    if (this.status.startupSync) {
      void this.runNow("startup");
      return;
    }

    this.startIdleLoop();
    this.scheduleNextRun();
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.status.nextRunAt = undefined;
    this.status.backoffUntil = undefined;
    this.status.idleWatching = false;
  }

  getStatus(): BackgroundSyncStatus {
    return { ...this.status };
  }

  async runNow(reason = "manual"): Promise<BackgroundSyncStatus> {
    if (!this.status.enabled) {
      return this.getStatus();
    }

    if (this.activeRun) {
      await this.activeRun;
      return this.getStatus();
    }

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.status.nextRunAt = undefined;

    this.activeRun = (async () => {
      const startedAt = new Date().toISOString();
      let failureKind: "auth" | "transient" | undefined;
      this.status.running = true;
      this.status.lastRunAt = startedAt;
      this.log.info("Starting background mailbox sync", "BackgroundSyncService", {
        reason,
        folder: this.status.folder,
        full: this.status.full,
        limitPerFolder: this.status.limitPerFolder,
      });

      try {
        const snapshot = await this.imapService.collectEmailsForIndex({
          folder: this.status.folder,
          full: this.status.full,
          limitPerFolder: this.status.limitPerFolder,
          checkpoints: await this.localIndexService.getSyncCheckpointMap(),
        });

        await this.localIndexService.recordSnapshot({
          folders: snapshot.folders,
          emails: snapshot.emails,
          syncedAt: snapshot.syncedAt,
          folderStats: snapshot.folderStats,
        });

        this.status.lastSuccessAt = snapshot.syncedAt;
        this.status.lastError = undefined;
        this.status.lastFailureKind = undefined;
        this.status.lastFailureMessage = undefined;
        // A successful sync attempt (this runNow) previously left a stale
        // lastIdleError visible forever after an earlier failed IDLE watch —
        // lastSuccessAt moved forward but lastIdleError never got cleared, since
        // only the IDLE loop itself (on its own next successful iteration) cleared
        // it. A caller reading run_doctor/get_runtime_status right after a
        // successful sync would see a real success alongside a leftover error that
        // no longer reflects current health.
        this.status.lastIdleError = undefined;
        this.authFailureCount = 0;
        this.transientFailureCount = 0;
      } catch (error) {
        failureKind = isLikelyAuthenticationError(error) ? "auth" : "transient";
        this.status.lastError = error instanceof Error ? error.message : String(error);
        this.status.lastFailureKind = failureKind;
        this.status.lastFailureMessage = this.status.lastError;
        this.log.error("Background mailbox sync failed", "BackgroundSyncService", {
          reason,
          failureKind,
          error,
        });
      } finally {
        this.status.running = false;
        this.activeRun = undefined;
        if (this.started) {
          if (!failureKind) {
            this.startIdleLoop();
            this.scheduleNextRun();
          } else {
            this.scheduleFailureRetry(failureKind);
          }
        }
      }
    })();

    await this.activeRun;
    return this.getStatus();
  }

  private scheduleNextRun(): void {
    if (!this.started || !this.status.enabled) {
      return;
    }

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const delayMs = Math.max(1, this.status.intervalMinutes) * 60_000;
    this.scheduleTimer(delayMs, "interval");
  }

  private scheduleFailureRetry(kind: "auth" | "transient"): void {
    const count = kind === "auth" ? ++this.authFailureCount : ++this.transientFailureCount;
    if (kind === "auth") {
      this.transientFailureCount = 0;
    } else {
      this.authFailureCount = 0;
    }

    const minDelay = kind === "auth" ? AUTH_BACKOFF_MIN_MS : TRANSIENT_BACKOFF_MIN_MS;
    const maxDelay = kind === "auth" ? AUTH_BACKOFF_MAX_MS : TRANSIENT_BACKOFF_MAX_MS;
    const delayMs = Math.min(maxDelay, minDelay * 2 ** Math.max(0, count - 1));
    this.status.backoffUntil = new Date(Date.now() + delayMs).toISOString();
    this.scheduleTimer(delayMs, `${kind}-retry`);
  }

  private scheduleTimer(delayMs: number, reason: string): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    const nextRunAt = new Date(Date.now() + delayMs).toISOString();
    this.status.nextRunAt = nextRunAt;
    this.timer = setTimeout(() => {
      void this.runNow(reason);
    }, delayMs);
    this.timer.unref?.();
  }

  // autoSyncFolder is a comma-separated list ("INBOX,Sent") for the periodic index
  // sync, but IMAP IDLE can only watch a single mailbox per connection — always
  // watch the first entry (INBOX by default) for live updates.
  private get primaryIdleFolder(): string | undefined {
    return this.status.folder?.split(",")[0]?.trim() || undefined;
  }

  private startIdleLoop(): void {
    if (this.idleLoop || !this.status.idleEnabled || !this.primaryIdleFolder) {
      return;
    }

    this.idleLoop = (async () => {
      let failCount = 0;
      while (this.started && this.status.enabled && this.status.idleEnabled && this.primaryIdleFolder) {
        this.status.idleWatching = true;
        const iterationStartedAt = Date.now();
        try {
          const result = await this.imapService.waitForMailboxChanges({
            folder: this.primaryIdleFolder,
            timeoutMs: this.status.idleMaxSeconds * 1000,
          });
          failCount = 0;
          this.status.lastIdleAt = result.checkedAt;
          this.status.lastIdleError = undefined;
          if (result.changed) {
            this.status.lastIdleChangeAt = result.checkedAt;
            this.status.lastIdleEventCount = result.events.length;
            await this.runNow("idle");
          } else {
            // Backstop against a busy spin: a change-free watch cycle should have
            // spent roughly idleMaxSeconds blocking in IDLE. If it returned far
            // sooner (a no-op idle(), a fast-failing reconnect, or any future
            // library regression), enforce a floor so this loop can never peg a
            // CPU core the way an orphaned process once did.
            await this.enforceIdleFloor(iterationStartedAt);
          }
        } catch (error) {
          this.status.lastIdleError = error instanceof Error ? error.message : String(error);
          const failureKind = isLikelyAuthenticationError(error) ? "auth" : "transient";
          this.log.warn("Mailbox IDLE watch failed", "BackgroundSyncService", {
            folder: this.primaryIdleFolder,
            failureKind,
            error,
          });
          if (failureKind === "auth") {
            this.status.lastFailureKind = "auth";
            this.status.lastError = this.status.lastIdleError;
            this.scheduleFailureRetry("auth");
            break;
          }
          const delayMs = Math.min(1000 * Math.pow(2, failCount), 300_000);
          failCount += 1;
          await this.waitForRetry(delayMs);
        }
      }
      this.status.idleWatching = false;
      this.idleLoop = undefined;
    })();
  }

  private async enforceIdleFloor(iterationStartedAt: number): Promise<void> {
    const elapsed = Date.now() - iterationStartedAt;
    const remaining = IDLE_ITERATION_FLOOR_MS - elapsed;
    if (remaining > 0) {
      await this.waitForRetry(remaining);
    }
  }

  private async waitForRetry(delayMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      timer.unref?.();
    });
  }
}
