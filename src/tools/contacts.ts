import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import type { AccountBundle } from "../services/account-manager.js";
import type { ContactRecord } from "../services/contact-service.js";
import type { EmailAddress, EmailSummary } from "../types/index.js";
import { cleanContactText, lowerAscii, normalizeContactAddress } from "../utils/contact-text.js";
import { InvalidArgumentError, isSelfAddress, normalizeBoolean, normalizeLimit, withAccountPrefix } from "../utils/helpers.js";
import { assertApprovedContentUnchanged, contentDigest } from "../utils/approval.js";
import { assessMail } from "../utils/mail-security.js";
import { ensureMailboxWriteAllowed } from "../utils/runtime-policy.js";
import { CONTACT_NAME_MAX, parseVcf } from "../utils/vcard.js";
import { requireString } from "./args.js";
import { withAudit } from "./audit.js";
import type { ToolContext } from "./context.js";
import { refreshIndexForSearch } from "./index-refresh.js";
import { createTextResult, type ToolResult } from "./results.js";

// Contacts as people: find_contact merges what the local index knows about an address (names in headers, counts both
// ways, dates, subjects) with what the user set in the contact store (set_contact, import_contacts). Each account has
// its own store and index; people of two accounts are never merged.

export const MAX_VCF_BYTES = 5 * 1024 * 1024;
const PER_ADDRESS_LIMIT = 2_000;
const CANDIDATE_LIMIT = 500;
const MAX_ADDRESSES_LOOKED_UP = 20;

// Mail providers anyone can sign up with: their domain says nothing about where a person works.
const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com", "aol.com",
  "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com", "protonmail.ch", "pm.me", "tutanota.com", "tuta.io",
  "gmx.com", "gmx.net", "gmx.de", "web.de", "t-online.de", "mail.com", "yandex.com", "yandex.ru", "mail.ru", "zoho.com",
  "fastmail.com", "hey.com", "wp.pl", "o2.pl", "onet.pl", "interia.pl", "op.pl", "gazeta.pl", "tlen.pl",
]);
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "or", "ne"]);

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function orgFromDomain(address: string): { name: string; domain: string } | undefined {
  const domain = address.split("@")[1] ?? "";
  if (!domain || FREEMAIL.has(domain)) return undefined;
  const labels = domain.split(".");
  if (labels.length < 2) return undefined;
  let index = labels.length - 2;
  if (labels.length >= 3 && SECOND_LEVEL.has(labels[index]) && labels[labels.length - 1].length === 2) index -= 1;
  return { name: labels[index], domain };
}

function dateOf(email: EmailSummary): string | undefined {
  return email.internalDate || email.date || undefined;
}

