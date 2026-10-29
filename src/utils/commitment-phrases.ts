// Finds promises in the text of a message ("I'll send it by Friday", "wyślę do piątku", "ich schicke es bis Freitag")
// and reads the date they name. Pattern based and deliberately plain: it proposes, the assistant and the user decide.

export interface CommitmentCandidate {
  sentence: string;
  /** Date the sentence names (YYYY-MM-DD), when it names one. */
  due?: string;
}

// \b does not work next to ś, ę, ü and the like, so word edges are letter lookarounds.
const promise = (words: string) => new RegExp(`(?<!\\p{L})(?:${words})(?!\\p{L})`, "iu");
const PROMISE = [
  // English
  promise("i['’]ll|i will|i['’]m going to|i can send|we['’]ll|we will|let me (?:send|check|get|look)|will send|will get back|get back to you"),
  // Polish
  promise("wyślę|wyślemy|prześlę|prześlemy|odpiszę|odpiszemy|zrobię|zrobimy|dam znać|damy znać|przygotuję|przygotujemy|sprawdzę|sprawdzimy|oddzwonię|zadzwonię|załatwię|doślę|odezwę się"),
  // German
  promise("ich schicke|ich sende|ich melde mich|ich werde|ich kümmere mich|wir schicken|wir senden|wir melden uns|ich gebe bescheid"),
];

// Exact word forms: a stem with \p{L}* also matched "środowisko" (environment) as Wednesday.
const WEEKDAYS: Array<[RegExp, number]> = [
  [/(?<!\p{L})(sunday|niedziela|niedzielę|niedzieli|niedzielą|sonntag)(?!\p{L})/iu, 0],
  [/(?<!\p{L})(monday|poniedziałek|poniedziałku|poniedziałkiem|montag)(?!\p{L})/iu, 1],
  [/(?<!\p{L})(tuesday|wtorek|wtorku|wtorkiem|dienstag)(?!\p{L})/iu, 2],
  [/(?<!\p{L})(wednesday|środa|środę|środy|środzie|środą|mittwoch)(?!\p{L})/iu, 3],
  [/(?<!\p{L})(thursday|czwartek|czwartku|czwartkiem|donnerstag)(?!\p{L})/iu, 4],
  [/(?<!\p{L})(friday|piątek|piątku|piątkiem|freitag)(?!\p{L})/iu, 5],
  [/(?<!\p{L})(saturday|sobota|sobotę|soboty|sobocie|sobotą|samstag)(?!\p{L})/iu, 6],
];

// A date only counts when it exists: 31.02 and 2026-13-45 are not dates.
function validDate(year: number, month: number, day: number): string | undefined {
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day ? iso(candidate) : undefined;
}


