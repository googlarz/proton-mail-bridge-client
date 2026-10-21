// Reading a tool's arguments: the checks every handler repeats, and the note about arguments a tool does not declare.

import { TOOLS } from "./definitions.js";
import { type EmailAction, type EmailAttachmentInput } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { type BodyEdit } from "../services/draft-store-service.js";
// Validates update_draft's `bodyEdits` argument into BodyEdit[] (shape only; whether each
// find text is present/unambiguous is decided against the stored body by applyBodyEdits).
export function parseBodyEdits(value: unknown): BodyEdit[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new McpError(ErrorCode.InvalidParams, "bodyEdits must be a non-empty array of {find, replace, all?} objects.");
  }
  return value.map((entry, index) => {
    const edit = asObject(entry);
    if (typeof edit.find !== "string" || edit.find.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, `bodyEdits[${index}].find must be a non-empty string.`);
    }
    if (typeof edit.replace !== "string") {
      throw new McpError(ErrorCode.InvalidParams, `bodyEdits[${index}].replace must be a string (use "" to delete the text).`);
    }
    return { find: edit.find, replace: edit.replace, ...(edit.all === true ? { all: true } : {}) };
  });
}

// Arguments a tool does not declare are ignored (clients send extra fields, and refusing them would break
// those clients), but silently: `folder` on get_threads did nothing for a long time and nobody was told. The
// result now carries a note naming them, so the caller (usually a model) learns the argument had no effect.
export function ignoredArguments(toolName: string, args: unknown): string[] {
  const tool = TOOLS.find((candidate) => candidate.name === toolName);
  if (!tool || !args || typeof args !== "object" || Array.isArray(args)) {
    return [];
  }
  const declared = new Set(Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}));
  return Object.keys(args).filter((key) => !declared.has(key));
}

export function withIgnoredArgumentsNote<R extends { params: { name: string; arguments?: unknown } }, T extends { content: unknown[] }>(
  handler: (request: R) => Promise<T>,
): (request: R) => Promise<T> {
  return async (request) => {
    const result = await handler(request);
    const ignored = ignoredArguments(request.params.name, request.params.arguments);
    if (ignored.length === 0) {
      return result;
    }
    // The names come from the caller; keep the note short however many or however long they are.
    const shown = ignored.slice(0, 10).map((key) => `"${key.length > 64 ? `${key.slice(0, 64)}...` : key}"`);
    if (ignored.length > shown.length) shown.push(`and ${ignored.length - shown.length} more`);
    logger.warn("Tool call had arguments the tool does not accept", "MCPServer", { name: request.params.name, ignored: shown });
    const tool = TOOLS.find((candidate) => candidate.name === request.params.name);
    const accepted = Object.keys((tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {});
    const note = `Note: ${request.params.name} does not accept ${shown.join(", ")}; ignored. ` +
      (accepted.length > 0 ? `It accepts: ${accepted.join(", ")}.` : "It takes no arguments.");
    return { ...result, content: [...result.content, { type: "text", text: note }] };
  };
}

export function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new McpError(ErrorCode.InvalidParams, `${key} must be a non-empty string.`);
  }
  return value.trim();
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// Found live (external review): update_draft's body:'' and replyTo:'' both
// returned success but left the old values in place — optionalString collapses
// an explicitly-empty string to undefined the same as an omitted field
// entirely, and DraftStoreService.updateDraft's patch treats undefined as
// "don't touch this field" (`patch.body ?? existing.body`). So there was no
// way to actually clear either field once set — only used for update_draft's
// body/replyTo, which are the two fields the review confirmed this breaks
// (cc/bcc/attachments already have their own clear path via
// `args.x === undefined ? undefined : ...`, checked separately). Not applied
// to optionalString itself, since most of its many other callers legitimately
// want "" treated the same as "not provided".
export function optionalClearableString(args: Record<string, unknown>, key: string): string | undefined {
  if (!(key in args) || args[key] === undefined) {
    return undefined;
  }
  return typeof args[key] === "string" ? (args[key] as string).trim() : undefined;
}

export function parseFieldsArg(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  }
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
  return undefined;
}

export function parseListValues(value?: string): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseStringListArg(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return parseListValues(value);
  }

  throw new McpError(ErrorCode.InvalidParams, `${key} must be a non-empty string or string array.`);
}

export function requireEmailAction(args: Record<string, unknown>, key = "action"): EmailAction {
  const value = requireString(args, key);
  switch (value) {
    case "mark_read":
    case "mark_unread":
    case "star":
    case "unstar":
    case "archive":
    case "trash":
    case "restore":
    case "move":
    case "delete":
      return value;
    default:
      throw new McpError(ErrorCode.InvalidParams, `${key} must be a supported email action.`);
  }
}

export function optionalAttachmentList(value: unknown): EmailAttachmentInput[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new McpError(ErrorCode.InvalidParams, "attachments must be an array.");
  }

  return value.map((item, index) => {
    const attachment = asObject(item);
    const filename = requireString(attachment, "filename");
    const content = requireString(attachment, "content");
    const contentType = optionalString(attachment, "contentType");
    const cid = optionalString(attachment, "cid");
    const contentDisposition = optionalString(attachment, "contentDisposition");

    if (!filename || !content) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `attachments[${index}] must contain filename and content.`,
      );
    }

    return {
      filename,
      content,
      contentType,
      cid,
      contentDisposition,
    };
  });
}
