import { randomUUID } from "node:crypto";
import { mkdir, readdir, unlink } from "node:fs/promises";
import { readRegularFile } from "../utils/regular-file.js";
import { dirname, join } from "node:path";
import type { ProtonMailConfig } from "../types/index.js";
import { ensureAccountIdentityMatches } from "../utils/account-identity.js";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { cleanContactText, foldText, normalizeContactAddress } from "../utils/contact-text.js";
import { isFileNotFound, setAsideCorruptStore } from "../utils/corrupt-store.js";
import { withFileLock } from "../utils/file-lock.js";
import { InvalidArgumentError } from "../utils/helpers.js";
import { logger, type Logger } from "../utils/logger.js";
import { CONTACT_NAME_MAX, CONTACT_NOTES_MAX, CONTACT_ORG_MAX, type ParsedVCard } from "../utils/vcard.js";

// What the user said about the people they write with, for one account: a display name, tags (such as vip), notes, and
// which addresses are one person. Message counts, dates and names from headers are not stored: they come from the
// local index each time. A record that no longer says anything (one address, nothing set) is removed. Persistence
// mirrors TemplateService: atomic writes, a file lock across processes, a corrupt file set aside.

export interface ContactRecord {
  id: string;
  /** Lowercased; an address belongs to at most one record. */
  addresses: string[];
  displayName?: string;
  /** Set when the name came from an imported vCard file (text someone else wrote), absent when the user set it. */
  displayNameFrom?: "import";
  org?: string;
  tags?: string[];
  /** Nicknames and other ways the user refers to this person; unique across the store (case and diacritics ignored). */
  aliases?: string[];
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContactPatch {
  /** null or "" clears it. */
  displayName?: string | null;
  notes?: string | null;
  addTags?: string[];
  removeTags?: string[];
  /** Replaces the list of aliases; an empty list clears it. */
  aliases?: string[];
  /** Another address of the same person: its record (if any) is merged into this one. */
  mergeWith?: string;
  /** Split this address out of the person it was merged into. */
  unmerge?: boolean;
}

export interface ContactImportOutcome {
  added: number;
  updated: number;
  unchanged: number;
  /** Addresses of a card that names a known person but are not that person's yet (or belong to another one); left out. A file never attaches an address to a person: merging is set_contact's mergeWith. First 20; `conflictCount` is the total. */
  conflicts: string[];
  conflictCount: number;
  /** Cards not imported because the store is full. */
  overLimit: number;
}

interface ContactFile {
  version: number;
  items: Record<string, ContactRecord>;
}

export const MAX_CONTACTS = 10_000;
const MAX_ADDRESSES = 50;
const MAX_TAGS = 20;
export const MAX_ALIASES = 10;
export const ALIAS_MAX = 40;
const TAG_PATTERN = /^[\p{L}\p{N}_-]{1,32}$/u;

function createEmptyStore(): ContactFile {
  return { version: 1, items: {} };
}

export function requireContactAddress(value: string, field = "address"): string {
  const address = normalizeContactAddress(value);
  if (!address) throw new InvalidArgumentError(`${field} must be an e-mail address.`);
  return address;
}

function normalizeTag(value: string): string {
  const tag = value.trim().toLowerCase();
  if (!TAG_PATTERN.test(tag)) throw new InvalidArgumentError(`"${value.slice(0, 40)}" is not a tag: use 1-32 letters, digits, "-" or "_", for example vip.`);
  return tag;
}

function normalizeAliases(values: string[]): string[] {
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const value of values) {
    const alias = cleanContactText(value, 1000);
    if (!alias) throw new InvalidArgumentError("An alias cannot be empty.");
    if (alias.includes("@")) throw new InvalidArgumentError(`"${alias.slice(0, 40)}" is not an alias: an alias is a name or nickname, not an address (no "@").`);
    if (alias.length > ALIAS_MAX) throw new InvalidArgumentError(`"${alias.slice(0, 40)}..." is too long for an alias: use at most ${ALIAS_MAX} characters.`);
    const key = foldText(alias);
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
  }
  if (aliases.length > MAX_ALIASES) throw new InvalidArgumentError(`A person can have at most ${MAX_ALIASES} aliases.`);
  return aliases;
}

function says(record: ContactRecord): boolean {
  return record.addresses.length > 1 || Boolean(record.displayName || record.org || record.notes || record.tags?.length || record.aliases?.length);
}

function personLabel(record: ContactRecord): string {
  return record.displayName ? `${record.displayName} (${record.addresses[0]})` : record.addresses[0];
}

