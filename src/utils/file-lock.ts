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

async function isStale(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs > STALE_LOCK_MS;
  } catch {
    // Already gone — not stale, just no longer contended.
    return false;
  }
}

async function acquire(lockPath: string): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;

  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      return;
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
          `Timed out after ${LOCK_ACQUIRE_TIMEOUT_MS}ms waiting for lock ${lockPath} (held by pid ${owner.trim()}). ` +
            "Another process is using the same data directory right now.",
        );
      }

      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

async function release(lockPath: string): Promise<void> {
  await unlink(lockPath).catch(() => undefined);
}

// Serializes `fn` against every other process (not just this one) also
// calling withFileLock on the same storePath. Always releases the lock even
// if `fn` throws.
export async function withFileLock<T>(storePath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = lockPathFor(storePath);
  await acquire(lockPath);
  try {
    return await fn();
  } finally {
    await release(lockPath);
  }
}
