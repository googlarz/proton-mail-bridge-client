import { Worker } from "node:worker_threads";
import { extractImages, getDocumentProxy } from "unpdf";
import { encodePng } from "./png.js";

// PDF text extraction for get_attachment_text. unpdf ships a serverless build of
// pdf.js: pure JavaScript, no native module. The parse runs in a worker_thread of
// this process (pdf-text-worker.js), so a heavy file cannot stall the server's event
// loop and a timeout can really stop it. Everything happens in memory; nothing is written to disk and nothing is fetched (no font or CMap
// URLs are configured, so pdf.js has nothing to download).

export const DEFAULT_PDF_MAX_MB = 10;
export const DEFAULT_PDF_MAX_PAGES = 50;
export const PDF_EXTRACTION_TIMEOUT_MS = 30_000;

// A page image larger than this is not decoded for OCR.
const MAX_OCR_IMAGE_PIXELS = 20_000_000;

export interface PdfTextOptions {
  maxPages?: number;
  timeoutMs?: number;
  /** For OCR: up to this many pages without text hand back their largest image as a PNG. 0 or unset: none. */
  ocrPages?: number;
}

export interface PdfTextResult {
  text: string;
  totalPages: number;
  extractedPages: number;
  /** Pages past maxPages that were not read. 0 when the whole document was read. */
  omittedPages: number;
  truncated: boolean;
  /** Only with ocrPages: the text of each read page, and the images of pages that had none. */
  pageTexts?: string[];
  pageImages?: Array<{ page: number; png: Uint8Array }>;
}

/** The page-by-page text with its markers, and a note when pages past maxPages were left out. */
export function formatPdfPages(pageTexts: string[], totalPages: number, maxPages: number): string {
  const pages = pageTexts.map((pageText, index) => `--- Page ${index + 1} of ${totalPages} ---\n${pageText.trim()}`);
  const omittedPages = totalPages - pageTexts.length;
  if (omittedPages > 0) {
    pages.push(
      `--- Truncated: read ${pageTexts.length} of ${totalPages} pages; ${omittedPages} page${omittedPages === 1 ? "" : "s"} not included (limit PROTONMAIL_PDF_MAX_PAGES=${maxPages}) ---`,
    );
  }
  return pages.join("\n\n");
}

/** A PDF that cannot be read as text, with a message meant for the user, not a stack trace. */
export class PdfTextError extends Error {
  constructor(
    readonly reason: "encrypted" | "invalid" | "no-text-layer" | "timeout",
    message: string,
  ) {
    super(message);
    this.name = "PdfTextError";
  }
}

export function looksLikePdf(content: Buffer, contentType?: string, filename?: string): boolean {
  if (contentType === "application/pdf" || contentType === "application/x-pdf") return true;
  // Mail clients often send PDFs as application/octet-stream; trust the file's own header then.
  const hasPdfHeader = content.subarray(0, 1024).includes("%PDF-");
  return hasPdfHeader && (!contentType || contentType === "application/octet-stream" || /\.pdf$/i.test(filename ?? ""));
}

