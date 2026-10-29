import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { isFileNotFound, setAsideCorruptStore } from "../utils/corrupt-store.js";
import { withFileLock } from "../utils/file-lock.js";
import { InvalidArgumentError } from "../utils/helpers.js";
import { logger } from "../utils/logger.js";
import { assessMail } from "../utils/mail-security.js";

// Inbox categories the user defines, per account. Proton's own categories are a fixed set sorted on Proton's servers,
// and what they decided is not visible over IMAP; these are the user's: a name, a description in their own words and
// the signals that put mail in it. Sorting follows rules a person can check (the sender, list headers, words in the
// subject, Reply-To, whether you have written to the sender, what you corrected before), never a model, and every
// verdict comes with its reasons. Mail text is only ever compared, literally, with the user's own keywords: a subject
// cannot change a category, a weight or the rules, and the reasons never quote it.

export interface CategoryDefinition {
  name: string;
  /** The user's own words for what belongs here. Shown, never used for sorting. */
  description?: string;
  /** Addresses, or "@example.com" for a domain and its subdomains. */
  senders?: string[];
  /** Words the subject has a word starting with (any case). */
  keywords?: string[];
  /** true: only list or bulk mail; false: only mail from people. */
  automated?: boolean;
  /** Counts when you have written to the sender before. */
  knownContact?: boolean;
  /** Label (a Labels/ folder) added when the category is applied. */
  label?: string;
  createdAt: string;
  updatedAt?: string;
}

/** One sender's weight towards one category, taught by corrections. */
export interface LearnedWeight {
  sender: string;
  category: string;
  weight: number;
  at: string;
}

interface CategoryState {
  categories: CategoryDefinition[];
  // A list, not a map keyed by address: a sender address comes from mail and must not become an object key.
  learned: LearnedWeight[];
}

export interface MessageSignals {
  from: string;
  replyTo?: string;
  subject: string;
  automated?: boolean;
  knownContact?: boolean;
  /** Set when Authentication-Results reports a failure (e.g. "dmarc=fail"): who the sender is is then not trusted. */
  authFailure?: string;
}

export interface CategoryVerdict {
  category: string | null;
  score: number;
  reasons: string[];
  /** The winner leaned on who the sender is, so the sender's authentication is worth checking. */
  senderBased: boolean;
  runnerUp?: { category: string; score: number };
}

// Proton Mail's own categories (proton.me/support/mail-categories). A user category or label with one of these names
// is separate from Proton's and is reported as a clash; nothing here can see or change Proton's sorting.
export const PROTON_CATEGORIES = ["Primary", "Social", "Promotions", "Newsletters", "Transactions", "Updates"];

export const MAX_CATEGORIES = 30;
const MAX_LEARNED = 2000;
const MAX_SUBJECT_SCANNED = 1000;
const MAX_KEYWORDS_COUNTED = 2;
export const MIN_SCORE = 2;
const SCORE = { learned: 10, senderAddress: 6, senderDomain: 5, replyTo: 3, keyword: 3, automated: 2, knownContact: 4 };

type Draft = Omit<CategoryDefinition, "createdAt" | "updatedAt">;

// Offered only when the user asks for it.
export const STARTER_CATEGORIES: Draft[] = [
  {
    name: "Receipts",
    description: "Receipts, invoices, orders, bookings and payment confirmations.",
    keywords: ["receipt", "invoice", "order", "payment", "purchase", "booking", "faktur", "rachun", "paragon", "zamówieni", "płatnoś", "rechnung", "quittung", "bestellung", "zahlung"],
  },
  { name: "Newsletters", description: "Newsletters, digests and other mail you subscribed to.", automated: true, keywords: ["newsletter", "digest", "weekly", "edition"] },
  {
    name: "Social",
    description: "Notifications from social networks.",
    senders: ["@facebookmail.com", "@linkedin.com", "@x.com", "@twitter.com", "@instagram.com", "@redditmail.com", "@discord.com", "@pinterest.com", "@tiktok.com", "@mastodon.social"],
  },
  {
    name: "Updates",
    description: "Automatic notices: account and security alerts, shipping, reminders.",
    automated: true,
    keywords: ["alert", "security", "sign-in", "login", "password", "verify", "verification", "confirm", "shipped", "delivery", "reminder", "notification", "powiadomieni", "przesyłk", "benachrichtigung", "lieferung"],
  },
  { name: "People", description: "Mail written to you by a person.", automated: false, knownContact: true },
];