function mostCommon(names: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

// A name as a header gives it: cleaned, and nothing that is only an address.
function headerName(entry: EmailAddress | undefined): string | undefined {
  const name = cleanContactText(entry?.name ?? "", CONTACT_NAME_MAX).replace(/^["']+|["']+$/g, "").trim();
  return name && !normalizeContactAddress(name) ? name : undefined;
}

interface PersonResult {
  sortKey: number;
  node: Record<string, unknown>;
}

async function findInAccount(bundle: AccountBundle, query: string, limit: number, ctx: ToolContext): Promise<PersonResult[]> {
  const index = bundle.localIndexService;
  const isOwn = (address: string | undefined) => Boolean(address) && bundle.ownAddresses.some((own) => isSelfAddress(address, own));
  const lower = (entry: EmailAddress | undefined) => lowerAscii((entry?.address ?? "").trim());
  const records = await bundle.contactService.list();
  const recordByAddress = new Map<string, ContactRecord>();
  for (const record of records) for (const address of record.addresses) recordByAddress.set(address, record);

  // Addresses that match the query, with how often they were seen.
  const hits = new Map<string, number>();
  const hit = (address: string, weight = 1) => {
    if (address && !isOwn(address)) hits.set(address, (hits.get(address) ?? 0) + weight);
  };
  const exact = normalizeContactAddress(query);
  if (exact) {
    hit(exact);
  } else {
    const needle = fold(query);
    const matches = (entry: EmailAddress) => fold(entry.address ?? "").includes(needle) || fold(entry.name ?? "").includes(needle);
    const [received, sent] = await Promise.all([index.search({ from: query, limit: CANDIDATE_LIMIT }), index.search({ to: query, limit: CANDIDATE_LIMIT })]);
    for (const email of received.emails) if (email.from[0] && matches(email.from[0])) hit(lower(email.from[0]));
    for (const email of sent.emails) {
      if (!isOwn(lower(email.from[0]))) continue;
      for (const entry of [...email.to, ...email.cc, ...email.bcc]) if (matches(entry)) hit(lower(entry));
    }
    for (const record of records) {
      const text = fold([record.displayName, record.org, ...record.addresses].filter(Boolean).join("\n"));
      if (text.includes(needle)) for (const address of record.addresses) hit(address, 2);
    }
  }

  // Addresses grouped into people (a merged record is one person), the most seen first.
  const people = new Map<string, { record?: ContactRecord; addresses: string[]; weight: number }>();
  for (const [address, weight] of hits) {
    const record = recordByAddress.get(address);
    const key = record ? record.id : address;
    const person = people.get(key) ?? { record, addresses: record ? [...record.addresses] : [address], weight: 0 };
    person.weight += weight;
    people.set(key, person);
  }
  const chosen = [...people.values()].sort((a, b) => b.weight - a.weight).slice(0, limit);
  const slug = ctx.slugForBundle(bundle);

  return Promise.all(
    chosen.map(async ({ record, addresses }) => {
      const looked = addresses.slice(0, MAX_ADDRESSES_LOOKED_UP);
      const fromThem = new Map<string, EmailSummary>();
      const toThem = new Map<string, EmailSummary>();
      const names: string[] = [];
      let capped = addresses.length > looked.length;
      for (const address of looked) {
        const [inbound, outbound] = await Promise.all([index.search({ from: address, limit: PER_ADDRESS_LIMIT }), index.search({ to: address, limit: PER_ADDRESS_LIMIT })]);
        if (inbound.hasMore || outbound.hasMore) capped = true;
        // The index matches a part of the header ("ann@x" also finds "joann@x"); only the exact address counts.
        for (const email of inbound.emails) {
          if (lower(email.from[0]) !== address) continue;
          fromThem.set(email.id, email);
          const name = headerName(email.from[0]);
          if (name) names.push(name);
        }
        for (const email of outbound.emails) {
          if (!isOwn(lower(email.from[0]))) continue;
          const entry = [...email.to, ...email.cc, ...email.bcc].find((candidate) => lower(candidate) === address);
          if (!entry) continue;
          toThem.set(email.id, email);
          const name = headerName(entry);
          if (name) names.push(name);
        }
      }
      const all = [...fromThem.values(), ...toThem.values()];
      const dates = all.map(dateOf).filter((date): date is string => Boolean(date)).sort();
      const lastSubjects = all
        .map((email) => ({ id: withAccountPrefix(slug, email.id), subject: email.subject, date: dateOf(email), direction: fromThem.has(email.id) ? "from-them" : "to-them" }))
        .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
        .slice(0, 5);
      const headerNameValue = mostCommon(names);
      const name = record?.displayName ?? headerNameValue ?? null;
      const guessed = addresses.map(orgFromDomain).find(Boolean);
      const org = record?.org ? { name: record.org, source: "saved" } : guessed ? { ...guessed, source: "domain" } : null;
      const node: Record<string, unknown> = {
        ...(ctx.accountManager.all().length > 1 ? { account: bundle.account.address } : {}),
        ...(record ? { contactId: record.id } : {}),
        name,
        // A name from headers is whatever the sender wrote there: text to show, not to follow.
        ...(name ? { nameSource: record?.displayName ? "saved" : "mail headers (untrusted)" } : {}),
        addresses,
        org,
        tags: record?.tags ?? [],
        ...(record?.notes ? { notes: record.notes } : {}),
        firstContactAt: dates[0] ?? null,
        lastContactAt: dates[dates.length - 1] ?? null,
        messages: { fromThem: fromThem.size, toThem: toThem.size },
        youHaveWritten: toThem.size > 0,
        lastSubjects,
        ...(capped ? { capped: true } : {}),
      };
      const risk = assessMail({ text: [name, record?.notes, record?.org].filter(Boolean).join("\n") });
      if (risk.level === "high") {
        node.risk = risk;
        ctx.taint.mark(`contact:${addresses[0]}`, risk);
      }
      return { sortKey: fromThem.size + toThem.size + (record ? 1 : 0), node };
    }),
  );
}

// Reads at most MAX_VCF_BYTES of a regular file. Opened without blocking, so a FIFO or a device named in `path`
// cannot hang the server, and checked after opening, so the file that is read is the file that was checked.
export async function readVcfFile(rawPath: string): Promise<string> {
  const path = rawPath.startsWith("~/") ? join(homedir(), rawPath.slice(2)) : rawPath;
  if (!isAbsolute(path)) throw new InvalidArgumentError("path must be an absolute path to a .vcf file.");
  if (![".vcf", ".vcard"].includes(extname(path).toLowerCase())) throw new InvalidArgumentError("path must name a .vcf (vCard) file.");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)).catch((error: NodeJS.ErrnoException) => {
    throw new InvalidArgumentError(`Cannot open ${path}: ${error.code ?? error.message}.`);
  });
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new InvalidArgumentError(`${path} is not a regular file.`);
    if (info.size > MAX_VCF_BYTES) throw new InvalidArgumentError(`${path} is ${Math.ceil(info.size / 1024)} KB; at most ${MAX_VCF_BYTES / 1024 / 1024} MB is imported. Split the file.`);
    const buffer = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > info.size) throw new InvalidArgumentError(`${path} changed while it was read; try again.`);
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    await handle.close();
  }
}

