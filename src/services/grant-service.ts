import { randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProtonMailConfig } from "../types/index.js";
import { ensureAccountIdentityMatches } from "../utils/account-identity.js";
import { cleanForPrompt } from "../utils/approval.js";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { isFileNotFound, setAsideCorruptStore } from "../utils/corrupt-store.js";
import {
  GRANTABLE_TOOLS,
  MAX_GRANT_DAYS,
  MAX_GRANT_NOTE_CHARS,
  MAX_GRANT_RECIPIENTS,
  MAX_GRANT_USES,
  type GrantableTool,
  normalizeRecipientPattern,
  recipientsCovered,
} from "../utils/delegation.js";
import { withFileLock } from "../utils/file-lock.js";
import { InvalidArgumentError } from "../utils/helpers.js";
import { logger, type Logger } from "../utils/logger.js";

// The delegation grants of one account: "this tool may send to these recipients, this many times, until this date",
// kept next to the account's other local stores (owner-only, written atomically, every change under the file lock that
// the other server processes on the data directory share). Only the CLI creates or revokes a grant: nothing here is
// reachable from an MCP tool. The file is not signed, so a model that can write files can still write a grant. A use is spent in one locked step BEFORE the mail is sent (at most once: a send that then fails
// does not give it back, and a crash can never leave an extra one), the way a rule's forward is claimed.

export interface Grant {
  id: string;
  /** Free text from the person who made the grant; cleaned to one line. */
  note: string;
  /** The account's address, lowercase: a grant file copied to another account's data directory covers nothing there. */
  account: string;
  tools: GrantableTool[];
  /** Exact addresses ("a@b.example") and "@domain" entries, lowercase ASCII. */
  recipients: string[];
  maxUses: number;
  expiresAt: string;
  usedCount: number;
  createdAt: string;
  revoked: boolean;
}

export type GrantStatus = "active" | "revoked" | "expired" | "used up";

interface GrantFile {
  version: 1;
  grants: Grant[];
}

const DAY_MS = 86_400_000;
const GRANT_ID = /^g-[0-9a-f]{8}$/;