const key = (name: string) => name.trim().toLowerCase();
const WORD_CHAR = /[\p{L}\p{N}]/u;
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** Keywords that start a word in the subject (case-insensitive), in the order they were defined. */
function matchingKeywords(keywords: string[] | undefined, subject: string): string[] {
  const hay = subject.slice(0, MAX_SUBJECT_SCANNED).toLowerCase();
  const found: string[] = [];
  for (const keyword of keywords ?? []) {
    const needle = keyword.toLowerCase();
    for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
      if (at === 0 || !WORD_CHAR.test(hay[at - 1])) {
        found.push(keyword);
        break;
      }
    }
  }
  return found;
}

function matchSender(patterns: string[] | undefined, address: string): { pattern: string; exact: boolean } | undefined {
  if (!address.includes("@")) return undefined;
  const domain = address.slice(address.lastIndexOf("@") + 1);
  const list = patterns ?? [];
  const exact = list.find((pattern) => !pattern.includes("*") && !pattern.startsWith("@") && pattern.toLowerCase() === address);
  if (exact) return { pattern: exact, exact: true };
  for (const pattern of list) {
    const lower = pattern.toLowerCase();
    if (!lower.startsWith("@") && !lower.startsWith("*@")) continue;
    const wanted = lower.slice(lower.indexOf("@") + 1);
    if (domain === wanted || domain.endsWith(`.${wanted}`)) return { pattern, exact: false };
  }
  return undefined;
}

/** Which category a message belongs to and why. Pure: the same definitions, weights and message give the same verdict. */
export function classifyMessage(categories: CategoryDefinition[], learned: LearnedWeight[], message: MessageSignals): CategoryVerdict {
  const from = message.from.trim().toLowerCase();
  const replyTo = message.replyTo?.trim().toLowerCase();
  const trustSender = !message.authFailure;
  const weights = new Map(learned.filter((entry) => entry.sender === from).map((entry) => [entry.category, entry.weight]));
  const scored: Array<{ name: string; score: number; senderScore: number; reasons: string[] }> = [];
  for (const category of categories) {
    const reasons: string[] = [];
    let score = 0;
    let senderScore = 0;
    const learnedWeight = trustSender ? (weights.get(key(category.name)) ?? 0) : 0;
    if (learnedWeight > 0) {
      score += learnedWeight * SCORE.learned;
      senderScore += learnedWeight * SCORE.learned;
      reasons.push(`you put mail from ${from} in ${category.name} (${learnedWeight} correction${learnedWeight === 1 ? "" : "s"})`);
    }
    if (category.automated !== undefined && message.automated !== undefined) {
      if (category.automated === message.automated) {
        score += SCORE.automated;
        reasons.push(category.automated ? "list or bulk mail (List-Unsubscribe, List-Id or Precedence header)" : "written by a person (no list or bulk headers)");
      } else if (learnedWeight === 0) {
        continue;
      }
    }
    if (trustSender) {
      const sender = matchSender(category.senders, from);
      if (sender) {
        const points = sender.exact ? SCORE.senderAddress : SCORE.senderDomain;
        score += points;
        senderScore += points;
        reasons.push(`sender ${from} matches ${sender.pattern}`);
      } else if (replyTo && replyTo !== from) {
        const viaReplyTo = matchSender(category.senders, replyTo);
        if (viaReplyTo) {
          score += SCORE.replyTo;
          senderScore += SCORE.replyTo;
          reasons.push(`Reply-To ${replyTo} matches ${viaReplyTo.pattern}`);
        }
      }
      if (category.knownContact && message.knownContact) {
        score += SCORE.knownContact;
        senderScore += SCORE.knownContact;
        reasons.push(`you have written to ${from} before`);
      }
    }
    for (const keyword of matchingKeywords(category.keywords, message.subject).slice(0, MAX_KEYWORDS_COUNTED)) {
      score += SCORE.keyword;
      reasons.push(`subject contains "${keyword}"`);
    }
    if (score >= MIN_SCORE) scored.push({ name: category.name, score, senderScore, reasons });
  }
  // Highest score wins; a tie goes to the category defined first.
  const ranked = scored.map((entry, index) => ({ ...entry, index })).sort((a, b) => b.score - a.score || a.index - b.index);
  const distrust = message.authFailure ? [`who the sender is was not used: the message failed ${message.authFailure}`] : [];
  const [best, second] = ranked;
  if (!best) return { category: null, score: 0, reasons: [...distrust, "no signal of any category matched"], senderBased: false };
  return {
    category: best.name,
    score: best.score,
    reasons: [...best.reasons, ...distrust],
    senderBased: best.senderScore > 0,
    ...(second ? { runnerUp: { category: second.name, score: second.score } } : {}),
  };
}

