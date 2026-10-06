import { copyFileSync, existsSync } from "node:fs";
import type { Logger } from "./logger.js";

export function isFileNotFound(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { code?: string }).code === "ENOENT";
}

// Called when reading a JSON store failed with something other than "file does not exist".
//
// Only invalid JSON (a SyntaxError) means the contents are unusable: the file is kept as `<file>.corrupt`
// (never over an earlier backup) so it can be recovered by hand, and the caller starts an empty store.
// Any other error (EACCES, EIO, EMFILE...) says nothing about what the file holds, and starting empty
// would let the next save() overwrite the real data, so it is rethrown. The same goes for a failed
// backup: the unreadable file is the only copy left, so it must not be replaced.
export function setAsideCorruptStore(path: string, error: unknown, log: Logger, source: string): void {
  if (!(error instanceof SyntaxError)) {
    throw error;
  }
  let backupPath = `${path}.corrupt`;
  if (existsSync(backupPath)) {
    backupPath = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  }
  try {
    copyFileSync(path, backupPath);
  } catch (backupError) {
    log.error(`Could not back up the unreadable ${path}; leaving it untouched`, source, { parseError: error, backupError });
    throw backupError;
  }
  log.error(`Unreadable ${path} backed up to ${backupPath} — starting with an empty store`, source, error);
}