export function grantStatus(grant: Grant, now: Date | number = Date.now()): GrantStatus {
  if (grant.revoked) return "revoked";
  if (Date.parse(grant.expiresAt) <= +now) return "expired";
  if (grant.usedCount >= grant.maxUses) return "used up";
  return "active";
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const asciiLowerAddress = (value: string) => value.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/** A stored entry read back with the same rules a new grant is made with; anything doubtful narrows the grant or drops it, never widens it. */
function readStoredGrant(raw: unknown, account: string): Grant | undefined {
  if (!isRecord(raw) || typeof raw.id !== "string" || !GRANT_ID.test(raw.id)) return undefined;
  if (typeof raw.account !== "string" || asciiLowerAddress(raw.account) !== account) return undefined;
  const tools = Array.isArray(raw.tools) ? GRANTABLE_TOOLS.filter((tool) => (raw.tools as unknown[]).includes(tool)) : [];
  const recipients = Array.isArray(raw.recipients) ? [...new Set(raw.recipients.map(normalizeRecipientPattern).filter((pattern): pattern is string => pattern !== undefined))] : [];
  const maxUses = raw.maxUses;
  if (tools.length === 0 || recipients.length === 0) return undefined;
  if (typeof maxUses !== "number" || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > MAX_GRANT_USES) return undefined;
  if (typeof raw.expiresAt !== "string" || Number.isNaN(Date.parse(raw.expiresAt))) return undefined;
  const createdAt = typeof raw.createdAt === "string" && !Number.isNaN(Date.parse(raw.createdAt)) ? raw.createdAt : new Date(0).toISOString();
  // A used count that cannot be read counts as used up.
  const used = raw.usedCount;
  const usedCount = typeof used === "number" && Number.isInteger(used) && used >= 0 ? Math.min(used, maxUses) : maxUses;
  return {
    id: raw.id,
    note: cleanForPrompt(raw.note, MAX_GRANT_NOTE_CHARS),
    account,
    tools,
    recipients,
    maxUses,
    expiresAt: new Date(raw.expiresAt).toISOString(),
    usedCount,
    createdAt,
    // Anything but an explicit false counts as revoked.
    revoked: raw.revoked !== false,
  };
}

export interface GrantCall {
  tool: string;
  recipients: readonly unknown[];
}

export class GrantService {
  private readonly storePath: string;
  private readonly account: string;
  private _lock: Promise<void> = Promise.resolve();
  private identityChecked = false;

  constructor(
    private readonly config: Pick<ProtonMailConfig, "dataDir"> & { smtp: { username: string } },
    account: string,
    private readonly log: Logger = logger,
  ) {
    this.storePath = join(config.dataDir, "grants.json");
    this.account = asciiLowerAddress(account);
  }

  get filePath(): string {
    return this.storePath;
  }

  /** What createGrant would store, checked and normalised but not written, so the person can be shown exactly that before confirming. */
  planGrant(
    input: { note?: string; tools: readonly string[]; recipients: readonly string[]; maxUses: number; expiresAt: Date },
    now = new Date(),
  ): { note: string; tools: GrantableTool[]; recipients: string[]; maxUses: number; expiresAt: Date } {
    const tools = GRANTABLE_TOOLS.filter((tool) => input.tools.includes(tool));
    const unknown = input.tools.filter((tool) => !(GRANTABLE_TOOLS as readonly string[]).includes(tool));
    if (tools.length === 0 || unknown.length > 0) {
      throw new InvalidArgumentError(`A grant can cover only ${GRANTABLE_TOOLS.join(", ")}${unknown.length ? ` (not ${unknown.join(", ")})` : ""}.`);
    }
    const patterns = input.recipients.map((entry) => ({ entry, pattern: normalizeRecipientPattern(entry) }));
    const bad = patterns.filter(({ pattern }) => pattern === undefined).map(({ entry }) => cleanForPrompt(entry, 60));
    if (bad.length > 0 || patterns.length === 0) {
      throw new InvalidArgumentError(`A recipient must be an exact ASCII address (name@example.com) or @domain (every address at exactly that domain)${bad.length ? `; not valid: ${bad.join(", ")}` : ""}.`);
    }
    const recipients = [...new Set(patterns.map(({ pattern }) => pattern as string))];
    if (recipients.length > MAX_GRANT_RECIPIENTS) throw new InvalidArgumentError(`A grant can name at most ${MAX_GRANT_RECIPIENTS} recipients.`);
    if (!Number.isInteger(input.maxUses) || input.maxUses < 1 || input.maxUses > MAX_GRANT_USES) {
      throw new InvalidArgumentError(`Uses must be a whole number from 1 to ${MAX_GRANT_USES}.`);
    }
    const expires = input.expiresAt.getTime();
    if (Number.isNaN(expires) || expires <= now.getTime()) throw new InvalidArgumentError("The expiry must be in the future.");
    if (expires > now.getTime() + MAX_GRANT_DAYS * DAY_MS) throw new InvalidArgumentError(`A grant can last at most ${MAX_GRANT_DAYS} days.`);

    return { note: cleanForPrompt(input.note, MAX_GRANT_NOTE_CHARS), tools, recipients, maxUses: input.maxUses, expiresAt: new Date(expires) };
  }

  /** Makes a grant. Called by the CLI only, after the person confirmed it at a terminal. */
  async createGrant(
    input: { note?: string; tools: readonly string[]; recipients: readonly string[]; maxUses: number; expiresAt: Date },
    now = new Date(),
  ): Promise<Grant> {
    const plan = this.planGrant(input, now);
    return this.withLock(async () => {
      const store = await this.loadUnlocked();
      let id = "";
      do id = `g-${randomBytes(4).toString("hex")}`;
      while (store.grants.some((grant) => grant.id === id));
      const grant: Grant = {
        id,
        note: plan.note,
        account: this.account,
        tools: plan.tools,
        recipients: plan.recipients,
        maxUses: plan.maxUses,
        expiresAt: plan.expiresAt.toISOString(),
        usedCount: 0,
        createdAt: now.toISOString(),
        revoked: false,
      };
      store.grants.push(grant);
      await this.save(store);
      return grant;
    });
  }

  /** Revokes a grant (the entry stays, marked, so the history reads true). Called by the CLI only. */
  async revokeGrant(id: string): Promise<{ id: string; found: boolean; alreadyRevoked: boolean }> {
    return this.withLock(async () => {
      const store = await this.loadUnlocked();
      const grant = store.grants.find((candidate) => candidate.id === id);
      if (!grant) return { id, found: false, alreadyRevoked: false };
      if (grant.revoked) return { id, found: true, alreadyRevoked: true };
      grant.revoked = true;
      await this.save(store);
      return { id, found: true, alreadyRevoked: false };
    });
  }

  /** Every grant in the store, active or not (see grantStatus). */
  async list(): Promise<Grant[]> {
    return this.withLock(async () => (await this.loadUnlocked()).grants);
  }

  /** The grant that would cover this call, if any; nothing is spent. */
  async find(call: GrantCall, now: Date | number = Date.now()): Promise<Grant | undefined> {
    return this.withLock(async () => this.pick((await this.loadUnlocked()).grants, call, now));
  }

  /**
   * Spends one use of the grant that covers this call, in one locked step: of two server processes asking for the last
   * use, one is given it and the other is told no. The grant is re-checked here (not expired, not revoked, a use left,
   * the tool listed, EVERY recipient covered), whatever an earlier find() said.
   */
  async claim(call: GrantCall, now: Date | number = Date.now()): Promise<{ grant: Grant; remaining: number } | undefined> {
    return this.withLock(async () => {
      const store = await this.loadUnlocked();
      const grant = this.pick(store.grants, call, now);
      if (!grant) return undefined;
      grant.usedCount += 1;
      await this.save(store);
      return { grant: { ...grant }, remaining: grant.maxUses - grant.usedCount };
    });
  }

  // The earliest-expiring cover, then the one with the fewest uses left, so a call spends the grant most likely to lapse unused.
  private pick(grants: Grant[], call: GrantCall, now: Date | number): Grant | undefined {
    return grants
      .filter(
        (grant) =>
          grantStatus(grant, now) === "active" &&
          (grant.tools as readonly string[]).includes(call.tool) &&
          recipientsCovered(grant.recipients, call.recipients),
      )
      .sort((left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt) || left.maxUses - left.usedCount - (right.maxUses - right.usedCount) || left.id.localeCompare(right.id))[0];
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const locked = async () => {
      await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
      return withFileLock(this.storePath, fn);
    };
    const run = this._lock.then(locked, locked);
    this._lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async loadUnlocked(): Promise<GrantFile> {
    if (!this.identityChecked) {
      await ensureAccountIdentityMatches(this.config.dataDir, this.config.smtp.username);
      this.identityChecked = true;
    }
    try {
      const parsed = JSON.parse(await readFile(this.storePath, "utf8")) as Partial<GrantFile>;
      const entries = Array.isArray(parsed.grants) ? parsed.grants : [];
      const grants = entries.flatMap((entry) => {
        const grant = readStoredGrant(entry, this.account);
        return grant ? [grant] : [];
      });
      if (grants.length < entries.length) this.log.warn("Ignored grants that are not valid for this account", "GrantService", { ignored: entries.length - grants.length });
      return { version: 1, grants };
    } catch (error) {
      if (isFileNotFound(error)) return { version: 1, grants: [] };
      // An unreadable store covers nothing: no grant is honoured until the person has looked at the file.
      setAsideCorruptStore(this.storePath, error, this.log, "GrantService");
      return { version: 1, grants: [] };
    }
  }

  private async save(store: GrantFile): Promise<void> {
    await writeFileAtomic(this.storePath, JSON.stringify(store, null, 2));
  }
}
