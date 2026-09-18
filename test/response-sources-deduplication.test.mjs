import test from "node:test";
import assert from "node:assert/strict";
import { withSources } from "../dist/index.js";

// Regression test for a token-efficiency issue found via live testing (v2.1.8):
// createTextResult used to merge the full CitationSource[] (uri, name, title,
// description, mimeType, provider, and a locator object repeating id/folder/
// from/subject/date) into the JSON payload — which then got serialized TWICE
// (content[0].text and structuredContent). For a search/list-style tool,
// almost every field in each source duplicates a field already on the
// corresponding item in the tool's own result array — confirmed live on
// search_indexed_emails: sources[].snippet was character-for-character the
// same as emails[].preview, roughly doubling a 10-result search's response
// size for zero new information the resource_link content blocks (built
// separately, unaffected by this) didn't already carry more compactly. No
// code anywhere in this repo ever read a result's `.sources` field back.

test("withSources no longer embeds a sources field into the payload", () => {
  const value = { total: 2, emails: [{ id: "a" }, { id: "b" }] };
  const sources = [
    { uri: "protonmail://email/a", name: "a", title: "Subject A", description: "desc" },
    { uri: "protonmail://email/b", name: "b", title: "Subject B", description: "desc" },
  ];
  const result = withSources(value, sources);
  assert.deepEqual(result, value, "the payload must be returned completely unchanged");
  assert.equal("sources" in result, false, "no sources key should be added");
});

test("withSources returns the same reference for a primitive/array value (no-op regardless)", () => {
  assert.equal(withSources("plain string", [{ uri: "x" }]), "plain string");
  const arr = [1, 2, 3];
  assert.equal(withSources(arr, [{ uri: "x" }]), arr);
});

test("withSources with an empty sources array still returns the value unchanged", () => {
  const value = { a: 1 };
  assert.deepEqual(withSources(value, []), value);
});
