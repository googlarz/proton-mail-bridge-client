import { randomBytes } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { setTimeout as sleepFor } from "node:timers/promises";

// Windows refuses to replace a file another program has open (even with write sharing), and antivirus scanners and search
// indexers hold short-lived handles too, so the rename is tried again for about two seconds before giving up.
const LOCKED_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320, 640, 730];

export interface WriteFileNoFollowDeps {
  rename?: (from: string, to: string) => Promise<void>;
  sleep?: (ms: number) => Promise<unknown>;
  /** Retry a rename that fails as locked: on by default on Windows only (elsewhere those codes are real permission errors). */
  retry?: boolean;
}

// Writes decrypted mail content to `path` without ever following a symbolic link at the final component: the bytes
// go to a new, exclusively created, owner-only file next to it, which is then renamed over `path`. A rename replaces a
// link instead of writing through it, so a link planted at `path` (dangling or not) cannot send the write elsewhere.
export async function writeFileNoFollow(path: string, data: Buffer, deps: WriteFileNoFollowDeps = {}): Promise<void> {
  const renameFile = deps.rename ?? rename;
  const sleep = deps.sleep ?? sleepFor;
  const retry = deps.retry ?? process.platform === "win32";
  const tempPath = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(data);
  } catch (error) {
    await handle.close();
    await rm(tempPath, { force: true });
    throw error;
  }
  await handle.close();
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(tempPath, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      const locked = code !== undefined && LOCKED_CODES.has(code);
      if (retry && locked && attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      await rm(tempPath, { force: true });
      if (!retry || !locked) throw error;
      // Names the destination, not the temp file, and keeps the system error as the cause.
      throw Object.assign(new Error(`Cannot replace ${path}: the file is open in another program or locked (${code}). The existing file was left unchanged; close the program using it and try again.`, { cause: error }), { code });
    }
  }
}
