import test from "node:test";
import assert from "node:assert/strict";
import { SMTPService } from "../dist/services/smtp-service.js";

// Browsers ignore leading/trailing control characters and spaces in a URL, and tabs/newlines anywhere
// in it. The raster-only and size checks looked at the raw attribute, so " data:image/svg+xml,..." or
// a multi-megabyte image behind one leading space slipped past both.

const service = new SMTPService({
  smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "o@example.com", password: "x" },
  imap: { host: "127.0.0.1", port: 1143, secure: false, username: "o@example.com", password: "x" },
  dataDir: "/tmp/sanitizer-whitespace-test", debug: false, runtime: { allowSend: true, readOnly: false },
});

const render = (src) =>
  service.buildMailOptions({ to: ["a@example.com"], subject: "s", body: "b", htmlBody: `<p>hi</p><img src="${src}">`, isHtml: true }).html ?? "";

const TINY_PNG = "data:image/png;base64,iVBORw0KGgo=";

test("a small raster data: image is still kept", () => {
  assert.match(render(TINY_PNG), /src="data:image\/png;base64,iVBORw0KGgo="/);
});

test("an oversized data: image is dropped, with or without leading whitespace", () => {
  const big = `data:image/png;base64,${"A".repeat(3 * 1024 * 1024)}`;
  assert.equal(render(big).includes("AAAA"), false);
  for (const prefix of [" ", "\t", "\n", "\r\n ", "\u0001", "\u0000 "]) {
    assert.equal(render(prefix + big).includes("AAAA"), false, `prefix ${JSON.stringify(prefix)}`);
  }
});

test("a non-raster data: URI is dropped however it is padded or split", () => {
  const svg = "data:image/svg+xml;utf8,<svg onload=alert(1)>";
  for (const src of [svg, ` ${svg}`, `\t${svg}`, `\n${svg}`, `${svg} `, "da\tta:image/svg+xml;utf8,<svg>", "da\nta:text/html,<script>1</script>", " data:text/html,<p>x"]) {
    const html = render(src);
    assert.equal(/svg|text\/html|<script/i.test(html), false, `${JSON.stringify(src)} -> ${html}`);
  }
});

test("surrounding whitespace around a good image is trimmed, not kept", () => {
  assert.match(render(` ${TINY_PNG} `), /src="data:image\/png;base64,iVBORw0KGgo="/);
});

test("a cid: image and a plain relative-looking value behave as before", () => {
  assert.match(render("cid:logo"), /src="cid:logo"/);
  assert.equal(render("https://tracker.example/p.png").includes("tracker.example"), false);
});

test("a display name ending in a backslash cannot break out of the quoted From name", () => {
  for (const fromName of ["Bob\\", 'Bob\\" evil@x.com', 'Mallory" <evil@x.com>']) {
    const from = service.buildMailOptions({ to: ["a@example.com"], subject: "s", body: "b", fromName }).from;
    assert.match(from, /^"[^"\\]*" <o@example\.com>$/, `${JSON.stringify(fromName)} -> ${from}`);
  }
});