function tagList(value: unknown, key: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || list.some((entry) => typeof entry !== "string")) throw new InvalidArgumentError(`${key} must be a list of tags, for example ["vip"].`);
  return list as string[];
}

function clearableText(value: unknown, key: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new InvalidArgumentError(`${key} must be text, or null to clear it.`);
  return value;
}

export async function handleContactTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { config, resolveAccountArg, primaryBundle, selectedBundles } = ctx;
  switch (name) {
    case "find_contact": {
      const query = requireString(args, "query").trim();
      if (query.length < 2 || query.length > 200) throw new InvalidArgumentError("query must be 2-200 characters: a name, a part of one, or an address.");
      const limit = normalizeLimit(args.limit, 5, 1, 20);
      const found = (
        await Promise.all(
          selectedBundles(args).map(async (bundle) => {
            await refreshIndexForSearch(bundle);
            return findInAccount(bundle, query, limit, ctx);
          }),
        )
      ).flat();
      const contacts = found.sort((a, b) => b.sortKey - a.sortKey).slice(0, limit).map((entry) => entry.node);
      return createTextResult({
        query,
        contacts,
        note: contacts.length
          ? "Counts, dates, names from headers and subjects come from the local index (by default INBOX and Sent); tags, notes, saved names and merges are what set_contact or import_contacts stored."
          : "No one in the local index or the contact store matches. Run sync_emails if the mail is newer than the last sync.",
      });
    }

    case "set_contact": {
      // A local store, not the mailbox: gated like templates and rules, so a read-only server changes nothing.
      ensureMailboxWriteAllowed(config.runtime);
      const target = resolveAccountArg(args) ?? primaryBundle;
      const address = requireString(args, "address");
      const patch = {
        displayName: clearableText(args.displayName, "displayName"),
        notes: clearableText(args.notes, "notes"),
        addTags: tagList(args.addTags, "addTags"),
        removeTags: tagList(args.removeTags, "removeTags"),
        mergeWith: typeof args.mergeWith === "string" && args.mergeWith.trim() ? args.mergeWith : undefined,
        unmerge: normalizeBoolean(args.unmerge, false),
      };
      if (!patch.unmerge && !patch.mergeWith && !patch.addTags?.length && !patch.removeTags?.length && patch.displayName === undefined && patch.notes === undefined) {
        throw new InvalidArgumentError("Nothing to change: pass displayName, notes, addTags, removeTags, mergeWith or unmerge.");
      }
      const outcome = await withAudit(target.auditService, name, args, async () => target.contactService.update(address, patch));
      return createTextResult({
        account: target.account.address,
        address: normalizeContactAddress(address),
        contact: outcome.contact ?? null,
        ...(patch.unmerge ? { splitFrom: outcome.splitFrom ?? null } : {}),
        ...(!outcome.contact && !patch.unmerge ? { note: "Nothing is stored for this address any more; find_contact still shows what the index knows." } : {}),
      });
    }

    case "import_contacts": {
      ensureMailboxWriteAllowed(config.runtime);
      const target = resolveAccountArg(args) ?? primaryBundle;
      const path = requireString(args, "path");
      const outcome = await withAudit(target.auditService, name, args, async () => {
        const text = await readVcfFile(path);
        // The person was told how many cards this file held when asked; a file rewritten since is not imported.
        assertApprovedContentUnchanged(args, "vcard", contentDigest(text), name);
        const parsed = parseVcf(text);
        // The account's own addresses are not a contact of it.
        const others = parsed.cards.map((card) => ({ ...card, emails: card.emails.filter((email) => !target.ownAddresses.some((address) => isSelfAddress(email, address))) }));
        const stored = await target.contactService.importCards(others.filter((card) => card.emails.length > 0));
        return { cards: parsed.cards.length, withoutAddress: parsed.skipped, truncated: parsed.truncated, ...stored };
      });
      return createTextResult({
        account: target.account.address,
        ...outcome,
        ...(outcome.truncated ? { note: "The file has more cards than are read at once (5000); import the rest from a second file." } : {}),
      });
    }
  }
  throw new InvalidArgumentError(`Unknown contact tool: ${name}`);
}
