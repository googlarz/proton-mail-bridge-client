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

test("redactInlineData replaces very long bracketed URLs", () => {
  assert.equal(redactInlineData(`[https://x.test/${"a".repeat(400)}]`), "[image]");
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
