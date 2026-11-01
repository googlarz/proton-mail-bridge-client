import test from "node:test";
import assert from "node:assert/strict";
import { trimSlashes } from "../dist/utils/helpers.js";
import { assertScalesWithInput } from "./helpers/scaling.mjs";

const OLD = /^\/+|\/+$/g;
const OLD_TRAILING = /\/+$/;

test("trimSlashes matches the regex it replaced on normal and edge inputs", () => {
  for (const input of ["", "/", "///", "a", "/a", "a/", "//a//", "a/b", "/a/b/", "//a//b//", "a//b", "INBOX", "/ a /", "a/ /"]) {
    assert.equal(trimSlashes(input), input.replace(OLD, ""), JSON.stringify(input));
    assert.equal(trimSlashes(input, false), input.replace(OLD_TRAILING, ""), `trailing only ${JSON.stringify(input)}`);
  }
  assert.equal(trimSlashes("//a//b//"), "a//b");
});

test("trimSlashes is linear on a long run of inner slashes", () => {
  assertScalesWithInput("trimSlashes a///x", (n) => `a${"/".repeat(n)}x`, (s) => trimSlashes(s), 50_000);
  assertScalesWithInput("trimSlashes a///x, trailing only", (n) => `a${"/".repeat(n)}x`, (s) => trimSlashes(s, false), 50_000);
});
