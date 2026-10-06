import test from "node:test";
import assert from "node:assert/strict";
import { SMTPService } from "../dist/services/smtp-service.js";

// Only absolute http, https and mailto links mean anything in a sent mail; a relative, fragment-only or
// protocol-relative href is dropped and the link text stays.

const service = new SMTPService({
  smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "o@example.com", password: "x" },
  imap: { host: "127.0.0.1", port: 1143, secure: false, username: "o@example.com", password: "x" },
  dataDir: "/tmp/sanitizer-links-test", debug: false, runtime: { allowSend: true, readOnly: false },
});
const render = (href) =>
  service.buildMailOptions({ to: ["a@example.com"], subject: "s", body: "b", htmlBody: `<a href="${href}">text</a>`, isHtml: true }).html ?? "";

for (const href of ["/x", "#top", "x.html", "//evil.example/x", " javascript:alert(1)", "java\nscript:alert(1)", "ftp://h/f"]) {
  test(`href ${JSON.stringify(href)} is dropped, the text stays`, () => {
    const html = render(href);
    assert.ok(!/href=/.test(html), html);
    assert.match(html, />text</);
  });
}
for (const href of ["https://ok.example/a", "http://ok.example/", "mailto:a@b.c", "  https://ok.example/pad"]) {
  test(`href ${JSON.stringify(href)} is kept`, () => assert.match(render(href), /href="(https?|mailto):/));
}