export async function extractPdfText(content: Buffer, options: PdfTextOptions = {}): Promise<PdfTextResult> {
  const timeoutMs = options.timeoutMs ?? PDF_EXTRACTION_TIMEOUT_MS;
  return new Promise<PdfTextResult>((resolve, reject) => {
    // The worker gets a copy: the caller keeps its buffer.
    const worker = new Worker(new URL("./pdf-text-worker.js", import.meta.url), {
      workerData: { content: new Uint8Array(content), maxPages: options.maxPages ?? DEFAULT_PDF_MAX_PAGES, timeoutMs, ocrPages: options.ocrPages ?? 0 },
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
      () => finish(() => reject(new PdfTextError("timeout", `Reading the PDF took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped.`))),
      timeoutMs + 2000,
    );
    timer.unref?.();
    worker.once("message", (message: { ok: true; result: PdfTextResult } | { ok: false; reason: PdfTextError["reason"]; message: string }) =>
      finish(() => (message.ok ? resolve(message.result) : reject(new PdfTextError(message.reason, message.message)))),
    );
    worker.once("error", (error) => finish(() => reject(toPdfTextError(error))));
    worker.once("exit", (code) => finish(() => reject(new PdfTextError("invalid", `The PDF reader stopped unexpectedly (exit code ${code}).`))));
  });
}

/** The actual parse. Runs inside the worker; exported for it only. */
export async function extractPdfTextDirect(content: Buffer | Uint8Array, options: PdfTextOptions = {}): Promise<PdfTextResult> {
  const maxPages = options.maxPages ?? DEFAULT_PDF_MAX_PAGES;
  const timeoutMs = options.timeoutMs ?? PDF_EXTRACTION_TIMEOUT_MS;
  const ocrPages = options.ocrPages ?? 0;
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  let destroy: (() => Promise<void>) | undefined;

  const work = (async (): Promise<PdfTextResult> => {
    let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
    try {
      // pdf.js may detach the buffer it is given, so it gets a copy.
      pdf = await getDocumentProxy(new Uint8Array(content), {
        useSystemFonts: false,
        disableFontFace: true,
        useWorkerFetch: false,
        isOffscreenCanvasSupported: false,
        enableXfa: false,
        verbosity: 0,
        ...(ocrPages > 0 ? { maxImageSize: MAX_OCR_IMAGE_PIXELS } : {}),
      });
    } catch (error) {
      throw toPdfTextError(error);
    }
    destroy = () => pdf.loadingTask.destroy();
    try {
      const totalPages = pdf.numPages;
      const extractedPages = Math.min(totalPages, maxPages);
      const pageTexts: string[] = [];
      const pageImages: Array<{ page: number; png: Uint8Array }> = [];
      let anyText = false;
      for (let pageNumber = 1; pageNumber <= extractedPages; pageNumber += 1) {
        if (timedOut) break;
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const pageText = textContentToString(content.items);
        page.cleanup();
        if (pageText.trim()) anyText = true;
        else if (pageImages.length < ocrPages) {
          const png = await largestPageImage(pdf, pageNumber);
          if (png) pageImages.push({ page: pageNumber, png });
        }
        pageTexts.push(pageText);
      }
      if (!anyText && pageImages.length === 0) {
        throw new PdfTextError(
          "no-text-layer",
          "The PDF has no text layer (it is probably a scan or contains only images), so there is no text to extract.",
        );
      }
      const omittedPages = totalPages - extractedPages;
      return {
        text: formatPdfPages(pageTexts, totalPages, maxPages),
        totalPages,
        extractedPages,
        omittedPages,
        truncated: omittedPages > 0,
        ...(ocrPages > 0 ? { pageTexts, pageImages } : {}),
      };
    } catch (error) {
      throw toPdfTextError(error);
    } finally {
      await pdf.loadingTask.destroy().catch(() => {});
    }
  })();

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      void destroy?.().catch(() => {});
      reject(new PdfTextError("timeout", `Reading the PDF took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped.`));
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    // The losing promise must not surface as an unhandled rejection.
    work.catch(() => {});
  }
}

// A scanned page is normally one image covering the page; the largest one is what OCR should read.
async function largestPageImage(pdf: Awaited<ReturnType<typeof getDocumentProxy>>, pageNumber: number): Promise<Uint8Array | undefined> {
  let images: Awaited<ReturnType<typeof extractImages>>;
  try {
    images = await extractImages(pdf, pageNumber);
  } catch {
    return undefined;
  }
  const largest = images
    .filter((image) => image.width * image.height <= MAX_OCR_IMAGE_PIXELS)
    .sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!largest) return undefined;
  return new Uint8Array(encodePng(largest.width, largest.height, largest.channels, largest.data));
}

type TextItem = { str?: string; hasEOL?: boolean };

function textContentToString(items: readonly unknown[]): string {
  let out = "";
  for (const raw of items) {
    const item = raw as TextItem;
    if (typeof item.str !== "string") continue;
    out += item.str;
    if (item.hasEOL) out += "\n";
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

function toPdfTextError(error: unknown): Error {
  if (error instanceof PdfTextError) return error;
  const name = (error as { name?: string } | undefined)?.name ?? "";
  if (name === "PasswordException") {
    return new PdfTextError("encrypted", "The PDF is password-protected, so its text cannot be read.");
  }
  // InvalidPDFException, FormatError, MissingPDFException, UnknownErrorException and
  // anything else pdf.js throws on a damaged file: one plain message, no stack.
  const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
  return new PdfTextError("invalid", `The PDF could not be read; the file looks damaged or is not a valid PDF${detail}.`);
}
