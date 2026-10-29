// Names, notes and addresses of contacts come from mail headers and vCard files: untrusted text. Cleaned before they are
// stored or shown, so a name cannot hide text from the reader or pass for several lines of something else.

const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
const INVISIBLE = /[​-‏‪-‮⁠-⁩؜﻿]/g;
const ADDRESS = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;

/** Without control, bidi and zero-width characters, whitespace collapsed (newlines kept only when asked), at most `max` characters. */
export function cleanContactText(value: string, max: number, keepNewlines = false): string {
  const text = value.replace(/\r\n?/g, "\n").replace(INVISIBLE, "");
  const cleaned = keepNewlines
    ? text.split("\n").map((line) => line.replace(CONTROL, " ").replace(/\s+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim()
    : text.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, max).trim();
}

/** A lowercased address, or undefined when the text is not one. */
export function normalizeContactAddress(value: string): string | undefined {
  const address = value.trim().replace(/^mailto:/i, "").replace(/^<|>$/g, "").trim().toLowerCase();
  return address.length <= 254 && ADDRESS.test(address) ? address : undefined;
}
