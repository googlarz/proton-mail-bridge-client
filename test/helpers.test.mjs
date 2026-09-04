import test from "node:test";
import assert from "node:assert/strict";
import { createEmailId, foldQuotedHistory, htmlToMarkdown, parseEmailId, projectFields, renderMarkdown } from "../dist/utils/helpers.js";

test("htmlToMarkdown preserves links, emphasis, and lists instead of stripping them", () => {
  const html = "<h1>Hello</h1><p>This is <b>bold</b> and a <a href=\"https://example.com\">link</a>.</p><ul><li>one</li><li>two</li></ul>";
  const markdown = htmlToMarkdown(html);
  assert.match(markdown, /# Hello/);
  assert.match(markdown, /\*\*bold\*\*/);
  assert.match(markdown, /\[link\]\(https:\/\/example\.com\)/);
  assert.match(markdown, /one/);
  assert.match(markdown, /two/);
});

test("htmlToMarkdown replaces images with an alt-text marker instead of dumping the raw (often tracking) src URL", () => {
  const html = "<img src=\"https://tracker.example.com/pixel.gif?very=long&tracking=id\" alt=\"Company logo\">";
  const markdown = htmlToMarkdown(html);
  assert.match(markdown, /\[image: Company logo\]/);
  assert.doesNotMatch(markdown, /tracker\.example\.com/);
});

test("htmlToMarkdown returns undefined for empty/missing input", () => {
  assert.equal(htmlToMarkdown(undefined), undefined);
  assert.equal(htmlToMarkdown(""), undefined);
});

test("createEmailId/parseEmailId round-trip, and the id stays human-readable (folder + uid visible)", () => {
  const id = createEmailId("INBOX", 42);
  assert.match(id, /^INBOX::42::[0-9a-f]{8}$/);
  assert.deepEqual(parseEmailId(id), { folder: "INBOX", uid: 42 });
});

test("createEmailId/parseEmailId round-trip a folder path containing special characters", () => {
  const id = createEmailId("Folders/MCP-Snoozed", 7);
  assert.deepEqual(parseEmailId(id), { folder: "Folders/MCP-Snoozed", uid: 7 });
});

test("parseEmailId rejects an id with a tampered checksum instead of silently resolving it", () => {
  const id = createEmailId("INBOX", 42);
  const tampered = id.slice(0, -1) + (id.endsWith("0") ? "1" : "0");
  assert.throws(() => parseEmailId(tampered), /Invalid emailId/);
});

test("parseEmailId still accepts the legacy pre-checksum format (folder::uid) for backward compatibility with persisted ids", () => {
  // drafts.json/snoozed.json/delivery-queue.json can hold ids written
  // before this format existed, resolved long after the writing process
  // exited — these must keep working, not just newly-created ids.
  assert.deepEqual(parseEmailId("INBOX::42"), { folder: "INBOX", uid: 42 });
  assert.deepEqual(parseEmailId("Folders%2FMCP-Snoozed::7"), { folder: "Folders/MCP-Snoozed", uid: 7 });
});

test("parseEmailId rejects garbage that isn't either the new or legacy shape", () => {
  assert.throws(() => parseEmailId("not-an-email-id"), /Invalid emailId/);
  assert.throws(() => parseEmailId("INBOX::not-a-number"), /Invalid emailId/);
  assert.throws(() => parseEmailId(""), /Invalid emailId/);
});

test("foldQuotedHistory collapses a trailing \"On ... wrote:\" quoted block into a marker", () => {
  const text = [
    "Sure, sounds good to me!",
    "",
    "On Mon, Sep 1, 2026 at 10:00 AM, Alice <alice@example.com> wrote:",
    "> Are we still on for the meeting tomorrow?",
    "> I also wanted to ask about the budget.",
  ].join("\n");
  const folded = foldQuotedHistory(text);
  assert.match(folded, /^Sure, sounds good to me!/);
  assert.match(folded, /\[\d+ lines? of quoted earlier message\(s\) folded\]/);
  assert.doesNotMatch(folded, /Are we still on/);
});

test("foldQuotedHistory collapses an Outlook-style \"-----Original Message-----\" banner and everything after it", () => {
  const text = ["My reply text.", "", "-----Original Message-----", "From: bob@example.com", "The original content."].join("\n");
  const folded = foldQuotedHistory(text);
  assert.match(folded, /^My reply text\./);
  assert.doesNotMatch(folded, /original content/);
});

test("foldQuotedHistory folds a long unmarked run of \">\" lines even with no boundary line", () => {
  const text = ["New content here.", "", "> line one", "> line two", "> line three", "> line four"].join("\n");
  const folded = foldQuotedHistory(text);
  assert.match(folded, /^New content here\./);
  assert.doesNotMatch(folded, /line one/);
});

test("foldQuotedHistory leaves a short inline quote (below the fold threshold) untouched", () => {
  const text = "Responding here.\n\n> just one quoted line\n\nMore text after.";
  assert.equal(foldQuotedHistory(text), text);
});

test("foldQuotedHistory leaves text with no quote boundary at all untouched", () => {
  const text = "Just a normal message with no quoting.";
  assert.equal(foldQuotedHistory(text), text);
});

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