// Aliases and display names of two people must not collide (either way round): a nickname that is another person's name
// would send mail meant for them to someone else.
function assertAliasesFree(store: ContactFile, record: ContactRecord, aliases: string[]): void {
  const others = Object.values(store.items).filter((entry) => entry.id !== record.id);
  for (const alias of aliases) {
    const key = foldText(alias);
    const owner = others.find((entry) => entry.aliases?.some((used) => foldText(used) === key));
    if (owner) throw new InvalidArgumentError(`The alias "${alias}" is already used by ${personLabel(owner)}. Remove it there first, or pick another alias.`);
    const named = others.find((entry) => entry.displayName && foldText(entry.displayName) === key);
    if (named) throw new InvalidArgumentError(`The alias "${alias}" is the name of ${personLabel(named)}; an alias that is another person's name would send mail meant for them to this person. Pick another alias.`);
  }
}

function assertNameFree(store: ContactFile, record: ContactRecord, name: string): void {
  const key = foldText(name);
  const owner = Object.values(store.items).find((entry) => entry.id !== record.id && entry.aliases?.some((used) => foldText(used) === key));
  if (owner) throw new InvalidArgumentError(`The name "${name}" is an alias of ${personLabel(owner)}; a name that is another person's alias would send mail meant for them to this person. Pick another name, or remove the alias there first.`);
}

function recordOf(store: ContactFile, address: string): ContactRecord | undefined {
  return Object.values(store.items).find((record) => record.addresses.includes(address));
}

export class ContactService {
  private readonly storePath: string;
  private _lock: Promise<void> = Promise.resolve();
  private identityChecked = false;

  constructor(
    private readonly config: ProtonMailConfig,
    private readonly log: Logger = logger,
  ) {
    this.storePath = join(this.config.dataDir, "contacts.json");
  }

  async list(): Promise<ContactRecord[]> {
    return Object.values((await this.load()).items);
  }

  /** The person an address belongs to, if the store has one. */
  async recordFor(address: string): Promise<ContactRecord | undefined> {
    const normalized = normalizeContactAddress(address);
    return normalized ? recordOf(await this.load(), normalized) : undefined;
  }

  async tagsFor(address: string): Promise<string[]> {
    const normalized = normalizeContactAddress(address);
    if (!normalized) return [];
    return recordOf(await this.load(), normalized)?.tags ?? [];
  }