function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const MONTHS: Array<[string, number]> = [
  ["january|jan|stycznia|styczeń|januar|jänner", 1],
  ["february|feb|lutego|luty|februar", 2],
  ["march|mar|marca|marzec|märz|maerz", 3],
  ["april|apr|kwietnia|kwiecień|kwiecien", 4],
  ["may|maja|maj|mai", 5],
  ["june|jun|czerwca|czerwiec|juni", 6],
  ["july|jul|lipca|lipiec|juli", 7],
  ["august|aug|sierpnia|sierpień|sierpien", 8],
  ["september|sept|sep|września|wrzesień|wrzesnia", 9],
  ["october|oct|października|październik|pazdziernika|oktober|okt", 10],
  ["november|nov|listopada|listopad", 11],
  ["december|dec|grudnia|grudzień|grudzien|dezember|dez", 12],
];
const MONTH_ALTERNATION = MONTHS.map(([names]) => names).join("|");
const DAY_MONTH = new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?\\.?\\s+(?:of\\s+)?(${MONTH_ALTERNATION})\\.?(?:,?\\s+(\\d{4}))?(?!\\p{L})`, "iu");
const MONTH_DAY = new RegExp(`(?<!\\p{L})(${MONTH_ALTERNATION})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:,?\\s+(\\d{4}))?`, "iu");

function monthNumber(name: string): number {
  const lower = name.toLowerCase();
  return MONTHS.find(([names]) => names.split("|").includes(lower))?.[1] ?? 0;
}

// "16 October 2026", "October 16", "16 października", "16. Oktober": without a year, the next such day.
function namedMonthDate(sentence: string, day: Date): string | undefined {
  const match = DAY_MONTH.exec(sentence);
  const swapped = match ? undefined : MONTH_DAY.exec(sentence);
  const found = match ?? swapped;
  if (!found) return undefined;
  const dayOfMonth = Number(match ? found[1] : found[2]);
  const month = monthNumber(match ? found[2] : found[1]);
  if (!month || dayOfMonth < 1 || dayOfMonth > 31) return undefined;
  const explicitYear = found[3] ? Number(found[3]) : undefined;
  const candidate = new Date(Date.UTC(explicitYear ?? day.getUTCFullYear(), month - 1, dayOfMonth));
  if (explicitYear === undefined && candidate < day) candidate.setUTCFullYear(candidate.getUTCFullYear() + 1);
  return iso(candidate);
}

/** The date a sentence names, counted from `now` (a UTC day). Weekday names mean the next such day after today. */
export function parseDue(sentence: string, now: Date): string | undefined {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const full = sentence.match(/(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/);
  if (full) {
    const exact = validDate(Number(full[1]), Number(full[2]), Number(full[3]));
    if (exact) return exact;
  }
  const named = namedMonthDate(sentence, day);
  if (named) return named;
  // 5.11. / 05.11.2026 / 5/11: not a version number or a decimal ("version 2.3", "1.5 hours"), so without a year it must
  // follow a word that introduces a date ("by", "do", "bis").
  const dotted = sentence.match(/(?<![\d.,])(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?![\d]|[./]\d)/);
  if (dotted) {
    const before = sentence.slice(0, dotted.index ?? 0);
    const introduced = /(?<!\p{L})(by|until|before|on|due|do|na|przed|bis|am|vor|dnia)\s+$/iu.test(before);
    if (dotted[3] || introduced) {
      let year = dotted[3] ? Number(dotted[3]) : day.getUTCFullYear();
      if (year < 100) year += 2000;
      const exact = validDate(year, Number(dotted[2]), Number(dotted[1]));
      if (exact) {
        if (dotted[3] || exact >= iso(day)) return exact;
        return validDate(year + 1, Number(dotted[2]), Number(dotted[1]));
      }
    }
  }
  if (/(?<!\p{L})(today|dzisiaj|dziś|heute|eod|end of (?:the )?day)(?!\p{L})/iu.test(sentence)) return iso(day);
  if (/(?<!\p{L})(tomorrow|jutro|morgen)(?!\p{L})/iu.test(sentence)) return iso(new Date(day.getTime() + 86_400_000));
  for (const [pattern, weekday] of WEEKDAYS) {
    if (pattern.test(sentence)) {
      const ahead = ((weekday - day.getUTCDay() + 7) % 7) || 7;
      return iso(new Date(day.getTime() + ahead * 86_400_000));
    }
  }
  return undefined;
}

/** The sentences of `text` that promise something, with the date each names. At most `max`. */
export function extractCommitments(text: string, now: Date, max = 5): CommitmentCandidate[] {
  const found: CommitmentCandidate[] = [];
  // A quoted earlier message is somebody else's promise.
  const own = text.split(/\n(?:>|On .+ wrote:|W dniu .+ napisał|Am .+ schrieb)/)[0] ?? text;
  // A mail is hard-wrapped: a line that does not end a sentence continues on the next one.
  const joined = own.replace(/([^.!?:\n])\n(?![\n>])/g, "$1 ");
  for (const raw of joined.split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = raw.replace(/\s+/g, " ").trim();
    if (sentence.length < 12 || sentence.length > 300 || sentence.startsWith(">")) continue;
    if (!PROMISE.some((pattern) => pattern.test(sentence))) continue;
    const due = parseDue(sentence, now);
    found.push({ sentence, ...(due ? { due } : {}) });
    if (found.length >= max) break;
  }
  return found;
}
