import test from "node:test";
import assert from "node:assert/strict";
import { simpleParser } from "mailparser";
import { SMTPService } from "../dist/services/smtp-service.js";
import { htmlToMarkdown, redactInlineData } from "../dist/utils/helpers.js";

const uri = `data:image/png;base64,${"iVBORw0KGgo".repeat(40)}`;
const html = `<p>Hi</p><img src="${uri}">`;

test("redactInlineData replaces bracketed and bare data: URIs", () => {
  assert.equal(redactInlineData(`Hi\n\n[${uri}]\n`), "Hi\n\n[image]\n");
  assert.ok(!redactInlineData(`see ${uri} end`).includes("base64"));
  assert.equal(redactInlineData("plain text"), "plain text");
});

// A password-reset / magic link can be 400+ characters; only data: URIs are redacted.
test("redactInlineData leaves long http(s) links alone", () => {
  const link = `[https://x.test/reset?token=${"a".repeat(400)}]`;
  assert.equal(redactInlineData(`Click here\n${link}`), `Click here\n${link}`);
});

// The first version of this scrubber was quadratic: a hostile inbound mail could freeze the
// server (a 240 KB body of "[data:" took ~20 s). It runs on every message read.
test("redactInlineData is linear on hostile input", () => {
  for (const chunk of ["[", "[data:", "(data:x", "data:", "[[[[a", `[${"a".repeat(299)}`]) {
    const input = chunk.repeat(Math.ceil(1_000_000 / chunk.length));
    const started = Date.now();
    redactInlineData(input);
    assert.ok(Date.now() - started < 1000, `1 MB of ${JSON.stringify(chunk)} took ${Date.now() - started} ms`);
  }
});

test("htmlToMarkdown never emits a data: URI, with or without alt", () => {
  for (const img of [`<img src="${uri}">`, `<img src="${uri}" alt="Logo">`, `<a href="${uri}">x</a>`]) {
    assert.ok(!htmlToMarkdown(`<p>a</p>${img}`).includes("data:image"), img);
  }
});

test("built message text/plain part has no data: URI; read-back of HTML-only mail is redacted", async () => {
  const smtp = new SMTPService({ smtp: { host: "127.0.0.1", port: 1, username: "a@example.test", password: "x" } });
  const raw = await smtp.buildRawMessage({ to: ["b@example.test"], subject: "s", body: html, isHtml: true });
  assert.match(raw.toString(), /text\/plain/);
  const built = await simpleParser(raw);
  assert.ok(!built.text.includes("data:"));

  // mailparser's own text for an HTML-only message (what Bridge returns for a
  // synced draft) leaks the URI; the read path must scrub it.
  const htmlOnly = await simpleParser(Buffer.from(`From: a@example.test\r\nSubject: s\r\nContent-Type: text/html\r\n\r\n${html}`));
  assert.ok(htmlOnly.text.includes("data:image"));
  assert.ok(!redactInlineData(htmlOnly.text).includes("data:"));
});
