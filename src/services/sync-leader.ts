import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger, type Logger } from "../utils/logger.js";

// Every MCP client starts its own server process, and each one used to run the background sync and the IDLE watch
// against the same data directory: five clients meant five sync loops and five sets of Bridge connections on one
// index. One instance per data directory now holds this lease and does the background work; the others serve
// tools from the index and take over when the holder exits or stops refreshing the lease. Any problem with the
// lock file itself lets the instance work as if it held the lease (the old behaviour), so the lock can only help.

const LEASE_STALE_MS = 2 * 60_000;
const HEARTBEAT_MS = 30_000;

interface LeaseFile {
  token: string;
  pid: number;
  heartbeatAt: number;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class SyncLeader {
  private readonly path: string;
  private readonly token = randomUUID();
  private holding = false;
  private heartbeat?: NodeJS.Timeout;

  constructor(
    private readonly dataDir: string,
    private readonly log: Logger = logger,
  ) {
    this.path = join(dataDir, "background-sync.lock");
  }

  get isHolder(): boolean {
    return this.holding;
  }

  /** True when this instance holds the lease (taking it if it is free or stale). Safe to call often. */
  tryAcquire(): boolean {
    try {
      if (this.holding && this.readLease()?.token === this.token) {
        this.writeLease();
        return true;
      }
      this.holding = false;
      mkdirSync(this.dataDir, { recursive: true });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          writeFileSync(this.path, JSON.stringify(this.lease()), { flag: "wx", mode: 0o600 });
          return this.becomeHolder();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        const current = this.readLease();
        if (current?.token === this.token) return this.becomeHolder();
        const stale = !current || Date.now() - current.heartbeatAt > LEASE_STALE_MS || !processIsAlive(current.pid);
        if (!stale) return false;
        try {
          unlinkSync(this.path);
        } catch {
          // another instance removed it first; the next attempt sorts out who wins
        }
      }
      return false;
    } catch (error) {
      this.log.warn("Background sync lock unavailable; running without it", "SyncLeader", { error });
      return true;
    }
  }

  release(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    if (!this.holding) return;
    this.holding = false;
    try {
      if (this.readLease()?.token === this.token) unlinkSync(this.path);
    } catch {
      // best effort: a leftover file goes stale and is taken over
    }
  }

  private becomeHolder(): boolean {
    this.holding = true;
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        try {
          if (this.readLease()?.token === this.token) this.writeLease();
          else this.holding = false;
        } catch {
          // keep going; staleness handles a lock that cannot be refreshed
        }
      }, HEARTBEAT_MS);
      this.heartbeat.unref?.();
    }
    return true;
  }

  private lease(): LeaseFile {
    return { token: this.token, pid: process.pid, heartbeatAt: Date.now() };
  }

  private writeLease(): void {
    writeFileSync(this.path, JSON.stringify(this.lease()), { mode: 0o600 });
  }

  private readLease(): LeaseFile | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<LeaseFile>;
      if (typeof parsed.token === "string" && typeof parsed.pid === "number" && typeof parsed.heartbeatAt === "number") {
        return parsed as LeaseFile;
      }
    } catch {
      // missing or half-written: treated as no lease
    }
    return undefined;
  }
}
