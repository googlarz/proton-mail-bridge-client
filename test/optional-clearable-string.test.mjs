import test from "node:test";
import assert from "node:assert/strict";
import { optionalClearableString } from "../dist/index.js";

// Regression test for an externally-reported bug (review of e9773e4 / v2.1.7):
// update_draft's body:'' and replyTo:'' both returned success but left the old
// values in place. optionalString (the generic helper most other tools use)
// collapses an explicitly-empty string to undefined the same as an omitted
// field entirely, and DraftStoreService.updateDraft's patch treats undefined
// as "don't touch this field" — so there was no way to actually clear either
// field once set. optionalClearableString distinguishes "key absent" (no
// change) from "key present but empty" (explicit clear).

test("optionalClearableString returns undefined when the key is absent (no change)", () => {
  assert.equal(optionalClearableString({}, "body"), undefined);
});

test("optionalClearableString returns an empty string when the key is explicitly empty (clear the field)", () => {
  assert.equal(optionalClearableString({ body: "" }, "body"), "");
  assert.equal(optionalClearableString({ replyTo: "   " }, "replyTo"), "", "whitespace-only counts as an explicit clear too");
});

test("optionalClearableString returns the trimmed value when present and non-empty", () => {
  assert.equal(optionalClearableString({ body: "  hello  " }, "body"), "hello");
});

test("optionalClearableString returns undefined for an explicit null or non-string value", () => {
  assert.equal(optionalClearableString({ body: null }, "body"), undefined);
  assert.equal(optionalClearableString({ body: 42 }, "body"), undefined);
});
