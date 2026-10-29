import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

function notRegular(path: string, code: string, why: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${path}: ${why}`), { code });
}

// Reads a file from the data directory only if it is a regular file within the size cap. A plain readFile on a
// FIFO blocks a libuv thread forever (the process then cannot exit), so a planted FIFO would hang the server.
// O_NONBLOCK makes open() return at once for a FIFO; the type is checked on the opened handle (no race between
// a check and the open). A missing file is ENOENT, but a dangling symlink is not: something is there, it just
// leads nowhere, which is reported as ENOTREG so callers do not treat it as "no file yet".
export async function readRegularFile(path: string, options?: { maxBytes?: number; binary?: false }): Promise<string>;
export async function readRegularFile(path: string, options: { maxBytes?: number; binary: true }): Promise<Buffer>;
export async function readRegularFile(path: string, options: { maxBytes?: number; binary?: boolean } = {}): Promise<string | Buffer> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && (await lstat(path).catch(() => undefined))) {
      throw notRegular(path, "ENOTREG", "a symlink to nothing is in the place of this file");
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw notRegular(path, "ENOTREG", "not a regular file");
    if (info.size > maxBytes) throw notRegular(path, "EFBIG", `larger than ${maxBytes} bytes`);
    const data = await handle.readFile();
    if (data.length > maxBytes) throw notRegular(path, "EFBIG", `larger than ${maxBytes} bytes`);
    return options.binary ? data : data.toString("utf8");
  } finally {
    await handle.close();
  }
}
