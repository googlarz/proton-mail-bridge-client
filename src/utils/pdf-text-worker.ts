import { extractPdfTextDirect, PdfTextError } from "./pdf-text.js";

// Child process entry for extractPdfText (see child-job.ts): takes one job as an IPC message, sends the outcome
// back as a plain message, then idles until the parent kills it. It also leaves when the parent goes away.
process.on("disconnect", () => process.exit(0));

process.once("message", async (job) => {
  const { content, maxPages, timeoutMs, ocrPages } = job as { content: Uint8Array; maxPages: number; timeoutMs: number; ocrPages: number };
  let reply: unknown;
  try {
    const result = await extractPdfTextDirect(Buffer.from(content), { maxPages, timeoutMs, ocrPages });
    reply = { ok: true, result };
  } catch (error) {
    const known = error instanceof PdfTextError;
    reply = {
      ok: false,
      reason: known ? error.reason : "invalid",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  process.send?.(reply, (error) => {
    if (error) process.exit(1);
  });
});
