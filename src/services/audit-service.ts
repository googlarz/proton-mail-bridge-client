import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AuditEntry, ProtonMailConfig } from "../types/index.js";
import { ensureAccountIdentityMatches } from "../utils/account-identity.js";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { withFileLock } from "../utils/file-lock.js";

const MAX_AUDIT_BYTES = 5 * 1024 * 1024;
const MAX_AUDIT_LINES = 10000;
const GENESIS_HASH = "0".repeat(64);

export type AuditBreakReason = "edited" | "deleted" | "reordered";

export interface AuditVerification {
  ok: boolean;
  checked: number;
  legacyEntries: number;
  headSeq: number | null;
  headHash: string | null;
  // Set when the oldest kept entry is not the chain start because older archives were rotated away.
  rotatedBeforeSeq?: number;
  brokenSeq?: number;
  reason?: AuditBreakReason;
  detail?: string;
}

type ChainHead = { seq: number; hash: string };

// Key order is not stable across writers, so the hash covers keys sorted at every level. The value goes through a
// JSON round trip first so it hashes exactly what is read back from disk (undefined dropped, Dates as strings).
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashEntry(entry: AuditEntry): string {
  const { hash: _hash, ...body } = entry;
  return createHash("sha256").update(`${entry.prevHash ?? ""}${canonicalJson(JSON.parse(JSON.stringify(body)))}`).digest("hex");
}

function isChained(entry: AuditEntry): boolean {
  return typeof entry.hash === "string" && typeof entry.seq === "number";
}

function parseLine(line: string): AuditEntry | undefined {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as AuditEntry) : undefined;
  } catch {
    return undefined;
  }
}

