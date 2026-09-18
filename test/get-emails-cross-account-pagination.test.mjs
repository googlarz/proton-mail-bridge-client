import test from "node:test";
import assert from "node:assert/strict";
import { paginateMergedAccountResults } from "../dist/index.js";

// Regression test for an externally-reported bug (code review of 95d1d2c / v2.1.2):
// get_emails applied `offset` separately to EACH account's own page BEFORE merging
// them into one newest-first timeline. Reproduced with four interleaved messages
// across two accounts: page 2 (offset=1, limit=1 in the minimal repro below) skips
// the second-newest message overall, because each account's own offset=1 slice
// already dropped its own newest item independently, rather than the merge
// dropping only the single globally-newest item across both accounts combined.
//
// The fix: fetch each account from offset 0 up to (offset + limit) — since each
// account's own list already arrives newest-first, that's guaranteed to capture
// everything that could rank in the global top (offset + limit) — merge, re-sort,
// then paginate the MERGED superset. paginateMergedAccountResults is exactly that
// last step, extracted so this scenario is testable without any IMAP mocking.

function email(id, date) {
  return { id, date };
}

test("paginateMergedAccountResults: page 2 across two interleaved accounts includes the second-newest message", () => {
  // Account A: messages at t=4 (newest) and t=2.
  // Account B: messages at t=3 and t=1 (oldest).
  // Global newest-first order: t4, t3, t2, t1.
  const accountA = [email("a::4", "2026-01-04T00:00:00.000Z"), email("a::2", "2026-01-02T00:00:00.000Z")];
  const accountB = [email("b::3", "2026-01-03T00:00:00.000Z"), email("b::1", "2026-01-01T00:00:00.000Z")];

  // Old (buggy) behavior would fetch each account with offset=1,limit=1 BEFORE
  // merging — i.e. only "a::2" and "b::1" — entirely missing "b::3", the true
  // second-newest message overall. The fix instead fetches offset=0,limit=(1+1)=2
  // from each account (simulated here by just using the full per-account lists,
  // which already satisfy that depth), merges, sorts, and paginates the merged set.
  const merged = [...accountA, ...accountB].sort(
    (left, right) => new Date(right.date).getTime() - new Date(left.date).getTime(),
  );

  const { page, hasMore } = paginateMergedAccountResults(merged, 1, 1);

  assert.deepEqual(page.map((e) => e.id), ["b::3"], "page 2 (offset=1, limit=1) must be the second-newest message overall, not an account-local offset artifact");
  assert.equal(hasMore, true, "two more messages remain (t2, t1) beyond this page");
});

test("paginateMergedAccountResults: offset 0 returns the newest item first", () => {
  const merged = [email("x", "2026-01-03T00:00:00.000Z"), email("y", "2026-01-02T00:00:00.000Z"), email("z", "2026-01-01T00:00:00.000Z")];
  const { page, hasMore } = paginateMergedAccountResults(merged, 0, 2);
  assert.deepEqual(page.map((e) => e.id), ["x", "y"]);
  assert.equal(hasMore, true);
});

test("paginateMergedAccountResults: hasMore is false once the page reaches the end of the merged set", () => {
  const merged = [email("x", "2026-01-02T00:00:00.000Z"), email("y", "2026-01-01T00:00:00.000Z")];
  const { page, hasMore } = paginateMergedAccountResults(merged, 1, 5);
  assert.deepEqual(page.map((e) => e.id), ["y"]);
  assert.equal(hasMore, false);
});

test("paginateMergedAccountResults: an offset past the end returns an empty page, not an error", () => {
  const merged = [email("x", "2026-01-01T00:00:00.000Z")];
  const { page, hasMore } = paginateMergedAccountResults(merged, 10, 5);
  assert.deepEqual(page, []);
  assert.equal(hasMore, false);
});

// Regression test for an externally-reported bug (third-pass review of e9773e4 /
// v2.1.6): get_emails' hasMore was computed from the raw, UNFILTERED mailbox
// message count (300 in the report) even when a restrictive filter like
// beforeUid narrowed the actual matching results down to far fewer (2 in the
// report) — comparing 300 against the requested offset+limit reported
// hasMore:true with nothing left to page to. The fix is at the call site
// (get_emails now overfetches ONE extra item beyond offset+limit so a next
// page can be directly observed instead of inferred from any total), but the
// underlying paginateMergedAccountResults call is exactly this: with a merged
// set of only the 2 messages that actually matched the filter, hasMore must be
// false regardless of what the raw mailbox total claims.
test("paginateMergedAccountResults: hasMore reflects the (possibly filtered) merged set, not an unrelated larger total", () => {
  // Simulates beforeUid narrowing a 300-message mailbox down to 2 matches —
  // the merged set passed in is just those 2, not 300.
  const filteredMerged = [email("a", "2026-01-02T00:00:00.000Z"), email("b", "2026-01-01T00:00:00.000Z")];
  const { page, hasMore } = paginateMergedAccountResults(filteredMerged, 0, 25);
  assert.deepEqual(page.map((e) => e.id), ["a", "b"], "both matching messages must be returned");
  assert.equal(hasMore, false, "hasMore must be false — no more FILTERED results exist, even though the raw mailbox has far more messages");
});
