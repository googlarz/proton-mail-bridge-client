// How you write, worked out from your own sent mail: language, how you open and close, how long and how formal.
// Everything is counted on this machine; the profile keeps short normalised patterns ("Hi {name},"), never whole
// sentences or names, so it can be shown to a model as a hint for drafting.

export interface SentSample {
  to: string[];
  text: string;
}

export interface Counted {
  text: string;
  count: number;
}

export interface StyleSummary {
  messages: number;
  languages: Counted[];
  greetings: Counted[];
  closings: Counted[];
  formality: "formal" | "informal" | "mixed" | "unknown";
  medianWords: number;
  emojiRate: number;
  exclamationRate: number;
}

export interface StyleProfile {
  generatedAt: string;
  overall: StyleSummary;
  byRecipient: Record<string, StyleSummary>;
  byDomain: Record<string, StyleSummary>;
}

const GREETING = /^(hi|hello|hey|dear|good (?:morning|afternoon|evening)|cześć|dzień dobry|dobry wieczór|witam|szanown\p{L}*|hallo|guten (?:tag|morgen)|sehr geehrte\p{L}*|liebe\p{L}*|moin)(?![\p{L}])[^\n]{0,40}$/iu;
const CLOSING = /^(best(?: regards| wishes)?|kind regards|warm regards|regards|thanks|thank you|cheers|sincerely|pozdrawiam|z poważaniem|serdecznie|pozdrowienia|dzięki|dziękuję|z pozdrowieniami|mit freundlichen grüßen|viele grüße|beste grüße|freundliche grüße|grüße|lg)(?![\p{L}])[^\n]{0,30}$/iu;
const FORMAL_GREETING = /^(dear|szanown|sehr geehrte|dzień dobry|witam|guten tag|good (?:morning|afternoon|evening))/iu;
const INFORMAL_GREETING = /^(hi|hey|hello|cześć|hallo|moin)(?![\p{L}])/iu;
const FREEMAIL = new Set(["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "proton.me", "protonmail.com", "pm.me", "wp.pl", "o2.pl", "onet.pl", "interia.pl", "gmx.de", "web.de", "gmx.net"]);

const STOPWORDS: Record<string, string[]> = {
  en: ["the", "and", "is", "to", "of", "you", "for", "with", "that", "this", "have", "please"],
  pl: ["i", "w", "nie", "się", "na", "że", "do", "jest", "dla", "proszę", "dziękuję", "to", "jak", "ale"],
  de: ["und", "der", "die", "das", "nicht", "ich", "ist", "mit", "bitte", "danke", "für", "wir"],
};

function ownLines(text: string): string[] {
  const own = text.split(/\n(?:>|On .+ wrote:|W dniu .+ napisał|Am .+ schrieb|-----Original)/)[0] ?? text;
  return own.split(/\r?\n/).map((line) => line.trim());
}

function detectLanguage(text: string): string | undefined {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  let best: string | undefined;
  let bestScore = 2;
  for (const [language, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list);
    const score = words.filter((word) => set.has(word)).length;
    if (score > bestScore) [best, bestScore] = [language, score];
  }
  return best;
}

const GREETING_HEAD = /^(dear|hi|hello|hey|cześć|hallo|moin|witam|liebe\p{L}*|szanown\p{L}*|sehr geehrte\p{L}*|dzień dobry|guten (?:tag|morgen)|good (?:morning|afternoon|evening))(?![\p{L}])(\s+[\p{Lu}][\p{L}'’-]*(?:\s+[\p{Lu}][\p{L}'’-]*)*)?\s*([,!:]?)/iu;

// "Hi Pat," -> "Hi {name},": the capitalised words after the greeting are a name, and a name is not kept.
function normaliseGreeting(line: string): string {
  const match = GREETING_HEAD.exec(line);
  if (!match) return line.slice(0, 30);
  return `${match[1]}${match[2] ? " {name}" : ""}${match[3]}`;
}

function top(counter: Map<string, number>, n: number): Counted[] {
  return [...counter.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([text, count]) => ({ text, count }));
}

export function summarise(samples: SentSample[]): StyleSummary {
  const languages = new Map<string, number>();
  const greetings = new Map<string, number>();
  const closings = new Map<string, number>();
  const lengths: number[] = [];
  let formal = 0;
  let informal = 0;
  let emoji = 0;
  let exclamations = 0;
  for (const sample of samples) {
    const lines = ownLines(sample.text);
    const body = lines.join("\n");
    const language = detectLanguage(body);
    if (language) languages.set(language, (languages.get(language) ?? 0) + 1);
    const first = lines.find((line) => line.length > 0);
    if (first && GREETING.test(first)) {
      const greeting = normaliseGreeting(first);
      greetings.set(greeting, (greetings.get(greeting) ?? 0) + 1);
      if (FORMAL_GREETING.test(first)) formal += 1;
      else if (INFORMAL_GREETING.test(first)) informal += 1;
    }
    const tail = lines.filter((line) => line.length > 0).slice(-8);
    const closing = tail.find((line) => CLOSING.test(line));
    if (closing) closings.set(closing.replace(/[,.!]+$/, ""), (closings.get(closing.replace(/[,.!]+$/, "")) ?? 0) + 1);
    lengths.push((body.match(/\p{L}+/gu) ?? []).length);
    if (/\p{Extended_Pictographic}/u.test(body)) emoji += 1;
    if (body.includes("!")) exclamations += 1;
  }
  lengths.sort((a, b) => a - b);
  const n = samples.length || 1;
  return {
    messages: samples.length,
    languages: top(languages, 3),
    greetings: top(greetings, 3),
    closings: top(closings, 3),
    formality: formal === 0 && informal === 0 ? "unknown" : formal > informal * 2 ? "formal" : informal > formal * 2 ? "informal" : "mixed",
    medianWords: lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0,
    emojiRate: Math.round((emoji / n) * 100) / 100,
    exclamationRate: Math.round((exclamations / n) * 100) / 100,
  };
}

function domainOf(address: string): string {
  return address.split("@")[1]?.toLowerCase() ?? "";
}

export function buildProfile(samples: SentSample[], now = new Date()): StyleProfile {
  const byRecipient = new Map<string, SentSample[]>();
  const byDomain = new Map<string, SentSample[]>();
  for (const sample of samples) {
    for (const address of sample.to) {
      const lower = address.toLowerCase();
      byRecipient.set(lower, [...(byRecipient.get(lower) ?? []), sample]);
      const domain = domainOf(lower);
      if (domain && !FREEMAIL.has(domain)) byDomain.set(domain, [...(byDomain.get(domain) ?? []), sample]);
    }
  }
  const pick = (map: Map<string, SentSample[]>, min: number) =>
    Object.fromEntries([...map.entries()].filter(([, list]) => list.length >= min).sort((a, b) => b[1].length - a[1].length).slice(0, 25).map(([key, list]) => [key, summarise(list)]));
  return { generatedAt: now.toISOString(), overall: summarise(samples), byRecipient: pick(byRecipient, 2), byDomain: pick(byDomain, 3) };
}

/** A few plain lines a model can follow when drafting for `recipient`. */
export function styleHints(profile: StyleProfile, recipient?: string): string[] {
  const address = recipient?.toLowerCase();
  const summary = (address && profile.byRecipient[address]) || (address && profile.byDomain[domainOf(address)]) || profile.overall;
  const scope = summary === profile.overall ? "in general" : address && profile.byRecipient[address] ? `to ${address}` : `to ${domainOf(address ?? "")}`;
  const lines: string[] = [];
  const language = summary.languages[0] ? ({ en: "English", pl: "Polish", de: "German" }[summary.languages[0].text] ?? summary.languages[0].text) : undefined;
  if (language) lines.push(summary === profile.overall ? `You mostly write in ${language}.` : `You write ${scope} in ${language}.`);
  if (summary.greetings[0]) lines.push(`You open with "${summary.greetings[0].text}".`);
  if (summary.closings[0]) lines.push(`You close with "${summary.closings[0].text}".`);
  if (summary.formality !== "unknown") lines.push(`Tone is ${summary.formality}.`);
  if (summary.medianWords) lines.push(`A typical mail is about ${summary.medianWords} words${summary.emojiRate < 0.05 ? ", without emoji" : ""}.`);
  return lines;
}
