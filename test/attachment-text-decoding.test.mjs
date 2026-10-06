import test from "node:test";
import assert from "node:assert/strict";
import { decodeAttachmentText } from "../dist/utils/helpers.js";
import { SimpleIMAPService } from "../dist/services/simple-imap-service.js";

// get_attachment_text decoded every text attachment as UTF-8: a windows-1250 CSV came back as "Polska;��d�",
// and 100 KB of binary data labelled text/plain came back as 100,000 replacement characters.

test("UTF-8 text is returned as it is, without a byte order mark", () => {
  assert.equal(decodeAttachmentText(Buffer.from("Łódź ß ü", "utf8")), "Łódź ß ü");
  assert.equal(decodeAttachmentText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello", "utf8")])), "hello");
});

test("a declared legacy charset is honoured (windows-1250, iso-8859-2, windows-1252, iso-8859-1)", () => {
  assert.equal(decodeAttachmentText(Buffer.from([0x50, 0x6f, 0x6c, 0x73, 0x6b, 0x61, 0x3b, 0xa3, 0xf3, 0x64, 0x9f]), "windows-1250"), "Polska;Łódź");
  assert.equal(decodeAttachmentText(Buffer.from([0xa3, 0xf3, 0x64, 0xbc]), "iso-8859-2"), "Łódź");
  assert.equal(decodeAttachmentText(Buffer.from([0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72]), "windows-1252"), "Müller");
  assert.equal(decodeAttachmentText(Buffer.from([0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72]), "ISO-8859-1"), "Müller");
});

test("UTF-16 with a byte order mark is decoded", () => {
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Łódź", "utf16le")]);
  assert.equal(decodeAttachmentText(le), "Łódź");
  const be = Buffer.from([0xfe, 0xff, 0x00, 0x41, 0x01, 0x41]);
  assert.equal(decodeAttachmentText(be), "AŁ");
});

test("an unknown charset label falls back to UTF-8 instead of failing", () => {
  assert.equal(decodeAttachmentText(Buffer.from("plain text", "utf8"), "x-no-such-charset"), "plain text");
});

test("binary data labelled as text is not returned as a wall of replacement characters", () => {
  const binary = Buffer.alloc(100_000);
  for (let i = 0; i < binary.length; i += 1) binary[i] = (i * 31 + 7) % 256;
  assert.equal(decodeAttachmentText(binary), undefined);
  assert.equal(decodeAttachmentText(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x41])), undefined, "a NUL byte means binary");
});

test("text with a few stray invalid bytes is still text", () => {
  const text = Buffer.concat([Buffer.from("A normal sentence of reasonable length. ".repeat(20), "utf8"), Buffer.from([0xff]), Buffer.from(" and more text.", "utf8")]);
  const decoded = decodeAttachmentText(text);
  assert.ok(decoded && decoded.startsWith("A normal sentence"));
});

test("the service uses the attachment's declared charset", () => {
  const svc = new SimpleIMAPService({
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "o@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "o@example.com", password: "x" },
    dataDir: "/tmp/attachment-text-test", debug: false, runtime: {},
  });
  const csv = { content: Buffer.from([0x50, 0x6f, 0x6c, 0x73, 0x6b, 0x61, 0x3b, 0xa3, 0xf3, 0x64, 0x9f]), contentType: "text/csv", charset: "windows-1250" };
  assert.equal(svc.extractAttachmentText(csv), "Polska;Łódź");
  assert.equal(svc.extractAttachmentText({ content: Buffer.alloc(5000, 0), contentType: "text/plain" }), undefined);
});
