import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lowerCaseAddress } from "./helpers.js";

// Guards against a real cross-account privacy leak: PROTONMAIL_DATA_DIR
// defaults to one fixed path per OS user, not per Proton account. If someone
// switches accounts (changes PROTONMAIL_USERNAME/credentials) but keeps the
// same dataDir, every store under it — the SQLite mail index, the delivery
// queue, snooze/draft/template JSON files — would otherwise silently open
// the PREVIOUS account's data and let the new account read (or send) it.
//
// This marker file records which account's data actually lives in a given
// dataDir, so every store can refuse to open when the currently-configured
// account doesn't match. It intentionally uses config.smtp.username (not
// imap.username, which can be a separate IMAP-only override) as the account
// identity — see the self-address-detection code elsewhere in this codebase
// (e.g. local-index-service.ts's ownerEmail) that makes the same choice.
const MARKER_FILENAME = "account.json";

interface AccountMarkerFile {
  version: 1;
  accountEmail: string;
}

// Thrown by ensureAccountIdentityMatches on a mismatch. A distinct error type
// lets callers (and tests) distinguish "wrong account" from an ordinary I/O
// failure without parsing the message.
export class AccountIdentityMismatchError extends Error {
  constructor(
    public readonly dataDir: string,
    public readonly onDisk: string,
    public readonly current: string,
  ) {
    super(
      `Data directory "${dataDir}" belongs to account "${onDisk}", but the server is currently ` +
        `configured for account "${current}". Refusing to open this account's data stores under a ` +
        `different account's identity. Set PROTONMAIL_DATA_DIR to a separate directory per account.`,
    );
    this.name = "AccountIdentityMismatchError";
  }
}

function markerPath(dataDir: string): string {
  return join(dataDir, MARKER_FILENAME);
}

// Verifies the account identity marker for `dataDir` against
// `currentAccountEmail` (normalized PROTONMAIL_USERNAME / config.smtp.username).
//
// - No marker file yet (fresh dataDir, or a pre-fix dataDir upgrading to this
//   check for the first time) is indistinguishable from legitimate first use
//   from the marker's own perspective, so it writes the marker now, treating
//   whatever account is currently configured as authoritative going forward.
//   This does NOT retroactively litigate data that predates the marker — it
//   only prevents FUTURE cross-account opens of this dataDir.
// - Marker present and matching: succeeds, no write.
// - Marker present and mismatched: throws AccountIdentityMismatchError. The
//   caller must not proceed to open/use the store on this path.
export async function ensureAccountIdentityMatches(
  dataDir: string,
  currentAccountEmail: string,
): Promise<void> {
  const current = lowerCaseAddress(currentAccountEmail) || "";
  const path = markerPath(dataDir);

  let existing: AccountMarkerFile | undefined;
  try {
    const raw = await readFile(path, "utf8");
    existing = JSON.parse(raw) as AccountMarkerFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  if (existing?.accountEmail) {
    if (existing.accountEmail !== current) {
      throw new AccountIdentityMismatchError(dataDir, existing.accountEmail, current);
    }
    return;
  }

  // First use of this dataDir (fresh, or pre-fix with no marker yet) — write
  // the marker. Atomic temp+rename, 0o600, mirroring DraftStoreService's/
  // TemplateService's own JSON store persistence pattern.
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const marker: AccountMarkerFile = { version: 1, accountEmail: current };
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, JSON.stringify(marker, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, path);
}
