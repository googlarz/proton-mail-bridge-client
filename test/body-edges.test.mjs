import test from "node:test";
import assert from "node:assert/strict";
import { buildReplyText, buildForwardText } from "../dist/index.js";

const detail = { from: [{ address: "a@example.com" }], to: [{ address: "o@example.com" }], cc: [], subject: "S", date: "2026-01-02T03:04:05Z", text: "orig" };

test("reply keeps the first line's indentation and drops surrounding blank lines", () => {
  const out = buildReplyText(detail, "\n\n    indented()\nnext\n\n");
  assert.ok(out.startsWith("    indented()\nnext\n\nOn "), JSON.stringify(out));
});

test("forward keeps indentation and a blank line before the forwarded block", () => {
  const out = buildForwardText(detail, "  hi\n");
  assert.ok(out.startsWith("  hi\n\n---------- Forwarded message"), JSON.stringify(out));
  assert.ok(buildForwardText(detail).startsWith("---------- Forwarded message"));
});
