import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { isPathInside } from "./helpers.js";

// Where the server keeps what it must be able to trust: the data directory of every account (grants, audit and event
// logs, rules, contacts, the account marker...) and the certificate file it was told to trust. A download directory such
// as $HOME contains them, so being inside it does not make a destination safe for a saved attachment.
export interface ServerStateConfig {
  dataDir: string;
  accounts?: ReadonlyArray<{ dataDir: string }>;
  runtime?: { tlsCaFile?: string };
}

// The folder the server saves attachments to when no download directory is set: nothing else lives in it.
const ATTACHMENTS_FOLDER = "attachments";

/** The deepest existing part of the path by real path (symlinks followed), the rest as written. */
function canonical(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  try {
    return join(realpathSync(existing), relative(existing, absolute));
  } catch {
    return absolute;
  }
}

// The same file or directory by device and inode, so a different spelling (the case of a name on macOS and Windows, a hard
// link, a symlink) cannot make a path look like something else.
function sameFile(a: string, b: string): boolean {
  try {
    const left = statSync(a, { bigint: true });
    const right = statSync(b, { bigint: true });
    return left.ino !== 0n && left.ino === right.ino && left.dev === right.dev;
  } catch {
    return false;
  }
}

/** Whether `target` lies in the server's own state. Its existing part is expected to be a real path already. */
export function isInsideServerState(target: string, config: ServerStateConfig | undefined): boolean {
  if (!config) return false;
  // The target and each of its parents up to the root.
  const chain: string[] = [];
  for (let path = resolve(target); ; path = dirname(path)) {
    chain.push(path);
    if (dirname(path) === path) break;
  }
  for (const dataDir of new Set([config.dataDir, ...(config.accounts ?? []).map((account) => account.dataDir)].filter(Boolean))) {
    const real = canonical(dataDir);
    if (isPathInside(join(real, ATTACHMENTS_FOLDER), target)) continue;
    if (!existsSync(dataDir)) {
      if (isPathInside(real, target)) return true;
      continue;
    }
    const attachments = join(dataDir, ATTACHMENTS_FOLDER);
    for (const ancestor of chain) {
      if (sameFile(ancestor, attachments)) break;
      if (sameFile(ancestor, dataDir)) return true;
    }
  }
  const trusted = config.runtime?.tlsCaFile;
  return Boolean(trusted) && (canonical(trusted as string) === target || sameFile(target, trusted as string));
}
