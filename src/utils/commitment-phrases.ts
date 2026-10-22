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
  promise("i['’]?ll|i will|i['’]m going to|i can send|we['’]?ll|we will|let me (?:send|check|get|look)|will send|will get back|get back to you"),
  // Polish
  promise("wyślę|wyślemy|prześlę|prześlemy|odpiszę|odpiszemy|zrobię|zrobimy|dam znać|damy znać|przygotuję|przygotujemy|sprawdzę|sprawdzimy|oddzwonię|zadzwonię|załatwię|doślę|odezwę się"),
  // German
  promise("ich schicke|ich sende|ich melde mich|ich werde|ich kümmere mich|wir schicken|wir senden|wir melden uns|ich gebe bescheid"),
];

const WEEKDAYS: Array<[RegExp, number]> = [
  [/(?<!\p{L})(sunday|niedziel\p{L}*|sonntag)(?!\p{L})/iu, 0],
  [/(?<!\p{L})(monday|poniedziałk\p{L}*|montag)(?!\p{L})/iu, 1],
  [/(?<!\p{L})(tuesday|wtorek|wtork\p{L}*|dienstag)(?!\p{L})/iu, 2],
  [/(?<!\p{L})(wednesday|środ\p{L}*|mittwoch)(?!\p{L})/iu, 3],
  [/(?<!\p{L})(thursday|czwartk\p{L}*|czwartek|donnerstag)(?!\p{L})/iu, 4],
  [/(?<!\p{L})(friday|piątk\p{L}*|piątek|freitag)(?!\p{L})/iu, 5],
  [/(?<!\p{L})(saturday|sobot\p{L}*|samstag)(?!\p{L})/iu, 6],
];

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The date a sentence names, counted from `now` (a UTC day). Weekday names mean the next such day after today. */
export function parseDue(sentence: string, now: Date): string | undefined {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const full = sentence.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (full) return full[0];
  const dotted = sentence.match(/\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/);
  if (dotted) {
    const dayOfMonth = Number(dotted[1]);
    const month = Number(dotted[2]);
    if (dayOfMonth >= 1 && dayOfMonth <= 31 && month >= 1 && month <= 12) {
      let year = dotted[3] ? Number(dotted[3]) : day.getUTCFullYear();
      if (year < 100) year += 2000;
      const candidate = new Date(Date.UTC(year, month - 1, dayOfMonth));
      if (!dotted[3] && candidate < day) candidate.setUTCFullYear(year + 1);
      return iso(candidate);
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
  for (const raw of own.split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = raw.replace(/\s+/g, " ").trim();
    if (sentence.length < 12 || sentence.length > 300 || sentence.startsWith(">")) continue;
    if (!PROMISE.some((pattern) => pattern.test(sentence))) continue;
    const due = parseDue(sentence, now);
    found.push({ sentence, ...(due ? { due } : {}) });
    if (found.length >= max) break;
  }
  return found;
}
