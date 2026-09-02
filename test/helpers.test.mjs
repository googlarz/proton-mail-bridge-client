import test from "node:test";
import assert from "node:assert/strict";
import { projectFields, renderMarkdown } from "../dist/utils/helpers.js";

test("projectFields returns items unchanged when no fields are requested", () => {
  const items = [{ id: "1", subject: "Hello", from: [{ address: "a@example.com" }] }];
  assert.deepEqual(projectFields(items), items);
  assert.deepEqual(projectFields(items, []), items);
});

test("projectFields trims each item to the requested fields, always keeping id", () => {
  const items = [
    { id: "1", subject: "Hello", from: [{ address: "a@example.com" }], preview: "long body text..." },
    { id: "2", subject: "World", from: [{ address: "b@example.com" }], preview: "another long body..." },
  ];

  const trimmed = projectFields(items, ["subject"]);

  assert.deepEqual(trimmed, [
    { id: "1", subject: "Hello" },
    { id: "2", subject: "World" },
  ]);
  // id must survive even if the caller didn't ask for it — every follow-up
  // tool call (get_email_by_id, star_email, ...) needs it.
  assert.ok(trimmed.every((item) => "id" in item));
  assert.ok(!("preview" in trimmed[0]));
});

test("projectFields ignores requested fields that don't exist on the item", () => {
  const items = [{ id: "1", subject: "Hello" }];
  const trimmed = projectFields(items, ["subject", "nonexistentField"]);
  assert.deepEqual(trimmed, [{ id: "1", subject: "Hello" }]);
});

test("renderMarkdown escapes a quote in a link URL instead of letting it break out of the href attribute", () => {
  // Found live: sending markdownBody with sanitizeHtml:false (a real,
  // documented opt-out path via PROTONMAIL_ALLOW_UNSAFE_HTML) produced raw
  // outbound HTML with an attacker-controlled attribute injected into the
  // <a> tag, because the URL was interpolated into a double-quoted href
  // without escaping its own quote characters.
  const { html } = renderMarkdown('[click me](http://example.com/" onmouseover="alert(1))');
  assert.ok(!html.includes('onmouseover="alert'), `href escaping failed, got: ${html}`);
  assert.ok(html.includes('href="http://example.com/&quot; onmouseover=&quot;alert(1"'));
});

test("renderMarkdown still renders an ordinary link correctly", () => {
  const { html } = renderMarkdown("[Anthropic](https://anthropic.com)");
  assert.equal(html, '<p><a href="https://anthropic.com">Anthropic</a></p>');
});

test("renderMarkdown rejects a non-http(s)/mailto scheme link (e.g. javascript:) by falling back to #", () => {
  const { html } = renderMarkdown("[click](javascript:alert(1))");
  assert.ok(html.includes('href="#"'), `expected unsafe scheme to be neutralized, got: ${html}`);
});
