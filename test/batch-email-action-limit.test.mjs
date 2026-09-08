import test from "node:test";
import assert from "node:assert/strict";
import { ensureBulkBatchSize, getBulkMaxBatchSize } from "../dist/index.js";

// Mirrors the exact guard order in index.ts's `case "batch_email_action"` and
// `case "apply_thread_action"` handlers after the P2 fix: emailIds resolved
// -> ensureBulkBatchSize(emailIds.length, getBulkMaxBatchSize(args)) -> any
// mutation. Exercised directly against the same exported helpers the
// handlers call, since this repo has no MCP-dispatch-level test harness
// (see test/send-test-email-guards.test.mjs).

// Mimics index.ts's `case "batch_email_action"` handler body up to the
// point where applyBatchEmailAction (the mutation) would be invoked.
function batchEmailActionHandler(args, applyBatchEmailAction) {
  const emailIds = [...new Set(Array.isArray(args.emailIds) ? args.emailIds : [args.emailIds])];
  if (emailIds.length === 0) {
    throw new Error("emailIds must contain at least one email id.");
  }
  ensureBulkBatchSize(emailIds.length, getBulkMaxBatchSize(args));
  return applyBatchEmailAction(emailIds);
}

// Mimics index.ts's `case "apply_thread_action"` handler body up to the
// point where applyBatchEmailAction (the mutation) would be invoked, given
// an already-resolved thread's message ids (thread.messages ->
// primaryEmailId, deduped) as index.ts computes them.
function applyThreadActionHandler(args, threadMessageIds, applyBatchEmailAction) {
  const emailIds = [...new Set(threadMessageIds)];
  ensureBulkBatchSize(emailIds.length, getBulkMaxBatchSize(args));
  return applyBatchEmailAction(emailIds);
}

test("getBulkMaxBatchSize: defaults to 500 and caps a caller-supplied value at 2000", () => {
  assert.equal(getBulkMaxBatchSize({}), 500);
  assert.equal(getBulkMaxBatchSize({ maxBatchSize: 10 }), 10);
  assert.equal(getBulkMaxBatchSize({ maxBatchSize: 5000 }), 2000);
});

test("batch_email_action: emailIds array exceeding the default max (500) is rejected before any mutation", () => {
  const emailIds = Array.from({ length: 501 }, (_, i) => `INBOX::${i}`);
  let mutationCalls = 0;
  const applyBatchEmailAction = () => {
    mutationCalls += 1;
    return { results: [] };
  };

  assert.throws(
    () => batchEmailActionHandler({ emailIds }, applyBatchEmailAction),
    /exceeds limit/i,
  );
  assert.equal(mutationCalls, 0, "no mutation call must fire when the batch is rejected");
});

test("batch_email_action: emailIds array exceeding an explicitly-requested maxBatchSize is rejected before any mutation", () => {
  const emailIds = ["INBOX::1", "INBOX::2", "INBOX::3"];
  let mutationCalls = 0;
  const applyBatchEmailAction = () => {
    mutationCalls += 1;
    return { results: [] };
  };

  assert.throws(
    () => batchEmailActionHandler({ emailIds, maxBatchSize: 2 }, applyBatchEmailAction),
    /exceeds limit/i,
  );
  assert.equal(mutationCalls, 0, "no mutation call must fire when the batch is rejected");
});

test("batch_email_action: a reasonable-size array (well under the default max) still works exactly as before", () => {
  const emailIds = Array.from({ length: 50 }, (_, i) => `INBOX::${i}`);
  let mutationCalls = 0;
  let mutatedIds;
  const applyBatchEmailAction = (ids) => {
    mutationCalls += 1;
    mutatedIds = ids;
    return { results: ids.map((id) => ({ ok: true, id })) };
  };

  const result = batchEmailActionHandler({ emailIds }, applyBatchEmailAction);
  assert.equal(mutationCalls, 1, "mutation must fire exactly once for an in-limit batch");
  assert.deepEqual(mutatedIds, emailIds);
  assert.equal(result.results.length, 50);
});

test("apply_thread_action: a thread resolving to more emailIds than the default max is rejected before any mutation", () => {
  const threadMessageIds = Array.from({ length: 501 }, (_, i) => `INBOX::${i}`);
  let mutationCalls = 0;
  const applyBatchEmailAction = () => {
    mutationCalls += 1;
    return { results: [] };
  };

  assert.throws(
    () => applyThreadActionHandler({}, threadMessageIds, applyBatchEmailAction),
    /exceeds limit/i,
  );
  assert.equal(mutationCalls, 0, "no mutation call must fire when the thread's resolved batch is rejected");
});

test("apply_thread_action: a thread resolving to a reasonable-size batch still works exactly as before", () => {
  const threadMessageIds = ["INBOX::1", "INBOX::2", "INBOX::3"];
  let mutationCalls = 0;
  let mutatedIds;
  const applyBatchEmailAction = (ids) => {
    mutationCalls += 1;
    mutatedIds = ids;
    return { results: ids.map((id) => ({ ok: true, id })) };
  };

  const result = applyThreadActionHandler({}, threadMessageIds, applyBatchEmailAction);
  assert.equal(mutationCalls, 1, "mutation must fire exactly once for an in-limit batch");
  assert.deepEqual(mutatedIds, threadMessageIds);
  assert.equal(result.results.length, 3);
});
