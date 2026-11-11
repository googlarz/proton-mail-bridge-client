import { serveJob } from "./child-job.js";
import { extractPdfTextDirect, PdfTextError } from "./pdf-text.js";

// Entry of the job that extractPdfText runs in a child process (or, inside Electron, a worker thread): one PDF
// parse, reported as a plain message.
serveJob(async (job) => {
  const { content, maxPages, timeoutMs, ocrPages } = job as { content: Uint8Array; maxPages: number; timeoutMs: number; ocrPages: number };
  try {
    const result = await extractPdfTextDirect(Buffer.from(content), { maxPages, timeoutMs, ocrPages });
    return { ok: true, result };
  } catch (error) {
    const known = error instanceof PdfTextError;
    return {
      ok: false,
      reason: known ? error.reason : "invalid",
      message: error instanceof Error ? error.message : String(error),
    };
  }
});