  /** Applies the patch to the person `address` belongs to. Returns the record now holding `address` (none when nothing is stored for it) and, after an unmerge, the record it was split from. */
  async update(address: string, patch: ContactPatch): Promise<{ contact?: ContactRecord; splitFrom?: ContactRecord }> {
    const target = requireContactAddress(address);
    const addTags = (patch.addTags ?? []).map(normalizeTag);
    const removeTags = (patch.removeTags ?? []).map(normalizeTag);
    const aliases = patch.aliases !== undefined ? normalizeAliases(patch.aliases) : undefined;
    const mergeWith = patch.mergeWith !== undefined ? requireContactAddress(patch.mergeWith, "mergeWith") : undefined;
    if (mergeWith === target) throw new InvalidArgumentError("mergeWith must be another address than address.");
    if (patch.unmerge && (mergeWith || addTags.length || removeTags.length || patch.notes !== undefined)) {
      throw new InvalidArgumentError("unmerge is done on its own; only displayName and aliases may be given with it (see below). Change the other fields in a second call.");
    }
    return this.withLock(async () => {
      const store = await this.loadUnlocked();
      const now = new Date().toISOString();
      const existing = recordOf(store, target);

      if (patch.unmerge) {
        if (!existing || existing.addresses.length < 2) throw new InvalidArgumentError(`${target} is not merged with another address.`);
        const staying = existing.addresses.filter((entry) => entry !== target);
        // The name and aliases stay with the addresses that remain in the record. Splitting one address out must not leave
        // them quietly on whoever is left (after the real address of "Boss" is split out, a merged-in address would be "Boss"):
        // the call has to say what the remaining person is called, or clear it.
        if ((existing.displayName && patch.displayName === undefined) || (existing.aliases?.length && aliases === undefined)) {
          const held = [existing.displayName ? `the name "${existing.displayName}"` : "", existing.aliases?.length ? `the aliases ${existing.aliases.map((alias) => `"${alias}"`).join(", ")}` : ""].filter(Boolean).join(" and ");
          throw new InvalidArgumentError(`${staying.join(", ")} would keep ${held}. Say who they are: pass displayName and aliases in the same call (the current values to keep them, or null and [] to clear them).`);
        }
        if (patch.displayName !== undefined) {
          const name = patch.displayName === null ? "" : cleanContactText(patch.displayName, CONTACT_NAME_MAX);
          if (name) assertNameFree(store, existing, name);
          if (name) existing.displayName = name;
          else delete existing.displayName;
          delete existing.displayNameFrom;
        }
        if (aliases !== undefined) {
          assertAliasesFree(store, existing, aliases);
          if (aliases.length) existing.aliases = aliases;
          else delete existing.aliases;
        }
        existing.addresses = staying;
        existing.updatedAt = now;
        if (!says(existing)) delete store.items[existing.id];
        await this.save(store);
        return { splitFrom: says(existing) ? existing : undefined };
      }

      const record: ContactRecord = existing ?? { id: randomUUID(), addresses: [target], createdAt: now, updatedAt: now };
      if (mergeWith && !record.addresses.includes(mergeWith)) {
        const other = recordOf(store, mergeWith);
        const addresses = [...new Set([...record.addresses, ...(other?.addresses ?? [mergeWith])])];
        if (addresses.length > MAX_ADDRESSES) throw new InvalidArgumentError(`A person can have at most ${MAX_ADDRESSES} addresses.`);
        record.addresses = addresses;
        if (other) {
          if (!record.displayName && other.displayName) {
            record.displayName = other.displayName;
            if (other.displayNameFrom) record.displayNameFrom = other.displayNameFrom;
          }
          record.org ??= other.org;
          const tags = [...new Set([...(record.tags ?? []), ...(other.tags ?? [])])];
          if (tags.length) record.tags = tags.slice(0, MAX_TAGS);
          const merged = [...new Map([...(record.aliases ?? []), ...(other.aliases ?? [])].map((alias) => [foldText(alias), alias])).values()];
          // A merge never drops an alias quietly: when they do not all fit (and the call does not replace the list), it is refused.
          if (merged.length > MAX_ALIASES && aliases === undefined) {
            const overflow = merged.slice(MAX_ALIASES).map((alias) => `"${alias}"`).join(", ");
            throw new InvalidArgumentError(`Merging would give this person ${merged.length} aliases and at most ${MAX_ALIASES} are allowed; ${overflow} would not fit. Remove aliases from one of them first (or pass aliases in this call to set the list yourself).`);
          }
          if (merged.length) record.aliases = merged.slice(0, MAX_ALIASES);
          const notes = [record.notes, other.notes].filter(Boolean).join("\n\n");
          if (notes) record.notes = notes.slice(0, CONTACT_NOTES_MAX);
          delete store.items[other.id];
        }
      }
      if (patch.displayName !== undefined) {
        const name = patch.displayName === null ? "" : cleanContactText(patch.displayName, CONTACT_NAME_MAX);
        if (name) assertNameFree(store, record, name);
        if (name) record.displayName = name;
        else delete record.displayName;
        delete record.displayNameFrom;
      }
      if (patch.notes !== undefined) {
        const notes = patch.notes === null ? "" : cleanContactText(patch.notes, CONTACT_NOTES_MAX, true);
        if (notes) record.notes = notes;
        else delete record.notes;
      }
      if (aliases !== undefined) {
        assertAliasesFree(store, record, aliases);
        if (aliases.length) record.aliases = aliases;
        else delete record.aliases;
      }
      if (addTags.length || removeTags.length) {
        const tags = [...new Set([...(record.tags ?? []), ...addTags])].filter((tag) => !removeTags.includes(tag));
        if (tags.length > MAX_TAGS) throw new InvalidArgumentError(`A person can have at most ${MAX_TAGS} tags.`);
        if (tags.length) record.tags = tags;
        else delete record.tags;
      }
      record.updatedAt = now;
      if (says(record)) {
        if (!existing && Object.keys(store.items).length >= MAX_CONTACTS) throw new InvalidArgumentError(`The contact store is full (${MAX_CONTACTS} people).`);
        store.items[record.id] = record;
      } else {
        delete store.items[record.id];
      }
      await this.save(store);
      return { contact: says(record) ? record : undefined };
    });
  }

