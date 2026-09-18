import test from "node:test";
import assert from "node:assert/strict";
import { buildReplyHtml, buildForwardHtml } from "../dist/index.js";

// Regression test for an externally-reported bug (code review of 7c36bae / v2.1.3):
// a markdown-authored reply/forward (markdownBody) renders its own new text to a
// real, separate htmlBody — but the original quoted/forwarded message was only
// ever merged into the PLAIN TEXT body (via buildReplyText/buildForwardText),
// never into htmlBody. An HTML-viewing recipient of a markdown reply/forward saw
// only the new text and signature, with the original message missing entirely —
// confirmed on generated MIME messages. buildReplyHtml/buildForwardHtml are the
// html counterparts, now merged into htmlBody the same way buildReplyText/
// buildForwardText already were into the plain-text body.

function detail(overrides = {}) {
  return {
    id: "INBOX::1",
    from: [{ address: "sender@example.com", name: "Sender" }],
    to: [{ address: "me@example.com", name: "Me" }],
    cc: [],
    subject: "Original subject",
    date: "2026-01-01T00:00:00.000Z",
    text: "Original plain text body.",
    ...overrides,
  };
}

test("buildReplyHtml merges the original message's real HTML into the new htmlBody", () => {
  const original = detail({ html: "<p>Original <b>rich</b> body.</p>" });
  const result = buildReplyHtml(original, "<p>My new reply.</p>");
  assert.ok(result.includes("<p>My new reply.</p>"), "new content must still be present");
  assert.ok(result.includes("<p>Original <b>rich</b> body.</p>"), "the original message's own HTML must be merged in, not dropped");
  assert.ok(result.includes("wrote:"), "should attribute the quoted original to its sender");
});

test("buildReplyHtml falls back to escaping detail.text when the original has no HTML part", () => {
  const original = detail({ text: "Plain original with <angle> brackets." });
  const result = buildReplyHtml(original, "<p>My reply.</p>");
  assert.ok(result.includes("Plain original with &lt;angle&gt; brackets."), "plain-text fallback must be HTML-escaped, not injected raw");
  assert.ok(!result.includes("<angle>"), "an unescaped literal tag-looking fragment must not survive into the HTML");
});

test("buildForwardHtml merges the original message's HTML into the new htmlBody", () => {
  const original = detail({ html: "<p>Forwarded original content.</p>", subject: "Quarterly numbers" });
  const result = buildForwardHtml(original, "<p>FYI, see below.</p>");
  assert.ok(result.includes("<p>FYI, see below.</p>"), "new note must still be present");
  assert.ok(result.includes("<p>Forwarded original content.</p>"), "the original message's own HTML must be merged in, not dropped");
  assert.ok(result.includes("Forwarded message"), "should carry the forwarded-message marker");
  assert.ok(result.includes("Quarterly numbers"), "should carry the original subject");
});

test("buildForwardHtml works with no introductory note", () => {
  const original = detail({ html: "<p>Just the original.</p>" });
  const result = buildForwardHtml(original, undefined);
  assert.ok(result.includes("<p>Just the original.</p>"));
});
