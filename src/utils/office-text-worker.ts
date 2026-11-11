import { extractOfficeText, OfficeTextError, type OfficeKind } from "./office-text.js";

// Child process entry for extractOfficeTextAsync (see child-job.ts): takes one job as an IPC message, sends the
// outcome back as a plain message, then idles until the parent kills it. It also leaves when the parent goes away.
process.on("disconnect", () => process.exit(0));

process.once("message", (job) => {
  const { content, kind, maxChars } = job as { content: Uint8Array; kind: OfficeKind; maxChars?: number };
  let reply: unknown;
  try {
    const result = extractOfficeText(Buffer.from(content.buffer, content.byteOffset, content.byteLength), kind, { maxChars });
    reply = { ok: true, result };
  } catch (error) {
    const known = error instanceof OfficeTextError;
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
