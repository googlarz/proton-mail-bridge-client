import test from "node:test";
import assert from "node:assert/strict";
import { isNoopDraftPatch } from "../dist/index.js";

const draft = { id: "d1", to: ["a@example.com"], cc: [], subject: "Hi", body: "text", isHtml: false, priority: "normal", attachments: [], notes: "n" };

test("patch with only undefined fields is a no-op", () => {
  assert.equal(isNoopDraftPatch(draft, { subject: undefined, body: undefined }), true);
});

test("patch restating current values is a no-op", () => {
  assert.equal(isNoopDraftPatch(draft, { subject: "Hi", to: ["a@example.com"], isHtml: false, priority: "normal" }), true);
});

test("any changed field is not a no-op", () => {
  assert.equal(isNoopDraftPatch(draft, { subject: "Changed" }), false);
  assert.equal(isNoopDraftPatch(draft, { to: ["b@example.com"] }), false);
  assert.equal(isNoopDraftPatch(draft, { isHtml: true }), false);
});

test("clearing an unset string field with '' is a no-op, clearing a set one is not", () => {
  assert.equal(isNoopDraftPatch(draft, { replyTo: "" }), true);
  assert.equal(isNoopDraftPatch(draft, { body: "" }), false);
});
