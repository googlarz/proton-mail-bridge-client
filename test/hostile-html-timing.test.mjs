import test from "node:test";
import assert from "node:assert/strict";
import { htmlToMarkdown, stripHtmlToText } from "../dist/utils/helpers.js";
import { stripUnshippableImages } from "../dist/index.js";

// Incoming HTML is untrusted. These patterns used to take seconds to minutes on 100 KB-1 MB (the work
// grew with the square of the input) and block the whole server while the message was read. The limits
// are generous on purpose: the point is "not quadratic", not a benchmark.
const LIMIT_MS = 1500;

function timed(fn) {
  const start = performance.now();
  const result = fn();
  return { ms: performance.now() - start, result };
}

test("stripHtmlToText stays fast on a megabyte of unclosed tags", () => {
  for (const hostile of ["<a ".repeat(350_000), "<style ".repeat(150_000), "<script>".repeat(130_000), "<".repeat(1_000_000)]) {
    const { ms } = timed(() => stripHtmlToText(hostile));
    assert.ok(ms < LIMIT_MS, `${hostile.slice(0, 12)}... took ${Math.round(ms)} ms`);
  }
});

test("stripHtmlToText still removes tags, style and script blocks and decodes entities", () => {
  assert.equal(stripHtmlToText("<p>Hello <b>big</b> world</p>"), "Hello big world");
  assert.equal(stripHtmlToText("a<style>p{color:red}</style>b<SCRIPT>alert(1)</SCRIPT>c"), "a b c");
  assert.equal(stripHtmlToText("Tom &amp; Jerry &lt;3 &gt; &nbsp;x"), "Tom & Jerry <3 > x");
  assert.equal(stripHtmlToText("a<style>never closed"), "a never closed");
});

test("htmlToMarkdown stays fast on deeply nested unclosed markup", () => {
  const { ms } = timed(() => htmlToMarkdown("<div>".repeat(200_000) + "x"));
  assert.ok(ms < LIMIT_MS, `took ${Math.round(ms)} ms`);
});

test("htmlToMarkdown still converts ordinary mail, including a table and a long document", () => {
  assert.equal(htmlToMarkdown("<h1>Title</h1><p>Hello <b>big</b> <a href=\"https://x.example\">link</a></p>"), "# Title\n\nHello **big** [link](https://x.example)");
  assert.match(htmlToMarkdown("<table><tr><td>one</td><td>two</td></tr></table>") ?? "", /one/);
  const long = "<p>Paragraph of ordinary text.</p>".repeat(30_000);
  const { ms, result } = timed(() => htmlToMarkdown(long));
  assert.ok(ms < LIMIT_MS, `took ${Math.round(ms)} ms`);
  assert.ok((result ?? "").startsWith("Paragraph of ordinary text."));
  assert.ok((result ?? "").length <= 10_003, "output stays capped");
});

test("stripUnshippableImages stays fast on a megabyte of unclosed img tags", () => {
  const { ms } = timed(() => stripUnshippableImages("<img ".repeat(200_000)));
  assert.ok(ms < LIMIT_MS, `took ${Math.round(ms)} ms`);
});

test("stripUnshippableImages drops data: and cid: images and keeps http ones, even with > inside an attribute", () => {
  assert.equal(stripUnshippableImages('<img src="data:image/png;base64,AAAA">'), "");
  assert.equal(stripUnshippableImages('<img src="cid:logo" alt="Logo">'), "[Logo]");
  assert.equal(stripUnshippableImages('<img src="https://x.example/a.png">'), '<img src="https://x.example/a.png">');
  assert.equal(stripUnshippableImages('<img alt="a>b" src="data:image/png;base64,AAAA">'), "[a>b]");
  assert.equal(stripUnshippableImages('<p>text</p><IMG SRC=\'data:image/gif;base64,R0lG\'>'), "<p>text</p>");
});
