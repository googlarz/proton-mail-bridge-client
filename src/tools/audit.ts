// Recording what a tool did in the audit log, with secrets and message text taken out of the arguments.

import { logger } from "../utils/logger.js";
import { AuditService } from "../services/audit-service.js";
import { asObject } from "./args.js";
// Bounded on purpose. The audited `result` of a handler can contain arbitrary objects —
// found live: list_scheduled_sends/list_snoozed returned `{ bundle, items }` per account
// from inside withAudit, and once an account had an open IMAP connection the recursive
// walk through the bundle's services/sockets overflowed the stack ("Maximum call stack
// size exceeded"), failing the whole tool call. So: never descend into class instances
// (services, sockets, clients), never into an account bundle, stop on cycles, and cap depth.
export const AUDIT_MAX_DEPTH = 8;

// The audit log records what was done, not the content of the mail or any secret. Message text can arrive under
// many names (body, markdownBody, htmlBody, a draft's notes, the find/replace of body edits, a raw .eml...), so
// every one of them is redacted by key; credential-like keys are caught by pattern.
export const AUDIT_REDACTED_KEYS = new Set([
  "body", "html", "text", "htmlBody", "textBody", "markdownBody", "customMessage", "notes", "bodyEdits",
  "raw", "rawBase64", "base64", "content", "find", "replace", "signature",
  // Parts of a received message that a tool result could carry: a preview or attachment text can hold a code or a secret.
  "preview", "snippet", "attachmentText", "latestPreview",
]);

export const AUDIT_SECRET_KEY = /pass(word|wd|phrase)?$|secret|token|api[-_]?key|authoriz|credential|cookie|private[-_]?key/i;

export function sanitizeAuditValue(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === undefined || value === null) {
    return value;
  }

  if (typeof value === "string") {
    return value.length > 300 ? `[redacted:${value.length} chars]` : value;
  }

  if (typeof value !== "object") {
    return value;
  }

  if (depth >= AUDIT_MAX_DEPTH) {
    return "[max depth]";
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeAuditValue(item, depth + 1, seen));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return `[${(value as object).constructor?.name ?? "object"}]`;
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => {
        if (AUDIT_REDACTED_KEYS.has(key) || AUDIT_SECRET_KEY.test(key)) {
          return [key, "[redacted]"];
        }

        if (key === "bundle") {
          return [key, "[account bundle]"];
        }

        if (key === "attachments" && Array.isArray(entryValue)) {
          return [
            key,
            entryValue.map((attachment) => {
              const object = asObject(attachment);
              return {
                filename: object.filename,
                contentType: object.contentType,
                cid: object.cid,
              };
            }),
          ];
        }

        return [key, sanitizeAuditValue(entryValue, depth + 1, seen)];
      }),
    );
  } finally {
    // Only ancestors count as a cycle; the same object reachable twice is fine.
    seen.delete(value);
  }
}

export async function withAudit<T>(
  auditService: AuditService,
  tool: string,
  input: Record<string, unknown>,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  // Writing the audit entry is bookkeeping about an operation that has already happened. If it fails (disk
  // full, a locked file), the failure is logged and swallowed: raising it turned a successful move or send
  // into a tool error, so a client would retry it, and on the error path it would hide the real error.
  const record = async (entry: Parameters<AuditService["record"]>[0]) => {
    try {
      await auditService.record(entry);
    } catch (auditError) {
      logger.error("Could not write the audit entry", "MCPServer", { tool, error: auditError });
    }
  };
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    await record({
      timestamp: new Date().toISOString(),
      tool,
      status: "error",
      durationMs: Date.now() - startedAt,
      input: sanitizeAuditValue(input),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  await record({
    timestamp: new Date().toISOString(),
    tool,
    status: "success",
    durationMs: Date.now() - startedAt,
    input: sanitizeAuditValue(input),
    result: sanitizeAuditValue(result),
  });
  return result;
}
