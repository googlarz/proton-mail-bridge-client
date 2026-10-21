import test from "node:test";
import assert from "node:assert/strict";
import { htmlToMarkdown, stripHtmlToText } from "../dist/utils/helpers.js";

// A styled bank or newsletter mail used to start with its whole stylesheet in the Markdown body (Turndown keeps the
// text of <style> and <script>), and the preview could carry fragments of HTML comments.

const STYLED = '<html><head><style>body{margin:0} .btn{color:#fff;background:#0666eb}</style></head>' +
  '<body><style>@media(max-width:600px){.col{width:100%!important}}</style>' +
  '<script>window.track("open")</script><p>Your international transfer fees are changing.</p></body></html>';

test("the Markdown body has no stylesheet or script text", () => {
  const markdown = htmlToMarkdown(STYLED);
  assert.equal(markdown.trim(), "Your international transfer fees are changing.");
  assert.doesNotMatch(markdown, /margin|@media|window\.track/);
});

test("headings, lists and links still convert", () => {
  const markdown = htmlToMarkdown("<style>x{}</style><h1>Title</h1><ul><li>one</li><li>two</li></ul><p><a href=\"https://example.com/a\">site</a></p>");
  assert.match(markdown, /^# Title/m);
  assert.match(markdown, /^[*-]\s+one/m);
  assert.match(markdown, /\[site\]\(https:\/\/example\.com\/a\)/);
});

test("the preview drops HTML comments, conditional ones and nested ones included", () => {
  assert.equal(stripHtmlToText("<!-- 96 <!-- Our international bank transfer fees are changing --><p>Hello</p>").trim(), "Hello");
  assert.equal(stripHtmlToText("<!--[if mso]><table><tr><td>Outlook only</td></tr></table><![endif]--><p>Hello</p>").trim(), "Hello");
  assert.equal(stripHtmlToText("<p>Hello</p><!-- never closed <p>hidden</p>").trim(), "Hello");
  assert.equal(stripHtmlToText("a<!---->b").replace(/\s+/g, ""), "ab");
});

test("many unclosed comment openers stay linear", () => {
  const hostile = "<!--".repeat(200_000) + "x";
  const start = performance.now();
  stripHtmlToText(hostile);
  htmlToMarkdown(hostile);
  assert.ok(performance.now() - start < 3000, `took ${Math.round(performance.now() - start)} ms`);
});

test("the plain-text preview decodes numeric and common named entities, once", () => {
  assert.equal(stripHtmlToText("<p>We&#39;ve made &quot;changes&quot; &#x2014; read &amp; reply</p>").trim(), "We've made \"changes\" — read & reply");
  assert.equal(stripHtmlToText("<p>&amp;lt;b&amp;gt;</p>").trim(), "&lt;b&gt;", "an escaped entity is decoded one level only");
  assert.equal(stripHtmlToText("<p>&notanentity; &#0; &#xD800;</p>").trim(), "&notanentity; &#0; &#xD800;");
});

import { shortenLongLinks } from "../dist/utils/helpers.js";

test("shortenLongLinks drops the tail of long tracking links but keeps the ones a reader may need", () => {
  const tracking = `https://click.example.com/f/a/${"x".repeat(200)}`;
  assert.equal(shortenLongLinks(`[facebook](${tracking})`), "[facebook](https://click.example.com/…)");
  assert.equal(shortenLongLinks("[short](https://example.com/a)"), "[short](https://example.com/a)", "short links stay");
  const unsubscribe = `https://click.example.com/unsubscribe/${"y".repeat(200)}`;
  assert.equal(shortenLongLinks(`[leave](${unsubscribe})`), `[leave](${unsubscribe})`, "an unsubscribe address stays");
  assert.equal(shortenLongLinks(`[Confirm your email](${tracking})`), `[Confirm your email](${tracking})`, "nor a confirm link, judged by its text");
  assert.equal(shortenLongLinks(`[x](${tracking} "title")`), "[x](https://click.example.com/…)");
  // How mailparser writes an HTML mail's links into its text, and a bare address in plain text.
  assert.equal(shortenLongLinks(`Read more [${tracking}] now`), "Read more [https://click.example.com/…] now");
  assert.equal(shortenLongLinks(`see ${tracking}\nnext`), "see https://click.example.com/…\nnext");
  assert.equal(shortenLongLinks(`leave [${unsubscribe}]`), `leave [${unsubscribe}]`);
});
