import { posix } from "node:path";
import { Worker } from "node:worker_threads";
import { openZip, ZipError, type ZipArchive, type ZipLimits } from "./zip-reader.js";

// Text from Word, Excel and PowerPoint files (DOCX, XLSX, PPTX) for get_attachment_text and attachment indexing.
// These are ZIP archives of XML parts. The XML is read by a small linear scanner, not a full parser: no DTD is
// read and no entity is resolved beyond the five predefined ones and character references, so an entity expansion
// ("billion laughs") has nothing to expand, and no pattern here can backtrack over the document.

export type OfficeKind = "docx" | "xlsx" | "pptx";

export const OFFICE_MAX_INPUT_BYTES = 20 * 1024 * 1024;
export const OFFICE_MAX_TEXT_CHARS = 500_000;
export const OFFICE_EXTRACTION_TIMEOUT_MS = 10_000;
// What Excel itself allows in one cell; a shared string or cell value is cut here so that one string referenced by
// many cells cannot multiply into a huge row before the output cap applies.
const CELL_MAX_CHARS = 32_767;
// Attribute values are names and relationship ids and targets, never long.
const ATTRIBUTE_MAX_CHARS = 4096;
const ZIP_LIMITS: ZipLimits = { maxEntries: 5_000, maxEntryBytes: 32 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 };

export interface OfficeTextResult {
  text: string;
  format: OfficeKind;
  truncated: boolean;
}

export class OfficeTextError extends Error {
  constructor(
    readonly reason: "invalid" | "too-large" | "unsupported" | "empty" | "timeout",
    message: string,
  ) {
    super(message);
    this.name = "OfficeTextError";
  }
}

const OFFICE_TYPES: Record<string, OfficeKind> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};
const GENERIC_TYPES = new Set(["application/octet-stream", "application/zip", "application/x-zip-compressed"]);

export function officeKind(content: Buffer, contentType?: string, filename?: string): OfficeKind | undefined {
  const declared = contentType ? OFFICE_TYPES[contentType] : undefined;
  if (declared) return declared;
  // Sent as a generic type: trust the extension only when the content really is a ZIP.
  const extension = /\.(docx|xlsx|pptx)$/i.exec(filename ?? "")?.[1]?.toLowerCase() as OfficeKind | undefined;
  const isZip = content.length >= 4 && content.readUInt32LE(0) === 0x04034b50;
  return extension && isZip && (!contentType || GENERIC_TYPES.has(contentType)) ? extension : undefined;
}

function assertInputSize(content: Buffer): void {
  if (content.length > OFFICE_MAX_INPUT_BYTES) {
    throw new OfficeTextError("too-large", `The file is larger than ${OFFICE_MAX_INPUT_BYTES / (1024 * 1024)} MB, the limit for document text extraction.`);
  }
}

/**
 * The same extraction in a worker thread, so a heavy file cannot stall the server's event loop, with a hard time limit
 * (the worker is terminated). The parse itself is extractOfficeText; the worker runs it inside office-text-worker.js.
 */
export async function extractOfficeTextAsync(
  content: Buffer,
  kind: OfficeKind,
  options: { maxChars?: number; timeoutMs?: number } = {},
): Promise<OfficeTextResult> {
  assertInputSize(content);
  const timeoutMs = options.timeoutMs ?? OFFICE_EXTRACTION_TIMEOUT_MS;
  return new Promise<OfficeTextResult>((resolve, reject) => {
    // The worker gets a copy: the caller keeps its buffer.
    const worker = new Worker(new URL("./office-text-worker.js", import.meta.url), {
      workerData: { content: new Uint8Array(content), kind, maxChars: options.maxChars },
    });
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      action();
    };
    const timer = setTimeout(
      () => finish(() => reject(new OfficeTextError("timeout", "Reading the document took too long and was stopped."))),
      timeoutMs,
    );
    timer.unref?.();
    worker.once("message", (message: { ok: true; result: OfficeTextResult } | { ok: false; reason: OfficeTextError["reason"]; message: string }) =>
      finish(() => (message.ok ? resolve(message.result) : reject(new OfficeTextError(message.reason, message.message)))),
    );
    worker.once("error", () => finish(() => reject(new OfficeTextError("invalid", "The document could not be read; the file looks damaged."))));
    worker.once("exit", (code) => finish(() => reject(new OfficeTextError("invalid", `The document reader stopped unexpectedly (exit code ${code}).`))));
  });
}