  /** Adds the people of a vCard file. Fills only what is not set yet. A card that names a known person never adds an address to them: a file could otherwise give its own address that person's tags (vip changes the autoresponder). */
  async importCards(cards: ParsedVCard[]): Promise<ContactImportOutcome> {
    return this.withLock(async () => {
      const store = await this.loadUnlocked();
      const now = new Date().toISOString();
      const outcome: ContactImportOutcome = { added: 0, updated: 0, unchanged: 0, conflicts: [], conflictCount: 0, overLimit: 0 };
      // Thousands of cards against thousands of records: looked up in a map, not by scanning the store per address.
      const byAddress = new Map<string, ContactRecord>();
      for (const record of Object.values(store.items)) for (const address of record.addresses) byAddress.set(address, record);
      for (const card of cards) {
        const owners = card.emails.map((address) => byAddress.get(address));
        const existing = owners.find(Boolean);
        if (!existing && Object.keys(store.items).length >= MAX_CONTACTS) {
          outcome.overLimit += 1;
          continue;
        }
        const record: ContactRecord = existing ?? { id: randomUUID(), addresses: [], createdAt: now, updatedAt: now };
        const before = JSON.stringify(record);
        card.emails.forEach((address, index) => {
          if (existing && owners[index] !== record) {
            outcome.conflictCount += 1;
            if (outcome.conflicts.length < 20) outcome.conflicts.push(address);
          } else if (!record.addresses.includes(address) && record.addresses.length < MAX_ADDRESSES) {
            record.addresses.push(address);
          }
        });
        if (card.name && !record.displayName) {
          record.displayName = cleanContactText(card.name, CONTACT_NAME_MAX);
          if (record.displayName) record.displayNameFrom = "import";
        }
        if (card.org && !record.org) record.org = cleanContactText(card.org, CONTACT_ORG_MAX);
        if (card.note && !record.notes) record.notes = cleanContactText(card.note, CONTACT_NOTES_MAX, true);
        if (record.addresses.length === 0 || !says(record)) {
          outcome.unchanged += 1;
          continue;
        }
        if (JSON.stringify(record) === before) {
          outcome.unchanged += 1;
          continue;
        }
        record.updatedAt = now;
        store.items[record.id] = record;
        for (const address of record.addresses) byAddress.set(address, record);
        if (existing) outcome.updated += 1;
        else outcome.added += 1;
      }
      if (outcome.added || outcome.updated) await this.save(store);
      return outcome;
    });
  }

  // See TemplateService.withLock: the in-process chain plus a lock across processes sharing this dataDir.
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const locked = () => withFileLock(this.storePath, fn);
    const run = this._lock.then(locked, locked);
    this._lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async load(): Promise<ContactFile> {
    return this.withLock(() => this.loadUnlocked());
  }

  private async loadUnlocked(): Promise<ContactFile> {
    if (!this.identityChecked) {
      await ensureAccountIdentityMatches(this.config.dataDir, this.config.smtp.username);
      this.identityChecked = true;
    }
    await this.cleanOrphanedTempFiles();
    try {
      const parsed = JSON.parse(await readRegularFile(this.storePath)) as ContactFile;
      if (!parsed || typeof parsed.items !== "object" || parsed.items === null || Array.isArray(parsed.items)) throw new Error("contacts.json has no items object");
      // A hand-edited record without a list of addresses would break every lookup; it is left out.
      const items: Record<string, ContactRecord> = Object.create(null);
      for (const [id, record] of Object.entries(parsed.items)) {
        if (!record || !Array.isArray(record.addresses)) continue;
        // A hand-edited store: a name or alias is cleaned like one set through the tools (no control, bidi or invisible
        // characters, one line), and an alias is dropped when it is not text, is empty after that, or is too long.
        if (record.displayName !== undefined) {
          const name = typeof record.displayName === "string" ? cleanContactText(record.displayName, CONTACT_NAME_MAX) : "";
          if (name) record.displayName = name;
          else delete record.displayName;
        }
        if (record.aliases !== undefined) {
          const usable = Array.isArray(record.aliases)
            ? record.aliases.flatMap((alias) => {
                const cleaned = typeof alias === "string" ? cleanContactText(alias, 1000) : "";
                return cleaned && cleaned.length <= ALIAS_MAX && !cleaned.includes("@") ? [cleaned] : [];
              })
            : [];
          if (usable.length) record.aliases = usable;
          else delete record.aliases;
        }
        items[id] = record;
      }
      return { ...createEmptyStore(), ...parsed, items };
    } catch (error) {
      if (isFileNotFound(error)) return createEmptyStore();
      setAsideCorruptStore(this.storePath, error, this.log, "ContactService");
      return createEmptyStore();
    }
  }

  private async cleanOrphanedTempFiles(): Promise<void> {
    const dir = dirname(this.storePath);
    try {
      const entries = await readdir(dir);
      const tmpFiles = entries.filter((name) => name.startsWith("contacts.json") && name.endsWith(".tmp"));
      await Promise.all(
        tmpFiles.map((name) =>
          unlink(join(dir, name)).catch((err) => {
            this.log.warn(`Failed to remove orphaned temp file: ${name}`, "ContactService", err);
          }),
        ),
      );
    } catch {
      // Directory may not exist yet — ignore.
    }
  }

  private async save(store: ContactFile): Promise<void> {
    await mkdir(dirname(this.storePath), { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.storePath, JSON.stringify(store, null, 2));
  }
}
