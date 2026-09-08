import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { logger } from "./logger.js";

// Cross-process advisory lock for the JSON-backed stores (SnoozeService,
// DeliveryQueueService, DraftStoreService, TemplateService). Each of those
// already serializes access *within* one process via an in-process promise
// chain, but that provides zero protection against a second process sharing
// the same dataDir — and that's a real, everyday scenario here, not a
// contrived one: Claude Desktop can and does spawn more than one MCP server
// instance against the same account (confirmed live: two server processes,
// both children of one Claude.app, running concurrently). Without this, two
// processes racing a load-modify-save cycle silently lose one side's write —
// confirmed live via a snooze wake racing a manual cancel on the same id.
//
// Uses atomic exclusive-create (open with "wx", which fails with EEXIST if
// the file already exists) rather than a library — no new dependency for
// what's a well-understood, ~30-line primitive.

const LOCK_RETRY_MS = 50;
const LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
// A lock file older than this is assumed to belong to a process that died
// while holding it (crash, kill -9) rather than one still working — stolen
// instead of blocking forever. Generous relative to how briefly these
// load-modify-save cycles actually take.
const STALE_LOCK_MS = 30_000;

function lockPathFor(storePath: string): string {
  return `${storePath}.lock`;
}

// Liveness probe for the PID encoded in a lock file's token (see acquire()).
// process.kill(pid, 0) sends no signal — it just asks the OS whether it
// could — so this never touches the other process, it only inspects the
// error: ESRCH means no such process (dead), EPERM means it exists but we
// lack permission to signal it (still alive), anything else is inconclusive.
//
// Exported so DeliveryQueueService/SnoozeService's startup recovery can reuse
// this exact mechanism to decide whether a record's *owning process* (not
// just a lock file) is still alive — see the "ownerPid" handling in their
// recoverInterruptedSends()/recoverInterruptedWakes(). Same rationale as the
// stale-lock fix below: a transient status alone can't tell "owner crashed"
// apart from "owner still working", only a liveness check on the recorded
// PID can.
export function isProcessAlive(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: string }).code : undefined;
    if (code === "ESRCH") {
      return false;
    }
    if (code === "EPERM") {
      return true;
    }
    return undefined;
  }
}

async function isStale(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    const ageMs = Date.now() - info.mtimeMs;

    // Confirmed live: a lock file's own content encodes its holder's PID
    // (the "${pid}-${uuid}" token written in acquire()) — so before falling
    // back to pure age, ask the OS directly whether that PID still exists.
    // This closes a found-live gap: an ungraceful holder death (kill -9,
    // OOM kill, crash) leaves the lock file behind, and every other process
    // sharing the store would otherwise crash-loop against
    // LOCK_ACQUIRE_TIMEOUT_MS for up to STALE_LOCK_MS (30s) after every such
    // death, since age alone can't tell "dead holder" apart from "slow but
    // live holder". A dead PID means the lock is stealable immediately,
    // regardless of age.
    const content = await readFile(lockPath, "utf8").catch(() => undefined);
    const pidMatch = content?.match(/^(\d+)-/);
    if (pidMatch) {
      const pid = Number(pidMatch[1]);
      const alive = isProcessAlive(pid);
      if (alive === false) {
        return true;
      }
      // Alive, or the probe was inconclusive (unexpected error code) — be
      // conservative and fall through to the existing age-based check below
      // rather than assume anything about a PID we can't rule out.
    }
    // Malformed/legacy lock content (no parseable PID prefix) also falls
    // through here rather than throwing.

    return ageMs > STALE_LOCK_MS;
  } catch {
    // Already gone — not stale, just no longer contended.
    return false;
  }
}

// Returns a token unique to this acquisition — release() must present it
// back before unlinking, so a slow holder whose lock got stolen as stale
// can never delete the *new* owner's active lock out from under it (found
// on review: the previous version unlinked unconditionally, so a stolen
// lock's original holder finishing late would delete whoever stole it,
// letting a third caller acquire while the second still believed it held
// exclusivity — reintroducing the exact lost-update race this exists to
// prevent).
async function acquire(lockPath: string): Promise<string> {
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  const token = `${process.pid}-${randomUUID()}`;

  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(token);
      await handle.close();
      return token;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: string }).code : undefined;
      if (code !== "EEXIST") {
        throw error;
      }

      if (await isStale(lockPath)) {
        logger.warn(`Stale lock file detected, stealing it: ${lockPath}`, "FileLock");
        await unlink(lockPath).catch(() => undefined);
        continue;
      }

      if (Date.now() > deadline) {
        const owner = await readFile(lockPath, "utf8").catch(() => "unknown");
        throw new Error(
          `Timed out after ${LOCK_ACQUIRE_TIMEOUT_MS}ms waiting for lock ${lockPath} (held by ${owner.trim()}). ` +
            "Another process is using the same data directory right now.",
        );
      }

      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

async function release(lockPath: string, token: string): Promise<void> {
  const current = await readFile(lockPath, "utf8").catch(() => undefined);
  if (current !== undefined && current !== token) {
    // Stolen as stale by another process while we were still working —
    // that lock is now theirs. Deleting it here would let a third caller
    // acquire while they still believe they hold it.
    return;
  }
  await unlink(lockPath).catch(() => undefined);
}

// Serializes `fn` against every other process (not just this one) also
// calling withFileLock on the same storePath. Always releases the lock even
// if `fn` throws.
export async function withFileLock<T>(storePath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = lockPathFor(storePath);
  const token = await acquire(lockPath);
  try {
    return await fn();
  } finally {
    await release(lockPath, token);
  }
}
