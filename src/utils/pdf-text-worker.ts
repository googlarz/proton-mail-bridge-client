import { parentPort, workerData } from "node:worker_threads";
import { extractPdfTextDirect, PdfTextError } from "./pdf-text.js";

// Runs one PDF parse for extractPdfText and reports the outcome as a plain message.
const { content, maxPages, timeoutMs } = workerData as { content: Uint8Array; maxPages: number; timeoutMs: number };

try {
  const result = await extractPdfTextDirect(Buffer.from(content), { maxPages, timeoutMs });
  parentPort?.postMessage({ ok: true, result });
} catch (error) {
  const known = error instanceof PdfTextError;
  parentPort?.postMessage({
    ok: false,
    reason: known ? error.reason : "invalid",
    message: error instanceof Error ? error.message : String(error),
  });
}
