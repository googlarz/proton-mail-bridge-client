import test from "node:test";
import assert from "node:assert/strict";
import { healthProblems } from "../dist/utils/health.js";

const base = { enabled: true, intervalMinutes: 5 };
const fresh = { isStale: false, storedMessageCount: 10 };
const now = Date.parse("2026-10-18T12:00:00Z");

test("a healthy or disabled sync reports no problem", () => {
  assert.deepEqual(healthProblems({ ...base, lastRunAt: "2026-10-18T11:58:00Z", lastSuccessAt: "2026-10-18T11:58:00Z" }, fresh, now), []);
  assert.deepEqual(healthProblems({ ...base, enabled: false, lastFailureKind: "auth" }, fresh, now), []);
  assert.deepEqual(healthProblems({ ...base, leader: false, lastFailureKind: "auth" }, fresh, now), [], "another instance runs the sync");
  assert.equal(
    healthProblems({ ...base, leader: false }, { isStale: true, storedMessageCount: 3 }, now)[0].code,
    "index_stale",
    "the shared index is still checked on an instance that does not run the sync",
  );
});

test("each failure is named with what to do about it", () => {
  assert.equal(healthProblems({ ...base, lastFailureKind: "auth" }, fresh, now)[0].code, "authentication_failed");
  const unreachable = healthProblems({ ...base, lastFailureKind: "transient", lastFailureMessage: "ECONNREFUSED" }, fresh, now)[0];
  assert.equal(unreachable.code, "bridge_unreachable");
  assert.match(unreachable.message, /ECONNREFUSED/);
  assert.equal(healthProblems({ ...base, lastRunAt: "2026-10-18T11:00:00Z", lastSuccessAt: "2026-10-18T10:00:00Z" }, fresh, now)[0].code, "sync_stalled");
  assert.equal(healthProblems({ ...base }, { isStale: true, storedMessageCount: 3 }, now)[0].code, "index_stale");
});