// A line cut short by a crash mid-append: it starts like an entry but is not valid JSON.
function isIncompleteEntry(line: string): boolean {
  try {
    JSON.parse(line);
    return false;
  } catch {
    return line.trimStart().startsWith("{");
  }
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

export class AuditService {
  private readonly auditPath: string;
  private readonly archivePath: string;
  private readonly archivePath2: string;
  private readonly headPath: string;
  private _rotateLock: Promise<void> = Promise.resolve();
  private permissionsChecked = false;
  private identityChecked = false;
  // The head this process last wrote, valid while audit.log is still the same file at the same size: then no
  // other process appended in between and the file need not be re-read.
  private cachedHead?: { ino: number; size: number; head: ChainHead };

  constructor(private readonly config: ProtonMailConfig) {
    this.auditPath = join(this.config.dataDir, "audit.log");
    this.archivePath = `${this.auditPath}.1`;
    this.archivePath2 = `${this.auditPath}.2`;
    this.headPath = join(this.config.dataDir, "audit.head");
  }

  getPath(): string {
    return this.auditPath;
  }

  // See DeliveryQueueService.loadUnlocked's identical guard: refuse to
  // touch this dataDir's audit.log (or its rotated archives) if it belongs
  // to a different account. AuditService is append-only-log-backed rather
  // than JSON-blob-backed like the other stores, so there's no single
  // loadUnlocked() choke point to hang this on — record(), list() and verify()
  // are its entry points that actually touch disk, so all of them call this.
  private async ensureIdentity(): Promise<void> {
    if (!this.identityChecked) {
      await ensureAccountIdentityMatches(this.config.dataDir, this.config.smtp.username);
      this.identityChecked = true;
    }
  }

  async record(entry: AuditEntry): Promise<void> {
    await this.ensureIdentity();
    await mkdir(dirname(this.auditPath), { recursive: true, mode: 0o700 });
    // appendFile's `mode` option only applies when the file doesn't already
    // exist — on every real upgrade (not a fresh install), audit.log already
    // existed at 0644 from before this fix, and every append since kept that
    // permission forever since appending never re-chmods. Explicitly chmod
    // once per process lifetime (not on every single append — this is a hot
    // path) so an existing, already-populated audit.log actually gets
    // restricted on upgrade instead of only protecting brand-new installs.
    if (!this.permissionsChecked) {
      this.permissionsChecked = true;
      await chmod(this.auditPath, 0o600).catch(() => {});
      await chmod(this.archivePath, 0o600).catch(() => {});
      await chmod(this.archivePath2, 0o600).catch(() => {});
    }
    const { seq: _seq, prevHash: _prevHash, hash: _hash, chainStart: _chainStart, ...fields } = entry;
    const persistedEntry: AuditEntry = {
      ...fields,
      durationMs: entry.durationMs ?? 0,
      error: entry.error ? this.scrubError(entry.error) : entry.error,
    };
    // The file lock keeps a second server process on the same dataDir from reading the same head and
    // forking the chain; the in-process chain only saves this process from polling its own lock file.
    await this.withRotateLock(() =>
      withFileLock(this.auditPath, async () => {
        await this.rotateIfNeeded();
        const fileHead = await this.readHead();
        // If audit.log lost its newest entries (or all of them), carry on from the head audit.head recorded, so
        // the gap stays visible to verify instead of a fresh chain hiding it.
        const recorded = await this.readRecordedHead();
        const head = recorded && recorded !== "invalid" && (!fileHead || recorded.seq > fileHead.seq) ? recorded : fileHead;
        const needsNewline = !(await this.endsWithNewline());
        const chained: AuditEntry = head
          ? { ...persistedEntry, seq: head.seq + 1, prevHash: head.hash }
          : { ...persistedEntry, seq: 1, prevHash: GENESIS_HASH, chainStart: true };
        chained.hash = hashEntry(chained);
        // The chain detects an edit, deletion or reordering, but anyone who can write the file can also
        // recompute every hash after the point they changed; only a head hash kept elsewhere catches that.
        // mode: 0o600 — the audit trail can contain full request/error detail, so it must not land world-readable at the default umask.
        // A crash can leave a half-written last line; the new entry must not be glued onto it and lost.
        await appendFile(this.auditPath, `${needsNewline ? "\n" : ""}${JSON.stringify(chained)}\n`, { encoding: "utf8", mode: 0o600 });
        const info = await stat(this.auditPath);
        const newHead = { seq: chained.seq as number, hash: chained.hash };
        this.cachedHead = { ino: info.ino, size: info.size, head: newHead };
        // Written after the append: a crash between the two leaves audit.head one entry behind, which verify accepts.
        // Like the log itself this only raises the bar: someone who can write both files can forge both. The real
        // defense is a head hash (verify_audit_log returns it) saved somewhere they cannot reach.
        await writeFileAtomic(this.headPath, `${JSON.stringify(newHead)}\n`);
      }),
    );
  }

  async list(limit = 100): Promise<AuditEntry[]> {
    await this.ensureIdentity();
    const cap = Math.min(limit, MAX_AUDIT_LINES);
    const entries = [
      ...(await this.readEntries(this.archivePath2, cap)),
      ...(await this.readEntries(this.archivePath, cap)),
      ...(await this.readEntries(this.auditPath, cap)),
    ];
    return entries.slice(-cap);
  }

  async verify(): Promise<AuditVerification> {
    await this.ensureIdentity();
    // Under the lock so a half-written line or a rotation in progress is never mistaken for tampering.
    const [files, recorded] = await withFileLock(this.auditPath, async () => [
      [await this.readLines(this.archivePath2), await this.readLines(this.archivePath), await this.readLines(this.auditPath)],
      await this.readRecordedHead(),
    ] as const);
    const hasArchive2 = files[0].length > 0;
    const lines = files.flat();

    let legacyEntries = 0;
    let checked = 0;
    let prev: (AuditEntry & { seq: number; hash: string }) | undefined;
    let rotatedBeforeSeq: number | undefined;
    let torn = 0;
    let hashAtRecordedSeq: string | undefined;
    const broken = (seq: number, reason: AuditBreakReason, detail: string): AuditVerification => ({
      ok: false, checked, legacyEntries, headSeq: null, headHash: null, brokenSeq: seq, reason, detail,
    });

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const entry = parseLine(line);
      if (!entry && isIncompleteEntry(line)) {
        torn++;
        continue;
      }
      if (!entry || !isChained(entry)) {
        if (!prev) {
          legacyEntries++;
          continue;
        }
        return broken(prev.seq + 1, "edited", `a line after seq ${prev.seq} is ${entry ? "missing its hash" : "not valid JSON"}`);
      }
      const seq = entry.seq as number;
      if (hashEntry(entry) !== entry.hash) {
        return broken(seq, "edited", `the content of seq ${seq} does not match its hash`);
      }
      if (!prev) {
        if (entry.chainStart) {
          if (seq !== 1 || entry.prevHash !== GENESIS_HASH) {
            return broken(seq, "edited", `seq ${seq} is marked as the chain start but does not begin a chain`);
          }
        } else if (hasArchive2 && index === 0) {
          // Rotation drops whole files, so after an eviction the oldest archive starts exactly at a chained
          // entry. Anywhere else, entries before the first one kept were removed.
          rotatedBeforeSeq = seq;
        } else {
          return broken(seq - 1, "deleted", `entries before seq ${seq} are missing and were not rotated away`);
        }
      } else if (seq !== prev.seq + 1) {
        const expected = prev.seq + 1;
        if (seq < expected) {
          return broken(expected, "reordered", `seq ${seq} appears after seq ${prev.seq}`);
        }
        const later = lines.slice(index + 1).some((other) => parseLine(other)?.seq === expected);
        return later
          ? broken(expected, "reordered", `seq ${expected} appears out of order, after seq ${prev.seq} comes seq ${seq}`)
          : broken(expected, "deleted", `seq ${expected}${seq - expected > 1 ? `..${seq - 1}` : ""} is missing`);
      } else if (entry.prevHash !== prev.hash) {
        return broken(seq, "edited", `seq ${seq} does not link to seq ${prev.seq}; one of them was rewritten`);
      }
      prev = entry as AuditEntry & { seq: number; hash: string };
      checked++;
      if (recorded && recorded !== "invalid" && seq === recorded.seq) hashAtRecordedSeq = entry.hash;
    }

    // audit.head is only a claim once it exists; without it nothing is checked against the head.
    if (recorded === "invalid") {
      return broken(prev?.seq ?? 0, "edited", "audit.head exists but cannot be read, so the chain head cannot be confirmed");
    }
    if (recorded) {
      if (!prev) {
        return legacyEntries > 0
          ? broken(recorded.seq, "edited", `audit.log has no chained entries, but audit.head records the chain up to seq ${recorded.seq}; the chain fields were removed`)
          : broken(recorded.seq, "deleted", `audit.log is missing or empty, but audit.head records the chain up to seq ${recorded.seq}`);
      }
      if (prev.seq < recorded.seq) {
        return broken(prev.seq + 1, "deleted", `audit.log ends at seq ${prev.seq}, but audit.head records seq ${recorded.seq}; the newest entries were removed`);
      }
      if (prev.seq === recorded.seq ? prev.hash !== recorded.hash : hashAtRecordedSeq !== undefined && hashAtRecordedSeq !== recorded.hash) {
        return broken(recorded.seq, "edited", `seq ${recorded.seq} does not match the hash audit.head recorded for it`);
      }
    }

    return {
      ok: true,
      checked,
      legacyEntries,
      headSeq: prev?.seq ?? null,
      headHash: prev?.hash ?? null,
      ...(rotatedBeforeSeq !== undefined ? { rotatedBeforeSeq } : {}),
      ...(torn > 0 ? { detail: `${torn} incomplete line${torn === 1 ? "" : "s"} (a write cut short, e.g. by a crash) skipped; the entries around ${torn === 1 ? "it are" : "them are"} intact` } : {}),
    };
  }

  // The head audit.head holds, undefined when there is none yet (nothing is claimed then), "invalid" when it is unreadable.
  private async readRecordedHead(): Promise<ChainHead | "invalid" | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.headPath, "utf8");
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ChainHead> | null;
      return parsed && Number.isInteger(parsed.seq) && (parsed.seq as number) > 0 && typeof parsed.hash === "string" ? { seq: parsed.seq as number, hash: parsed.hash } : "invalid";
    } catch {
      return "invalid";
    }
  }

  // Whether the next append starts on a fresh line. A file this process just wrote is known to end in one.
  private async endsWithNewline(): Promise<boolean> {
    const info = await stat(this.auditPath).catch((error) => {
      if (isEnoent(error)) return undefined;
      throw error;
    });
    if (!info || info.size === 0) return true;
    if (this.cachedHead && this.cachedHead.ino === info.ino && this.cachedHead.size === info.size) return true;
    const handle = await open(this.auditPath, "r");
    try {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, info.size - 1);
      return last[0] === 0x0a;
    } finally {
      await handle.close();
    }
  }

  // Newest chained entry across audit.log and its archives (an archive holds the head right after a rotation).
  private async readHead(): Promise<ChainHead | undefined> {
    const info = await stat(this.auditPath).catch((error) => {
      if (isEnoent(error)) return undefined;
      throw error;
    });
    if (info && this.cachedHead && this.cachedHead.ino === info.ino && this.cachedHead.size === info.size) {
      return this.cachedHead.head;
    }
    for (const path of [this.auditPath, this.archivePath, this.archivePath2]) {
      const lines = await this.readLines(path);
      for (let index = lines.length - 1; index >= 0; index--) {
        const entry = parseLine(lines[index]);
        if (entry && isChained(entry)) {
          return { seq: entry.seq as number, hash: entry.hash as string };
        }
      }
    }
    return undefined;
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      const info = await stat(this.auditPath);
      if (info.size < MAX_AUDIT_BYTES) {
        return;
      }
      // Keep two rotated generations (.1, .2) instead of one — a single
      // archive meant a burst of ordinary tool calls forcing two rotations
      // would permanently evict a targeted historical entry after just one
      // extra MAX_AUDIT_BYTES of writes. Two generations doubles that cost;
      // it doesn't remove the inherent tradeoff of a size-bounded log.
      await rename(this.archivePath, this.archivePath2).catch((error) => {
        if (!(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT")) {
          throw error;
        }
      });
      await rename(this.auditPath, this.archivePath);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  private async withRotateLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this._rotateLock.then(fn, fn);
    this._rotateLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // Removes the secrets that commonly end up in an error message: key=value and key: value pairs for
  // password-like names, bearer/basic credentials, an IMAP LOGIN line, and user:password@ in a URL. A bare
  // "Name: address@host" is not a credential and is left alone.
  private scrubError(error: string): string {
    return String(error)
      .replace(/\b(pass(?:word|wd|phrase)?|pwd|secret|token|api[-_]?key|access[-_]?token)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi, "$1=REDACTED")
      .replace(/\b(authorization\s*:\s*(?:bearer|basic)\s+)\S+/gi, "$1REDACTED")
      .replace(/\b(LOGIN\s+\S+\s+)("[^"]*"|\S+)/gi, "$1REDACTED")
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:/@\s]+):[^@\s]+@/gi, "$1:REDACTED@");
  }

  private async readLines(path: string): Promise<string[]> {
    try {
      return (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean);
    } catch (error) {
      if (isEnoent(error)) {
        return [];
      }
      throw error;
    }
  }

  private async readEntries(path: string, maxLines = MAX_AUDIT_LINES): Promise<AuditEntry[]> {
    try {
      const raw = await readFile(path, "utf8");
      const allLines = raw.split(/\r?\n/).filter(Boolean);
      const lines = allLines.slice(-maxLines);
      return lines.flatMap((line) => {
          try {
            return [JSON.parse(line) as AuditEntry];
          } catch {
            return [];
          }
        });
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    }
  }
}
