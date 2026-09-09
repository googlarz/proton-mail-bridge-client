import test from "node:test";
import assert from "node:assert/strict";
import { redactDraftAttachmentsForListing } from "../dist/index.js";

// Regression test for a real-mailbox-style finding: list_drafts has no filter and returns
// EVERY draft unconditionally, and DraftRecord.attachments carries full base64 `content`.
// createTextResult() (index.ts) serializes the whole response payload TWICE — once into
// content[0].text, again into structuredContent — so a draft with a multi-MB attachment
// roughly doubles in response size, and list_drafts sums every draft's attachments into one
// unbounded response. That can exceed the MCP stdio client's read buffer on every call,
// including the very next session's startup listing, permanently bricking list_drafts until
// the offending draft is deleted out-of-band. list_drafts' handler now maps every draft
// through redactDraftAttachmentsForListing() before returning it — mirrors how emails already
// omit attachment content in listings (EmailAttachmentSummary has no `content` field; the
// real bytes come from get_attachment_content/save_attachment).

function makeDraft(attachments) {
  return {
    id: "draft-1",
    status: "draft",
    mode: "compose",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    to: ["someone@example.com"],
    cc: [],
    bcc: [],
    subject: "Test",
    body: "Body",
    isHtml: false,
    draftMessageId: "<draft-1@local>",
    attachments,
    remoteSyncState: "local_only",
  };
}

test("redactDraftAttachmentsForListing strips base64 content and reports byte size", () => {
  // "AAAA" is 3 raw bytes of base64; use a longer realistic-looking payload so the byte
  // count isn't a degenerate edge case.
  const base64Content = Buffer.from("x".repeat(1_000_000)).toString("base64");
  const draft = makeDraft([
    { filename: "big.bin", content: base64Content, contentType: "application/octet-stream", cid: "c1", contentDisposition: "attachment" },
  ]);

  const redacted = redactDraftAttachmentsForListing(draft);

  assert.equal(redacted.attachments.length, 1);
  assert.equal(redacted.attachments[0].content, "", "attachment content must be stripped, not merely truncated");
  assert.equal(redacted.attachments[0].size, 1_000_000, "size must reflect the decoded byte length, not the base64 string length");
  assert.equal(redacted.attachments[0].filename, "big.bin");
  assert.equal(redacted.attachments[0].contentType, "application/octet-stream");
  assert.equal(redacted.attachments[0].cid, "c1");
  assert.equal(redacted.attachments[0].contentDisposition, "attachment");

  // The fix must actually shrink the response: JSON-stringifying the redacted draft must be
  // far smaller than the base64 payload alone, proving this isn't just relabeling the field.
  const serializedSize = JSON.stringify(redacted).length;
  assert.ok(serializedSize < base64Content.length / 10, `redacted draft (${serializedSize} bytes) should be far smaller than the original base64 payload (${base64Content.length} bytes)`);

  // The original draft object must be untouched — list_drafts redacts only the response it
  // sends, never the stored DraftRecord (send_draft/update_draft still need real content).
  assert.equal(draft.attachments[0].content, base64Content);
});

test("redactDraftAttachmentsForListing handles a draft with no attachments", () => {
  const draft = makeDraft([]);
  const redacted = redactDraftAttachmentsForListing(draft);
  assert.deepEqual(redacted.attachments, []);
});

test("redactDraftAttachmentsForListing preserves every other DraftRecord field unchanged", () => {
  const draft = makeDraft([{ filename: "a.txt", content: "aGVsbG8=" }]);
  const redacted = redactDraftAttachmentsForListing(draft);
  for (const key of Object.keys(draft)) {
    if (key === "attachments") continue;
    assert.deepEqual(redacted[key], draft[key], `field "${key}" must be unchanged`);
  }
});
