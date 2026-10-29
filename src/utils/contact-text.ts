// Names, notes and addresses of contacts come from mail headers and vCard files: untrusted text. Cleaned before they are
// stored or shown, so a name cannot hide text from the reader or pass for several lines of something else.

const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
// Zero-width, bidi, tag characters (U+E0000-E007F smuggle ASCII invisibly), variation selectors, soft hyphen and the blank fillers.
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u2800\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
const ADDRESS = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;

/** Without control, bidi and zero-width characters, whitespace collapsed (newlines kept only when asked), at most `max` characters. */
export function cleanContactText(value: string, max: number, keepNewlines = false): string {
  const text = value.replace(/\r\n?/g, "\n").replace(INVISIBLE, "");
  const cleaned = keepNewlines
    ? text.split("\n").map((line) => line.replace(CONTROL, " ").replace(/\s+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim()
    : text.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, max).trim();
}

/** Lowercases ASCII letters only: toLowerCase() would turn the Kelvin sign (U+212A) into "k" and make two different addresses one. */
export function lowerAscii(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** A lowercased (ASCII only) address, or undefined when the text is not one. */
export function normalizeContactAddress(value: string): string | undefined {
  const address = lowerAscii(value.trim().replace(/^mailto:/i, "").replace(/^<|>$/g, "").trim());
  return address.length <= 254 && ADDRESS.test(address) ? address : undefined;
}
