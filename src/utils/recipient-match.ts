import { foldText } from "./contact-text.js";

// Matching of what a person typed ("Maćka", "mama", "jan.kowalski@exmaple.com") against names, aliases and addresses.
// Deliberately conservative: it only ever ranks suggestions, nothing here chooses a recipient.

export type NameMatchKind = "exact" | "word" | "inflection" | "prefix";

const SPLIT = /[\s.,;:_-]+/;

/** How one folded query word relates to one folded name word, or undefined when it does not. */
export function tokenMatch(query: string, word: string): "equal" | "inflection" | "prefix" | undefined {
  if (!query || !word) return undefined;
  if (query === word) return "equal";
  // A longer form of the name: "jana" for "jan", "piotrowi" for "piotr".
  if (word.length >= 3 && query.length >= 4 && query.startsWith(word) && query.length - word.length <= 3) return "inflection";
  // A name that ends in a vowel loses it when inflected: "kasie" for "kasia", "mamy" for "mama".
  if (word.length >= 4 && /[aeiouy]$/.test(word)) {
    const stem = word.slice(0, -1);
    if (stem.length >= 3 && query.length >= 4 && query.startsWith(stem) && query.length - stem.length <= 3) return "inflection";
  }
  // Names in -ek / -iek lose the "e" (and the "i" before "k") when inflected: "Marek" - "Marka", "Maciek" - "Macka" (folded from "Maćka").
  if (word.length >= 5 && word.endsWith("ek")) {
    const stems = [`${word.slice(0, -2)}k`];
    if (word.endsWith("iek")) stems.push(`${word.slice(0, -3)}k`);
    if (stems.some((stem) => stem.length >= 3 && query.startsWith(stem) && query.length - stem.length <= 3)) return "inflection";
  }
  // The start of a name that is being typed: "mac" for "maciek". Fewer than three letters says nothing.
  if (query.length >= 3 && word.startsWith(query)) return "prefix";
  return undefined;
}

/**
 * How well `text` (a display name or an alias) answers `query`: the whole text ("exact"), every query word found as a
 * word of the text ("word"), some of them only in an inflected form ("inflection") or only as the start of a word
 * ("prefix"). Every query word has to match a different word of the text. Undefined when it does not.
 */
export function nameMatch(query: string, text: string): NameMatchKind | undefined {
  const q = foldText(query);
  const t = foldText(text);
  if (!q || !t) return undefined;
  if (q === t) return "exact";
  const free = t.split(SPLIT).filter(Boolean);
  let result: NameMatchKind = "word";
  for (const queryWord of q.split(SPLIT).filter(Boolean)) {
    let found = -1;
    let kind: "equal" | "inflection" | "prefix" | undefined;
    for (const [index, word] of free.entries()) {
      const matched = tokenMatch(queryWord, word);
      if (!matched) continue;
      const better = kind === undefined || matched === "equal" || (matched === "inflection" && kind === "prefix");
      if (better) {
        found = index;
        kind = matched;
      }
      if (matched === "equal") break;
    }
    if (found < 0 || !kind) return undefined;
    free.splice(found, 1);
    if (kind === "prefix") result = "prefix";
    else if (kind === "inflection" && result !== "prefix") result = "inflection";
  }
  return result;
}

/** Edit distance between two strings, or `max + 1` as soon as it is certain to exceed `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  return previous[b.length];
}