export function extractOfficeText(content: Buffer, kind: OfficeKind, options: { maxChars?: number } = {}): OfficeTextResult {
  assertInputSize(content);
  const maxChars = options.maxChars ?? OFFICE_MAX_TEXT_CHARS;
  const sink = new TextSink(maxChars);
  try {
    const zip = openZip(content, ZIP_LIMITS);
    if (kind === "docx") docxText(zip, sink);
    else if (kind === "xlsx") xlsxText(zip, sink);
    else pptxText(zip, sink);
  } catch (error) {
    if (error instanceof OfficeTextError) throw error;
    if (error instanceof ZipError) throw new OfficeTextError(error.reason, error.message);
    throw new OfficeTextError("invalid", `The document could not be read; the file looks damaged.`);
  }
  // Line by line, not /[ \t]+\n/: that pattern is quadratic over a long run of spaces.
  const text = sink
    .text()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) throw new OfficeTextError("empty", "The document contains no text.");
  return { text, format: kind, truncated: sink.truncated };
}

class TextSink {
  private parts: string[] = [];
  private length = 0;
  truncated = false;
  constructor(private readonly max: number) {}

  add(value: string): void {
    if (this.truncated || !value) return;
    const room = this.max - this.length;
    if (value.length > room) {
      this.parts.push(value.slice(0, room));
      this.length = this.max;
      this.truncated = true;
      return;
    }
    this.parts.push(value);
    this.length += value.length;
  }

  /** How many more characters fit; what is decoded or collected from here on needs no more than this. */
  get room(): number {
    return this.max - this.length;
  }

  text(): string {
    return this.parts.join("");
  }
}

function requirePart(zip: ZipArchive, name: string): string {
  const data = zip.read(name);
  if (!data) throw new OfficeTextError("invalid", `The document is missing its ${name} part.`);
  return data.toString("utf8");
}

// ---- XML scanning --------------------------------------------------------------------------------------------

interface XmlHandlers {
  open?(local: string, attrs: string): void;
  close?(local: string): void;
  /** Raw character data between tags; decode it with decodeXmlText when it is kept. */
  text?(raw: string): void;
}

function localName(name: string): string {
  return name.slice(name.indexOf(":") + 1);
}

/** One linear pass over the document; `stop` ends it early (the text limit was reached). */
function scanXml(xml: string, handlers: XmlHandlers, stop: () => boolean = () => false): void {
  let i = 0;
  while (i < xml.length && !stop()) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) {
      handlers.text?.(xml.slice(i));
      return;
    }
    if (lt > i) handlers.text?.(xml.slice(i, lt));
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end === -1) return;
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end === -1) return;
      // CDATA is literal: escaped so that decoding it later gives back exactly these characters.
      handlers.text?.(xml.slice(lt + 9, end).replace(/&/g, "&amp;"));
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      throw new OfficeTextError("unsupported", "The document contains a DTD declaration, which is not read for safety.");
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end === -1) return;
      i = end + 2;
      continue;
    }
    // The tag ends at the first '>' outside a quoted attribute value.
    let j = lt + 1;
    let quote = 0;
    for (; j < xml.length; j += 1) {
      const c = xml.charCodeAt(j);
      if (quote) {
        if (c === quote) quote = 0;
      } else if (c === 34 || c === 39) {
        quote = c;
      } else if (c === 62) {
        break;
      }
    }
    if (j >= xml.length) return;
    const inner = xml.slice(lt + 1, j);
    i = j + 1;
    if (inner.startsWith("/")) {
      handlers.close?.(localName(inner.slice(1).trim()));
      continue;
    }
    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    let nameEnd = 0;
    while (nameEnd < body.length && !isXmlSpace(body.charCodeAt(nameEnd))) nameEnd += 1;
    const local = localName(body.slice(0, nameEnd));
    handlers.open?.(local, body.slice(nameEnd));
    if (selfClosing) handlers.close?.(local);
  }
}

function isXmlSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

/** Attributes as name → value, by a single scan. Values are decoded. */
function parseAttributes(attrs: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < attrs.length) {
    while (i < attrs.length && isXmlSpace(attrs.charCodeAt(i))) i += 1;
    const nameStart = i;
    while (i < attrs.length && attrs[i] !== "=" && !isXmlSpace(attrs.charCodeAt(i))) i += 1;
    const name = attrs.slice(nameStart, i);
    while (i < attrs.length && isXmlSpace(attrs.charCodeAt(i))) i += 1;
    if (attrs[i] !== "=") {
      i += 1;
      continue;
    }
    i += 1;
    while (i < attrs.length && isXmlSpace(attrs.charCodeAt(i))) i += 1;
    const quote = attrs[i];
    if (quote !== '"' && quote !== "'") break;
    const end = attrs.indexOf(quote, i + 1);
    if (end === -1) break;
    if (name && !out.has(name)) out.set(name, decodeXmlText(attrs.slice(i + 1, end), ATTRIBUTE_MAX_CHARS));
    i = end + 1;
  }
  return out;
}

