import { open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

// Replaces `path` with `data` so that a crash or power loss leaves either the old content or the new,
// never an empty or half-written file. Writing to a temp file and renaming is atomic with respect to other
// processes, but without flushing the data first the rename can reach the disk before the file's contents
// do, and after a power loss the renamed file is empty. So: write, fsync the file, rename, then fsync the
// directory so the rename itself is durable. The temp name (`<path>.tmp`) is the one the stores already
// clean up after a crash. The file is created owner-only: it holds private mail data.
//
// On Windows the rename can fail with EPERM/EACCES/EBUSY while another process (a second server on the same data
// directory, a virus scanner) briefly holds the target open; that passes in milliseconds, so it is retried a few times.
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_MS = 50;

async function renameWithRetry(renameFn: typeof rename, from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await renameFn(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const busy = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!busy || attempt >= RENAME_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_MS));
    }
  }
}

// `renameFn` is injectable for tests only.
export async function writeFileAtomic(path: string, data: string | Uint8Array, renameFn: typeof rename = rename): Promise<void> {
  const tempPath = `${path}.tmp`;
  const handle = await open(tempPath, "w", 0o600);
  try {
    await (typeof data === "string" ? handle.writeFile(data, "utf8") : handle.writeFile(data));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await renameWithRetry(renameFn, tempPath, path);
  } catch (error) {
    // e.g. a directory in the place of `path`: do not leave the temp file behind on every attempt.
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  await syncDirectory(dirname(path));
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directories cannot be opened or flushed on every platform (Windows): the file itself is already flushed.
  }
}
