import test from "node:test";
import assert from "node:assert/strict";
import { truncateDraftBodyForResponse } from "../dist/index.js";

// Regression test for an externally-reported bug (repeated across three review
// rounds against 7c36bae/a292ab6/e9773e4): create_draft, update_draft,
// create_reply_draft, create_forward_draft, create_thread_reply_draft,
// sync_draft_to_remote, and list_drafts all echoed a draft's COMPLETE body back
// — confirmed live at ~40k tokens for a single update_draft call that only
// changed the subject of a ~202 KB draft, and ~261k tokens for list_drafts with
// 107 drafts. Same "caller already knows what it sent" reasoning as
// redactDraftAttachmentsForListing, applied to the text body instead of base64
// attachment content.

test("truncateDraftBodyForResponse leaves a short body untouched", () => {
  const draft = { id: "d1", body: "Short body." };
  const result = truncateDraftBodyForResponse(draft);
  assert.equal(result.body, "Short body.");
  assert.equal(result.bodyTruncated, undefined, "no truncation metadata should be added when nothing was truncated");
  assert.equal(result.bodyLength, undefined);
});

test("truncateDraftBodyForResponse truncates a long body and reports its real length", () => {
  const longBody = "x".repeat(200_000);
  const draft = { id: "d1", body: longBody };
  const result = truncateDraftBodyForResponse(draft);
  assert.ok(result.body.length < longBody.length, "the response body must be shorter than the original");
  assert.equal(result.bodyTruncated, true);
  assert.equal(result.bodyLength, 200_000, "bodyLength must reflect the ORIGINAL body's real length, not the truncated preview's");
});

test("truncateDraftBodyForResponse preserves every other field unchanged", () => {
  const draft = { id: "d1", subject: "Test", body: "x".repeat(1000), attachments: [] };
  const result = truncateDraftBodyForResponse(draft);
  assert.equal(result.id, "d1");
  assert.equal(result.subject, "Test");
  assert.deepEqual(result.attachments, []);
});

test("truncateDraftBodyForResponse does not mutate the original draft object", () => {
  const longBody = "y".repeat(10_000);
  const draft = { id: "d1", body: longBody };
  truncateDraftBodyForResponse(draft);
  assert.equal(draft.body, longBody, "the original draft's body must be untouched");
});