/** The relationship id of an element: the namespaced `…:id` attribute (r:id), not a plain `id`. */
function relationshipId(attributes: Map<string, string>): string | undefined {
  for (const [name, value] of attributes) if (name.endsWith(":id")) return value;
  return undefined;
}

const ENTITY = /&(?:#x([0-9a-fA-F]{1,6})|#([0-9]{1,7})|(amp|lt|gt|quot|apos));/g;
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
// Control characters other than tab and newline, and the C1 range: never part of text a person wrote. Left in, they
// would only pad the result (a run of &#1; is 4 bytes in the file and 6 in the JSON) or hide words from a reader.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * Entities resolved, control characters dropped, and the result cut at `max` characters. The cut is made while
 * decoding, not after: 30 MB of &amp; would otherwise be decoded in full only to be thrown away.
 */
export function decodeXmlText(raw: string, max = Number.POSITIVE_INFINITY): string {
  const out: string[] = [];
  let length = 0;
  const push = (text: string) => {
    for (let at = 0; at < text.length && length < max; ) {
      // Chunked, so that a long run of control characters cannot use up the cap and hide what follows it.
      const step = Math.max(4096, max - length);
      const kept = text.slice(at, at + step).replace(CONTROL, "");
      at += step;
      const piece = kept.length > max - length ? kept.slice(0, max - length) : kept;
      if (piece) out.push(piece);
      length += piece.length;
    }
  };
  let last = 0;
  ENTITY.lastIndex = 0;
  for (let match = ENTITY.exec(raw); match && length < max; match = ENTITY.exec(raw)) {
    push(raw.slice(last, match.index));
    last = ENTITY.lastIndex;
    if (match[3]) {
      push(NAMED[match[3]]);
      continue;
    }
    const code = match[1] ? Number.parseInt(match[1], 16) : Number(match[2]);
    push(code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || code === 0 ? "�" : String.fromCodePoint(code));
  }
  push(raw.slice(last));
  return out.join("");
}

/** Relationship id → part name, resolved against `base` and kept inside the archive. */
function readRelationships(zip: ZipArchive, relsName: string, base: string): Map<string, string> {
  const map = new Map<string, string>();
  const data = zip.read(relsName);
  if (!data) return map;
  scanXml(data.toString("utf8"), {
    open(local, attrs) {
      if (local !== "Relationship") return;
      const attributes = parseAttributes(attrs);
      const id = attributes.get("Id");
      const target = attributes.get("Target");
      if (!id || !target || attributes.get("TargetMode") === "External") return;
      const resolved = posix.normalize(target.startsWith("/") ? target.slice(1) : posix.join(base, target));
      if (resolved.startsWith("../") || resolved === ".." || resolved.startsWith("/")) return;
      map.set(id, resolved);
    },
  });
  return map;
}

// ---- DOCX ------------------------------------------------------------------------------------------------------

function docxText(zip: ZipArchive, sink: TextSink): void {
  let inText = false;
  let runDepth = 0;
  scanXml(
    requirePart(zip, "word/document.xml"),
    {
      open(local) {
        if (local === "t") inText = true;
        else if (local === "r") runDepth += 1;
        else if (runDepth > 0 && local === "tab") sink.add("\t");
        else if (runDepth > 0 && (local === "br" || local === "cr")) sink.add("\n");
      },
      close(local) {
        if (local === "t") inText = false;
        else if (local === "r") runDepth = Math.max(0, runDepth - 1);
        else if (local === "p" || local === "tr") sink.add("\n");
        else if (local === "tc") sink.add("\t");
      },
      text(raw) {
        if (inText) sink.add(decodeXmlText(raw, sink.room + 1));
      },
    },
    () => sink.truncated,
  );
}

// ---- XLSX ------------------------------------------------------------------------------------------------------

function xlsxText(zip: ZipArchive, sink: TextSink): void {
  const sheets: Array<{ name: string; rel?: string }> = [];
  scanXml(requirePart(zip, "xl/workbook.xml"), {
    open(local, attrs) {
      if (local !== "sheet") return;
      const attributes = parseAttributes(attrs);
      sheets.push({ name: attributes.get("name") ?? `Sheet ${sheets.length + 1}`, rel: relationshipId(attributes) });
    },
  });
  const rels = readRelationships(zip, "xl/_rels/workbook.xml.rels", "xl");
  const shared = readSharedStrings(zip);

  for (const sheet of sheets) {
    if (sink.truncated) return;
    const part = sheet.rel ? rels.get(sheet.rel) : undefined;
    const data = part ? zip.read(part) : undefined;
    sink.add(`--- Sheet: ${sheet.name} ---\n`);
    if (!data) {
      sink.add("\n");
      continue;
    }
    let cells: string[] = [];
    let rowChars = 0;
    let type: string | undefined;
    let value = "";
    let inValue = false;
    let inInline = false;
    let inInlineText = false;
    scanXml(
      data.toString("utf8"),
      {
        open(local, attrs) {
          if (local === "row") [cells, rowChars] = [[], 0];
          else if (local === "c") {
            type = parseAttributes(attrs).get("t");
            value = "";
          } else if (local === "v") inValue = true;
          else if (local === "is") inInline = true;
          else if (local === "t" && inInline) inInlineText = true;
        },
        close(local) {
          if (local === "v") inValue = false;
          else if (local === "is") inInline = false;
          else if (local === "t") inInlineText = false;
          else if (local === "c") {
            const cell = cellValue(type, value, shared);
            // Past the room left in the output nothing more of the row can be used: stop collecting it.
            if (cell && rowChars <= sink.room) {
              cells.push(cell);
              rowChars += cell.length + 1;
            }
          } else if (local === "row" && cells.length > 0) {
            sink.add(`${cells.join("\t")}\n`);
          }
        },
        text(raw) {
          if ((inValue || inInlineText) && value.length < CELL_MAX_CHARS) value += decodeXmlText(raw, CELL_MAX_CHARS - value.length);
        },
      },
      () => sink.truncated,
    );
    sink.add("\n");
  }
}

function cellValue(type: string | undefined, value: string, shared: string[]): string {
  const trimmed = value.trim();
  if (type === "s") {
    const index = Number(trimmed);
    return Number.isInteger(index) && index >= 0 && index < shared.length ? shared[index] : "";
  }
  if (type === "b") return trimmed === "1" ? "TRUE" : trimmed === "0" ? "FALSE" : trimmed;
  return type === "inlineStr" || type === "str" ? value : trimmed;
}

function readSharedStrings(zip: ZipArchive): string[] {
  const data = zip.read("xl/sharedStrings.xml");
  if (!data) return [];
  const strings: string[] = [];
  let current = "";
  let inItem = false;
  let inText = false;
  let phoneticDepth = 0;
  scanXml(data.toString("utf8"), {
    open(local) {
      if (local === "si") {
        inItem = true;
        current = "";
      } else if (local === "rPh") phoneticDepth += 1;
      else if (local === "t" && inItem && phoneticDepth === 0) inText = true;
    },
    close(local) {
      if (local === "si") {
        strings.push(current);
        inItem = false;
      } else if (local === "rPh") phoneticDepth = Math.max(0, phoneticDepth - 1);
      else if (local === "t") inText = false;
    },
    text(raw) {
      if (inText && current.length < CELL_MAX_CHARS) current += decodeXmlText(raw, CELL_MAX_CHARS - current.length);
    },
  });
  return strings;
}

// ---- PPTX ------------------------------------------------------------------------------------------------------

function pptxText(zip: ZipArchive, sink: TextSink): void {
  const slideRels: string[] = [];
  scanXml(requirePart(zip, "ppt/presentation.xml"), {
    open(local, attrs) {
      if (local !== "sldId") return;
      const rel = relationshipId(parseAttributes(attrs));
      if (rel) slideRels.push(rel);
    },
  });
  const rels = readRelationships(zip, "ppt/_rels/presentation.xml.rels", "ppt");
  slideRels.forEach((rel, index) => {
    if (sink.truncated) return;
    const part = rels.get(rel);
    const data = part ? zip.read(part) : undefined;
    sink.add(`--- Slide ${index + 1} of ${slideRels.length} ---\n`);
    if (!data) {
      sink.add("\n");
      return;
    }
    let inText = false;
    scanXml(
      data.toString("utf8"),
      {
        open(local) {
          if (local === "t") inText = true;
          else if (local === "br") sink.add("\n");
        },
        close(local) {
          if (local === "t") inText = false;
          else if (local === "p") sink.add("\n");
        },
        text(raw) {
          if (inText) sink.add(decodeXmlText(raw, sink.room + 1));
        },
      },
      () => sink.truncated,
    );
    sink.add("\n");
  });
}
