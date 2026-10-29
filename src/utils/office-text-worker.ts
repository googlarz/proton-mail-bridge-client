import { parentPort, workerData } from "node:worker_threads";
import { extractOfficeText, OfficeTextError, type OfficeKind } from "./office-text.js";

// Runs one Office extraction for extractOfficeTextAsync and reports the outcome as a plain message.
const { content, kind, maxChars } = workerData as { content: Uint8Array; kind: OfficeKind; maxChars?: number };

try {
  const result = extractOfficeText(Buffer.from(content.buffer, content.byteOffset, content.byteLength), kind, { maxChars });
  parentPort?.postMessage({ ok: true, result });
} catch (error) {
  const known = error instanceof OfficeTextError;
  parentPort?.postMessage({
    ok: false,
    reason: known ? error.reason : "invalid",
    message: error instanceof Error ? error.message : String(error),
  });
}
