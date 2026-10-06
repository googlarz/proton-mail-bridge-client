import { open, rename } from "node:fs/promises";
import { dirname } from "node:path";

// Replaces `path` with `data` so that a crash or power loss leaves either the old content or the new,
// never an empty or half-written file. Writing to a temp file and renaming is atomic with respect to other
// processes, but without flushing the data first the rename can reach the disk before the file's contents
// do, and after a power loss the renamed file is empty. So: write, fsync the file, rename, then fsync the
// directory so the rename itself is durable. The temp name (`<path>.tmp`) is the one the stores already
// clean up after a crash. The file is created owner-only: it holds private mail data.
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tempPath = `${path}.tmp`;
  const handle = await open(tempPath, "w", 0o600);
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, path);
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
