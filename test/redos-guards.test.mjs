import test from "node:test";
import assert from "node:assert/strict";
import { exceedsHtmlDepth, extractMessageIdList, htmlToMarkdown, summarizeCalendarText } from "../dist/utils/helpers.js";

// Three more ways a single received message could hold the single-threaded server for many seconds. Each input
// below took 7-18 s before the fix (the work grew with the square of the input); the limit leaves room for a loaded runner.
const LIMIT_MS = 5000;
const timed = (fn) => { const start = performance.now(); const result = fn(); return { ms: performance.now() - start, result }; };

test("a '<' followed by a long run of letters does not make HTML-to-Markdown quadratic", () => {
  const { ms } = timed(() => htmlToMarkdown("<" + "a".repeat(300_000)));
  assert.ok(ms < LIMIT_MS, `took ${Math.round(ms)} ms`);
});

test("a References header made of '<' without '>' does not make id extraction quadratic", () => {
  const { ms } = timed(() => extractMessageIdList("<a ".repeat(100_000)));
  assert.ok(ms < LIMIT_MS, `took ${Math.round(ms)} ms`);
});

test("a calendar with a very long run of unclosed components is summarised in linear time", () => {
  const { ms } = timed(() => summarizeCalendarText("BEGIN:A\n".repeat(50_000) + "X:y\n".repeat(50_000)));
  assert.ok(ms < LIMIT_MS, `took ${Math.round(ms)} ms`);
});

test("exceedsHtmlDepth counts open elements like before", () => {
  assert.equal(exceedsHtmlDepth("<div><div><div></div></div></div>", 2), true);
  assert.equal(exceedsHtmlDepth("<div><div><div></div></div></div>", 3), false);
  assert.equal(exceedsHtmlDepth("<div><br><img src=x><div/><p>", 2), false, "void and self-closing tags do not nest");
  assert.equal(exceedsHtmlDepth("<div><p>text</p></div><div></div>", 2), false, "closing tags lower the depth");
  assert.equal(exceedsHtmlDepth("<div <div <div><p><p><p>", 2), true, "a broken '<div ' is skipped, the tags after it still count");
  assert.equal(exceedsHtmlDepth("a < b > c <3 <- x", 0), false);
});

test("message ids are the bracketed tokens, and a '<' never ends up inside one", () => {
  assert.deepEqual(extractMessageIdList("<a@b.c> <d@e.f>"), ["<a@b.c>", "<d@e.f>"].map((id) => id.toLowerCase()));
  assert.deepEqual(extractMessageIdList("<broken <a@b.c>"), ["<a@b.c>"]);
  assert.deepEqual(extractMessageIdList(["<x@y>", "<z@y>"]), ["<x@y>", "<z@y>"]);
  assert.deepEqual(extractMessageIdList(undefined), []);
});

test("calendar summaries keep ignoring timezone and alarm properties", () => {
  const text = "BEGIN:VCALENDAR\nMETHOD:REQUEST\nBEGIN:VTIMEZONE\nDTSTART:19700329T020000\nEND:VTIMEZONE\nBEGIN:VEVENT\nSUMMARY:Review\nDTSTART:20260102T100000Z\nBEGIN:VALARM\nSUMMARY:alarm\nEND:VALARM\nEND:VEVENT\nEND:VCALENDAR\n";
  const summary = summarizeCalendarText(text);
  assert.match(summary, /Review/);
  assert.match(summary, /20260102T100000Z/);
  assert.ok(!/19700329|alarm/.test(summary), summary);
});

import { stripUnshippableImages } from "../dist/index.js";

test("removing unshippable images stays linear on unclosed tags and quotes", () => {
  for (const input of ["<img " + "a".repeat(300_000), "<img " + "\"".repeat(200_000), "<img \"".repeat(60_000), "<img '".repeat(60_000), "<img a=\"x".repeat(40_000)]) {
    const { ms } = timed(() => stripUnshippableImages(input));
    assert.ok(ms < LIMIT_MS, `took ${Math.round(ms)} ms`);
  }
});

import { buildInviteReply, parseInvite } from "../dist/utils/ical-reply.js";

test("reading an invitation stays linear on hostile calendar text", () => {
  const head = "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:u\r\nORGANIZER:mailto:a@b.c\r\n";
  const tail = "END:VEVENT\r\nEND:VCALENDAR\r\n";
  for (const text of [
    "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\n" + "BEGIN:X\r\n".repeat(100_000) + head.slice(head.indexOf("BEGIN:VEVENT")) + tail,
    head + "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:x@y.z\r\n".repeat(100_000) + tail,
    head + "SUMMARY:x\r\n" + " y\r\n".repeat(200_000) + tail,
    head + "ATTENDEE;CN=" + "\"".repeat(100_000) + ":mailto:x@y.z\r\n" + tail,
    head + "ATTENDEE" + ";a=b".repeat(100_000) + ":mailto:x@y.z\r\n" + tail,
  ]) {
    // Refusing an oversized or over-nested invitation is a bounded outcome too.
    const { ms } = timed(() => {
      try { return buildInviteReply(parseInvite(text), { attendeeAddress: "me@x.y", response: "accept" }); } catch (error) { if (error?.name !== "InviteError") throw error; return undefined; }
    });
    assert.ok(ms < LIMIT_MS, `took ${Math.round(ms)} ms`);
  }
});