/** What a failing Authentication-Results says ("dmarc=fail"), or undefined when nothing failed or it is absent. */
export function authFailureOf(authenticationResults: string | undefined): string | undefined {
  const failed = [...(authenticationResults ?? "").slice(0, 4000).toLowerCase().matchAll(/\b(dkim|spf|dmarc)=fail\b/g)].map((match) => `${match[1]}=fail`);
  return failed.length ? [...new Set(failed)].join(", ") : undefined;
}

/** A note when a category or its label shares a name with one of Proton's own categories. */
export function protonClash(category: Pick<CategoryDefinition, "name" | "label">): string | undefined {
  const byName = PROTON_CATEGORIES.find((name) => key(name) === key(category.name));
  const byLabel = category.label ? PROTON_CATEGORIES.find((name) => key(name) === key(category.label as string)) : undefined;
  if (!byName && !byLabel) return undefined;
  const parts = [
    byName ? `Proton Mail has its own "${byName}" category; this one is separate, kept by this server, and Proton's sorting is neither visible nor changed here.` : "",
    byLabel ? `The label "${category.label}" is an ordinary label (Labels/${category.label}), not Proton's ${byLabel} category.` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

// ---- validation -----------------------------------------------------------------------------------------------

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new InvalidArgumentError(`${field} must be text.`);
  const clean = value.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  if (clean.length > max) throw new InvalidArgumentError(`${field} is longer than ${max} characters.`);
  return clean;
}

function list(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new InvalidArgumentError(`${field} must be a list of at most ${maxItems} entries.`);
  const items = value.map((entry) => text(entry, field, maxLength));
  if (items.some((entry) => !entry)) throw new InvalidArgumentError(`${field} has an empty entry.`);
  return [...new Set(items)];
}

const SENDER_PATTERN = /^(\*?@|[^\s@*]+@)[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/**
 * Checks a definition (a new one, or the fields that change on an existing one). An empty list or an empty label
 * clears that field. Text that reads like an instruction to an AI is refused: categories are described in plain words.
 */
export function validateCategory(raw: Record<string, unknown>, existing?: CategoryDefinition): Draft {
  const name = existing?.name ?? text(raw.name, "name", 60);
  if (!name) throw new InvalidArgumentError("A category needs a name.");
  const draft: Draft = existing ? { ...existing } : { name };
  delete (draft as Partial<CategoryDefinition>).createdAt;
  delete (draft as Partial<CategoryDefinition>).updatedAt;
  if (raw.description !== undefined) draft.description = text(raw.description, "description", 300) || undefined;
  if (raw.senders !== undefined) {
    const senders = list(raw.senders, "senders", 50, 100);
    const bad = senders.find((entry) => !SENDER_PATTERN.test(entry));
    if (bad) throw new InvalidArgumentError(`senders: "${bad}" is not an address or a domain written as @example.com.`);
    draft.senders = senders.length ? senders : undefined;
  }
  if (raw.keywords !== undefined) {
    const keywords = list(raw.keywords, "keywords", 30, 60);
    draft.keywords = keywords.length ? keywords : undefined;
  }
  for (const field of ["automated", "knownContact"] as const) {
    if (raw[field] === undefined) continue;
    if (typeof raw[field] !== "boolean") throw new InvalidArgumentError(`${field} must be true or false.`);
    draft[field] = raw[field] as boolean;
  }
  if (raw.label !== undefined) {
    const label = text(raw.label, "label", 100).replace(/^Labels\//i, "");
    if (label && (/^\/|\/$/.test(label) || label.split("/").includes(".."))) throw new InvalidArgumentError("label must be a label name such as Receipts.");
    draft.label = label || undefined;
  }
  const words = [draft.name, draft.description ?? "", ...(draft.keywords ?? [])].join("\n");
  const verdict = assessMail({ text: words });
  if (verdict.level === "high") {
    throw new InvalidArgumentError(`The category reads like an instruction to an AI (${verdict.reasons.join(" ")}). Describe what mail belongs in it, in plain words.`);
  }
  for (const field of Object.keys(draft) as Array<keyof Draft>) if (draft[field] === undefined) delete draft[field];
  return draft;
}

// ---- store ----------------------------------------------------------------------------------------------------

export class CategoryService {
  private readonly storePath: string;

  constructor(options: { dataDir: string }) {
    this.storePath = join(options.dataDir, "categories.json");
  }

  async list(): Promise<CategoryState> {
    return this.load();
  }

  async find(name: string): Promise<CategoryDefinition | undefined> {
    return (await this.load()).categories.find((category) => key(category.name) === key(name));
  }

  /** Creates the category, or changes the fields given on the one with that name. */
  async define(raw: Record<string, unknown>, now = new Date()): Promise<{ category: CategoryDefinition; created: boolean }> {
    return this.withLock(async () => {
      const state = await this.load();
      const wanted = typeof raw.name === "string" ? key(raw.name) : "";
      const index = state.categories.findIndex((category) => key(category.name) === wanted);
      const existing = index === -1 ? undefined : state.categories[index];
      if (!existing && state.categories.length >= MAX_CATEGORIES) throw new InvalidArgumentError(`At most ${MAX_CATEGORIES} categories per account.`);
      const draft = validateCategory(raw, existing);
      const category: CategoryDefinition = existing ? { ...draft, createdAt: existing.createdAt, updatedAt: now.toISOString() } : { ...draft, createdAt: now.toISOString() };
      if (existing) state.categories[index] = category;
      else state.categories.push(category);
      await this.save(state);
      return { category, created: !existing };
    });
  }

  /** Adds definitions (the starter set, or another account's), leaving any category with the same name as it is. */
  async addAll(drafts: Draft[], now = new Date()): Promise<{ added: string[]; skipped: string[] }> {
    return this.withLock(async () => {
      const state = await this.load();
      const added: string[] = [];
      const skipped: string[] = [];
      for (const draft of drafts) {
        if (state.categories.some((category) => key(category.name) === key(draft.name)) || state.categories.length >= MAX_CATEGORIES) {
          skipped.push(draft.name);
          continue;
        }
        state.categories.push({ ...validateCategory({ ...draft }), createdAt: now.toISOString() });
        added.push(draft.name);
      }
      await this.save(state);
      return { added, skipped };
    });
  }

  /**
   * A correction: mail from `sender` belongs in `category`. Its weight goes up by one and the sender's weight towards
   * every other category down by one, so the latest correction wins over an older one.
   */
  async learn(sender: string, category: string, now = new Date()): Promise<LearnedWeight[]> {
    return this.withLock(async () => {
      const state = await this.load();
      const who = sender.trim().toLowerCase();
      const target = key(category);
      const mine = state.learned.filter((entry) => entry.sender === who);
      const others = state.learned.filter((entry) => entry.sender !== who);
      const next = mine.map((entry) => (entry.category === target ? entry : { ...entry, weight: entry.weight - 1 })).filter((entry) => entry.weight > 0);
      const current = next.find((entry) => entry.category === target);
      if (current) Object.assign(current, { weight: current.weight + 1, at: now.toISOString() });
      else next.push({ sender: who, category: target, weight: 1, at: now.toISOString() });
      // The oldest corrections make room first.
      state.learned = [...others, ...next].sort((a, b) => a.at.localeCompare(b.at)).slice(-MAX_LEARNED);
      await this.save(state);
      return next;
    });
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.storePath), { recursive: true, mode: 0o700 });
    return withFileLock(this.storePath, fn);
  }

  private async load(): Promise<CategoryState> {
    try {
      const parsed = JSON.parse(await readFile(this.storePath, "utf8")) as Partial<CategoryState>;
      return { categories: Array.isArray(parsed.categories) ? parsed.categories : [], learned: Array.isArray(parsed.learned) ? parsed.learned : [] };
    } catch (error) {
      if (isFileNotFound(error)) return { categories: [], learned: [] };
      setAsideCorruptStore(this.storePath, error, logger, "CategoryService");
      return { categories: [], learned: [] };
    }
  }

  private async save(state: CategoryState): Promise<void> {
    await writeFileAtomic(this.storePath, JSON.stringify(state, null, 2));
  }
}
