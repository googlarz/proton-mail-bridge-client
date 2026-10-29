import { cleanContactText, normalizeContactAddress } from "./contact-text.js";

// Reads the people in a vCard file (2.1, 3.0, 4.0): name, e-mail addresses, organisation and note. Everything else
// (photos, phones, CATEGORIES) is skipped; categories are not read as tags, so a file cannot mark anyone as a VIP.
// Every step is bounded: the caller limits the file size, and here the number of cards, addresses and line length.

export interface ParsedVCard {
  name?: string;
  emails: string[];
  org?: string;
  note?: string;
}

export interface VcfParseResult {
  cards: ParsedVCard[];
  /** Cards without a usable e-mail address. */
  skipped: number;
  /** More cards than maxCards: the rest were not read. */
  truncated: boolean;
}

export const VCF_LIMITS = { maxCards: 5_000, maxEmailsPerCard: 20, maxLineLength: 20_000 };

export const CONTACT_NAME_MAX = 100;
export const CONTACT_ORG_MAX = 100;
export const CONTACT_NOTES_MAX = 2_000;

// Physical lines joined into logical ones: a line starting with a space or tab continues the previous one, and so does
// the line after a quoted-printable value that ends in "=". A logical line longer than the limit is dropped.
function* logicalLines(text: string, maxLength: number): Generator<string> {
  let current: string | undefined;
  let oversized = false;
  let quoted = false;
  const flush = () => (current !== undefined && !oversized ? current : undefined);
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const quotedSoftBreak = current !== undefined && quoted && current.endsWith("=");
    if (current !== undefined && (raw.startsWith(" ") || raw.startsWith("\t") || quotedSoftBreak)) {
      if (oversized) continue;
      const piece = quotedSoftBreak ? raw : raw.slice(1);
      if (current.length + piece.length > maxLength) oversized = true;
      else current = quotedSoftBreak ? current.slice(0, -1) + piece : current + piece;
      continue;
    }
    const done = flush();
    if (done !== undefined) yield done;
    current = raw;
    oversized = raw.length > maxLength;
    // The parameters are on the first physical line, before the value.
    const colon = raw.indexOf(":");
    quoted = colon > 0 && /QUOTED-PRINTABLE/i.test(raw.slice(0, Math.min(colon, 500)));
  }
  const done = flush();
  if (done !== undefined) yield done;
}

// The property name with its parameters, and the value: split at the first ":" outside double quotes.
function splitProperty(line: string): { name: string; params: string[]; value: string } | undefined {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') quoted = !quoted;
    else if (char === ":" && !quoted) {
      const [rawName, ...params] = line.slice(0, index).split(";");
      return { name: rawName.slice(rawName.lastIndexOf(".") + 1).trim().toUpperCase(), params: params.map((param) => param.trim().toUpperCase()), value: line.slice(index + 1) };
    }
  }
  return undefined;
}

function decodeQuotedPrintable(value: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const hex = value.slice(index + 1, index + 3);
    if (value[index] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else {
      bytes.push(...Buffer.from(value[index], "utf8"));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

// Splits at ";" not escaped with a backslash, then resolves the escapes of vCard 3.0/4.0.
function components(value: string): string[] {
  return value.split(/(?<!\\);/).map(unescapeValue);
}

function unescapeValue(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_, char: string) => (char === "n" || char === "N" ? "\n" : char));
}

export function parseVcf(text: string, limits = VCF_LIMITS): VcfParseResult {
  const cards: ParsedVCard[] = [];
  let skipped = 0;
  let card: (ParsedVCard & { familyGiven?: string }) | undefined;
  for (const line of logicalLines(text.replace(/^﻿/, ""), limits.maxLineLength)) {
    const property = splitProperty(line);
    if (!property) continue;
    const { name, params } = property;
    if (name === "BEGIN" && property.value.trim().toUpperCase() === "VCARD") {
      if (cards.length >= limits.maxCards) return { cards, skipped, truncated: true };
      // A card that never ended is dropped with the next BEGIN.
      if (card) skipped += 1;
      card = { emails: [] };
      continue;
    }
    if (!card) continue;
    if (name === "END" && property.value.trim().toUpperCase() === "VCARD") {
      const name = card.name ?? card.familyGiven;
      if (card.emails.length > 0) cards.push({ emails: card.emails, ...(name ? { name } : {}), ...(card.org ? { org: card.org } : {}), ...(card.note ? { note: card.note } : {}) });
      else skipped += 1;
      card = undefined;
      continue;
    }
    const raw = params.some((param) => param === "QUOTED-PRINTABLE" || param === "ENCODING=QUOTED-PRINTABLE") ? decodeQuotedPrintable(property.value) : property.value;
    switch (name) {
      case "FN": {
        const value = cleanContactText(unescapeValue(raw), CONTACT_NAME_MAX);
        if (value) card.name = value;
        break;
      }
      case "N": {
        const [family = "", given = ""] = components(raw);
        const value = cleanContactText(`${given} ${family}`, CONTACT_NAME_MAX);
        if (value) card.familyGiven = value;
        break;
      }
      case "EMAIL": {
        const address = normalizeContactAddress(unescapeValue(raw));
        if (address && !card.emails.includes(address) && card.emails.length < limits.maxEmailsPerCard) card.emails.push(address);
        break;
      }
      case "ORG": {
        const value = cleanContactText(components(raw)[0] ?? "", CONTACT_ORG_MAX);
        if (value) card.org = value;
        break;
      }
      case "NOTE": {
        const value = cleanContactText(unescapeValue(raw), CONTACT_NOTES_MAX, true);
        if (value) card.note = value;
        break;
      }
    }
  }
  if (card) skipped += 1;
  return { cards, skipped, truncated: false };
}
