import test from "node:test";
import assert from "node:assert/strict";
import { newestEmail, sortEmailsByNewest } from "../dist/utils/helpers.js";

// newestEmail replaces "sort everything, take the first" in thread building; it must pick the same message.

const mail = (uid, internalDate, date) => ({ uid, internalDate, date });

test("newestEmail picks what sortEmailsByNewest would put first", () => {
  const cases = [
    [mail(1, "2026-01-01T00:00:00Z"), mail(2, "2026-03-01T00:00:00Z"), mail(3, "2026-02-01T00:00:00Z")],
    [mail(1, undefined, "2026-05-01T00:00:00Z"), mail(2, "2026-04-01T00:00:00Z", "2026-09-01T00:00:00Z")],
    [mail(4, "2026-01-01T00:00:00Z"), mail(9, "2026-01-01T00:00:00Z"), mail(7, "2026-01-01T00:00:00Z")],
    [mail(5, undefined, undefined), mail(6, undefined, undefined)],
    [mail(3, "2026-01-01T00:00:00Z")],
  ];
  for (const emails of cases) assert.equal(newestEmail(emails), sortEmailsByNewest(emails)[0]);
  assert.equal(newestEmail([]), undefined);
});

test("sortEmailsByNewest orders by time, then uid, newest first, without touching its input", () => {
  const input = [mail(1, "2026-01-01T00:00:00Z"), mail(2, "2026-03-01T00:00:00Z"), mail(3, "2026-03-01T00:00:00Z")];
  const copy = [...input];
  assert.deepEqual(sortEmailsByNewest(input).map((e) => e.uid), [3, 2, 1]);
  assert.deepEqual(input, copy);
});
