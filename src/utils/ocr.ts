import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Optional OCR through an external program (PROTONMAIL_OCR_COMMAND, e.g. tesseract), off unless that is set. The
// program is started with execFile and an argument array, never through a shell, as `<command> <image file> stdout`
// (tesseract's own convention), with a timeout and a cap on what it may print. The image is written to a private
// temporary directory for the run and removed afterwards.

export const OCR_TIMEOUT_MS = 60_000;
export const OCR_MAX_OUTPUT_BYTES = 1_000_000;
export const OCR_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Image-only PDF pages passed to OCR per document. */
export const OCR_MAX_PDF_PAGES = 10;

export class OcrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OcrError";
  }
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/tiff": ".tif",
  "image/bmp": ".bmp",
};

/** The file extension for an image OCR can read, or undefined for anything else. */
export function ocrImageExtension(contentType?: string): string | undefined {
  return contentType ? IMAGE_EXTENSIONS[contentType] : undefined;
}

export async function runOcr(
  command: string,
  image: Buffer | Uint8Array,
  extension: string,
  options: { timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<{ text: string; truncated: boolean }> {
  const timeoutMs = options.timeoutMs ?? OCR_TIMEOUT_MS;
  const maxBuffer = options.maxOutputBytes ?? OCR_MAX_OUTPUT_BYTES;
  const dir = await mkdtemp(join(tmpdir(), "pmb-ocr-"));
  try {
    const file = join(dir, `image${extension}`);
    await writeFile(file, image, { mode: 0o600 });
    return await new Promise((resolve, reject) => {
      execFile(command, [file, "stdout"], { timeout: timeoutMs, maxBuffer, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
        if (!error) return resolve({ text: stdout.trim(), truncated: false });
        const code = (error as { code?: unknown }).code;
        // Past the output cap the program is stopped; what it printed so far is kept.
        if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ text: stdout.trim(), truncated: true });
        if (code === "ENOENT") return reject(new OcrError(`The OCR command (PROTONMAIL_OCR_COMMAND=${command}) was not found.`));
        if (error.killed) return reject(new OcrError(`The OCR command took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped.`));
        const detail = (stderr.trim().split("\n")[0] || error.message).slice(0, 300);
        reject(new OcrError(`The OCR command failed: ${detail}`));
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
