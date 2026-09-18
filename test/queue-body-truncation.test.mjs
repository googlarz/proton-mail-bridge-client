import test from "node:test";
import assert from "node:assert/strict";
import { redactQueueRecordAttachments } from "../dist/index.js";

const record = (body) => ({ id: "q1", status: "queued", payload: { to: ["a@example.com"], subject: "s", body } });

test("queue record with a long body is truncated with bodyTruncated/bodyLength", () => {
  const out = redactQueueRecordAttachments(record("x".repeat(5000)));
  assert.equal(out.payload.bodyTruncated, true);
  assert.equal(out.payload.bodyLength, 5000);
  assert.ok(out.payload.body.length < 600);
});

test("queue record with a short body and no attachments is returned untouched", () => {
  const r = record("hi");
  assert.equal(redactQueueRecordAttachments(r), r);
});

test("truncating the body does not mutate the stored record", () => {
  const r = record("y".repeat(5000));
  redactQueueRecordAttachments(r);
  assert.equal(r.payload.body.length, 5000);
});
