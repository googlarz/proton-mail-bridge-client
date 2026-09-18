import test from "node:test";
import assert from "node:assert/strict";
import { redactQueueRecordAttachments } from "../dist/index.js";

// Regression test for an externally-reported bug (performance review of 7c36bae /
// v2.1.3): list_scheduled_sends returned every queue record's full base64
// attachment content — ~955k tokens for a single 1 MiB attachment, on canceled
// records too, with no filter/cap. Same fix pattern as
// redactDraftAttachmentsForListing (already applied to list_drafts/get_draft/
// create_draft/update_draft/sync_draft_to_remote), for the delivery queue's own
// record shape (payload.attachments instead of attachments directly).

function makeRecord(attachments, overrides = {}) {
  return {
    id: "queue-1",
    kind: "scheduled_send",
    createdAt: "2026-01-01T00:00:00.000Z",
    sendAt: "2026-01-02T00:00:00.000Z",
    status: "pending",
    payload: {
      to: ["someone@example.com"],
      subject: "Test",
      body: "Body",
      isHtml: false,
      attachments,
    },
    ...overrides,
  };
}

test("redactQueueRecordAttachments strips base64 content and reports byte size", () => {
  const base64Content = Buffer.from("x".repeat(1_000_000)).toString("base64");
  const record = makeRecord([
    { filename: "big.bin", content: base64Content, contentType: "application/octet-stream", cid: "c1", contentDisposition: "attachment" },
  ]);

  const redacted = redactQueueRecordAttachments(record);

  assert.equal(redacted.payload.attachments.length, 1);
  assert.equal(redacted.payload.attachments[0].content, "", "attachment content must be stripped");
  assert.equal(redacted.payload.attachments[0].size, 1_000_000, "size must reflect decoded byte length");
  assert.equal(redacted.payload.attachments[0].filename, "big.bin");

  const serializedSize = JSON.stringify(redacted).length;
  assert.ok(serializedSize < base64Content.length / 10, `redacted record (${serializedSize} bytes) should be far smaller than the original base64 payload (${base64Content.length} bytes)`);

  // Original record must be untouched.
  assert.equal(record.payload.attachments[0].content, base64Content);
});

test("redactQueueRecordAttachments redacts a canceled record just like a pending one", () => {
  const base64Content = Buffer.from("y".repeat(500_000)).toString("base64");
  const record = makeRecord([{ filename: "f.bin", content: base64Content }], { status: "canceled" });
  const redacted = redactQueueRecordAttachments(record);
  assert.equal(redacted.payload.attachments[0].content, "");
  assert.equal(redacted.status, "canceled");
});

test("redactQueueRecordAttachments is a no-op for a record with no attachments", () => {
  const record = makeRecord(undefined);
  const redacted = redactQueueRecordAttachments(record);
  assert.deepEqual(redacted, record);
});

test("redactQueueRecordAttachments preserves every other field unchanged", () => {
  const record = makeRecord([{ filename: "a.txt", content: "aGVsbG8=" }]);
  const redacted = redactQueueRecordAttachments(record);
  for (const key of Object.keys(record)) {
    if (key === "payload") continue;
    assert.deepEqual(redacted[key], record[key], `field "${key}" must be unchanged`);
  }
  for (const key of Object.keys(record.payload)) {
    if (key === "attachments") continue;
    assert.deepEqual(redacted.payload[key], record.payload[key], `payload field "${key}" must be unchanged`);
  }
});
