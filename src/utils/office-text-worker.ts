import { serveJob } from "./child-job.js";
import { extractOfficeText, OfficeTextError, type OfficeKind } from "./office-text.js";

// Entry of the job that extractOfficeTextAsync runs in a child process (or, inside Electron, a worker thread): one
// Office extraction, reported as a plain message.
serveJob((job) => {
  const { content, kind, maxChars } = job as { content: Uint8Array; kind: OfficeKind; maxChars?: number };
  try {
    const result = extractOfficeText(Buffer.from(content.buffer, content.byteOffset, content.byteLength), kind, { maxChars });
    return { ok: true, result };
  } catch (error) {
    const known = error instanceof OfficeTextError;
    return {
      ok: false,
      reason: known ? error.reason : "invalid",
      message: error instanceof Error ? error.message : String(error),
    };
  }
});
