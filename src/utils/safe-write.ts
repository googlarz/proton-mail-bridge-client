import { randomBytes } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";

// Writes decrypted mail content to `path` without ever following a symbolic link at the final component: the bytes
// go to a new, exclusively created, owner-only file next to it, which is then renamed over `path`. A rename replaces a
// link instead of writing through it, so a link planted at `path` (dangling or not) cannot send the write elsewhere.
export async function writeFileNoFollow(path: string, data: Buffer): Promise<void> {
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
  try {
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}
