import test from "node:test";
import assert from "node:assert/strict";
import { Logger } from "../dist/utils/logger.js";

// A cyclic object passed as log data made normalizeData recurse until RangeError. The logger runs inside
// catch blocks, so the throw became an unhandled rejection, and the server's global handler exits the process.

test("logging a cyclic object does not throw and marks the cycle", () => {
  const logger = new Logger(10);
  const a = { name: "a" };
  a.self = a;
  a.list = [a, { inner: a }];
  assert.doesNotThrow(() => logger.warn("cyclic", "test", a));
  const [entry] = logger.getLogs().entries;
  const text = JSON.stringify(entry.data);
  assert.match(text, /\[Circular\]/);
  assert.match(text, /"name":"a"/);
});

test("a very deep object is cut off instead of overflowing the stack", () => {
  const logger = new Logger(10);
  let deep = { leaf: true };
  for (let i = 0; i < 5000; i += 1) deep = { next: deep };
  assert.doesNotThrow(() => logger.warn("deep", "test", deep));
});

test("shared (non-cyclic) references are logged in full both times", () => {
  const logger = new Logger(10);
  const shared = { id: 1 };
  logger.warn("shared", "test", { a: shared, b: shared });
  const [entry] = logger.getLogs().entries;
  assert.deepEqual(entry.data, { a: { id: 1 }, b: { id: 1 } });
});
