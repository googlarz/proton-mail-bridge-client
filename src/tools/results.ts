// The shape of what a tool answers with, and the one function that builds it (text, structured content and links to the messages it names).

import type { CitationSource } from "../types/index.js";
import { normalizeJsonValue, stringifyForJson } from "../utils/helpers.js";

export type ToolResult = {
  content: Array<
    | { type: "text"; text: string }
    | {
        type: "resource_link";
        uri: string;
        name: string;
        title?: string;
        description?: string;
        mimeType?: string;
      }
    | { type: "image"; data: string; mimeType: string }
  >;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export function citationToResourceLink(source: CitationSource): ToolResult["content"][number] {
  return {
    type: "resource_link",
    uri: source.uri,
    name: source.name,
    title: source.title,
  };
}

export function normalizeStructuredContent(value: unknown): Record<string, unknown> | undefined {
  const normalized = normalizeJsonValue(value);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    return undefined;
  }
  return normalized as Record<string, unknown>;
}

// Found live (self-review, token-efficiency pass): this used to merge the full
// CitationSource[] (uri, name, title, description, mimeType, provider, AND a
// locator object repeating id/folder/from/subject/date) into the returned
// payload — which then got serialized into content[0].text AND, separately,
// into structuredContent (createTextResult always builds both). For a
// search/list-style tool, almost every field in each source is ALREADY present
// on the corresponding item in the tool's own result array (e.g.
// search_indexed_emails' sources[].snippet duplicates emails[].preview
// character-for-character, sources[].locator.subject duplicates
// emails[].subject, etc.) — confirmed live at roughly doubling a 10-result
// search's response size for zero new information. The same citation data is
// already emitted, far more compactly, as its own resource_link content block
// per source (see citationToResourceLink below) — no code in this repo (CLI,
// tests, or index.ts itself) ever reads a result's `.sources` field back, so
// nothing depends on it being embedded in the payload too. Kept as a
// pass-through function (not deleted) so createTextResult's call sites don't
// all need touching if a real reason to re-add a *trimmed* sources field ever
// comes up.
export function withSources<T>(value: T, _sources: CitationSource[]): T {
  return value;
}

export function createTextResult(
  value: unknown,
  isError = false,
  sources: CitationSource[] = [],
): ToolResult {
  const payload = withSources(value, sources);
  return {
    content: [
      { type: "text", text: typeof payload === "string" ? payload : stringifyForJson(payload) },
      ...sources.map(citationToResourceLink),
    ],
    structuredContent: normalizeStructuredContent(payload),
    ...(isError ? { isError: true } : {}),
  };
}
