import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractOfficeText, officeKind, OfficeTextError } from "../dist/utils/office-text.js";
import { openZip, ZipError } from "../dist/utils/zip-reader.js";
import { runOcr, OcrError } from "../dist/utils/ocr.js";
import { extractPdfText } from "../dist/utils/pdf-text.js";
import { SimpleIMAPService } from "../dist/services/simple-imap-service.js";
import { buildDocx, buildImagePdf, buildPptx, buildXlsx, buildZip, para, run, tabRun } from "./helpers/office-fixtures.mjs";

// get_attachment_text read only text and PDFs; Word, Excel and PowerPoint files and scans could not be read in a chat.
// The documents are built in code (helpers/office-fixtures.mjs), including the hostile ones.

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

test("DOCX: paragraphs, tabs inside runs, tables and entities; paragraph tab stops are not text", () => {
  const docx = buildDocx(
    [
      para(run("Invoice 42 &lt;due&gt; &amp; payable"), tabRun, run("&#x141;&#243;d&#378;")),
      para(run("Second line")),
      "<w:tbl><w:tr><w:tc>",
      para(run("Cell A")),
      "</w:tc><w:tc>",
      para(run("Cell B")),
      "</w:tc></w:tr></w:tbl>",
      "<!-- a comment <w:t>hidden</w:t> -->",
      para(run("<![CDATA[x < y & z]]>")),
    ].join(""),
  );
  const result = extractOfficeText(docx, "docx");
  assert.equal(result.format, "docx");
  assert.equal(result.truncated, false);
  assert.match(result.text, /^Invoice 42 <due> & payable\tŁódź\nSecond line\n/);
  assert.match(result.text, /Cell A\n\tCell B/);
  assert.doesNotMatch(result.text, /hidden/);
  assert.match(result.text, /x < y & z$/);
});

test("XLSX: sheet names, then cells row by row: shared strings, numbers, booleans and inline strings", () => {
  const xlsx = buildXlsx([
    { name: "Costs &amp; fees", rows: [[{ s: "Item" }, { s: "Amount" }], [{ s: "Rent" }, { n: 1200.5 }], [{ inline: "Paid" }, { b: true }]] },
    { name: "Notes", rows: [[{ s: "Due 2027-01-31" }]] },
  ]);
  const result = extractOfficeText(xlsx, "xlsx");
  assert.equal(result.text, "--- Sheet: Costs & fees ---\nItem\tAmount\nRent\t1200.5\nPaid\tTRUE\n\n--- Sheet: Notes ---\nDue 2027-01-31");
  assert.doesNotMatch(result.text, /PHONETIC|SUM/, "phonetic runs and formulas are not cell text");
});

test("PPTX: slides in presentation order, each with its marker", () => {
  const pptx = buildPptx([["Second slide body"], ["Title slide", "Agenda"]], [1, 0]);
  const result = extractOfficeText(pptx, "pptx");
  assert.equal(result.text, "--- Slide 1 of 2 ---\nTitle slide\nAgenda\n\n--- Slide 2 of 2 ---\nSecond slide body");
});

test("the text is capped and says so", () => {
  const docx = buildDocx(Array.from({ length: 200 }, (_, i) => para(run(`Line ${i} ${"word ".repeat(20)}`))).join(""));
  const result = extractOfficeText(docx, "docx", { maxChars: 1000 });
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= 1000);
});

test("zip bomb: an entry that inflates past the cap is stopped, even when it lies about its size", () => {
  const zeros = Buffer.alloc(40 * 1024 * 1024);
  const bomb = buildZip([{ name: "word/document.xml", data: zeros, declaredSize: 100 }]);
  assert.ok(bomb.length < 100_000, "the fixture is small on disk");
  assert.throws(() => extractOfficeText(bomb, "docx"), (error) => {
    assert.ok(error instanceof OfficeTextError);
    assert.equal(error.reason, "too-large");
    assert.match(error.message, /zip bomb/);
    return true;
  });
  // The total across entries is capped too, not only each entry.
  const archive = openZip(buildZip([{ name: "a", data: Buffer.alloc(600) }, { name: "b", data: Buffer.alloc(600) }]), { maxEntries: 10, maxEntryBytes: 1000, maxTotalBytes: 1000 });
  assert.equal(archive.read("a").length, 600);
  assert.throws(() => archive.read("b"), (error) => error instanceof ZipError && error.reason === "too-large");
});

test("an archive with too many entries is refused before anything is inflated", () => {
  const entries = Array.from({ length: 5001 }, (_, i) => ({ name: `f${i}`, data: "x", store: true }));
  assert.throws(() => extractOfficeText(buildZip(entries), "docx"), (error) => error instanceof OfficeTextError && error.reason === "too-large");
});

test("path tricks: '..' entries and relationship targets that leave the archive are ignored", () => {
  // Only an entry named ../word/document.xml: it is not word/document.xml.
  assert.throws(() => extractOfficeText(buildDocx(para(run("x")), { documentName: "../word/document.xml" }), "docx"), /missing its word\/document\.xml/);
  const zip = openZip(buildZip([{ name: "/etc/passwd", data: "x" }, { name: "a\\b", data: "x" }, { name: "ok/file.xml", data: "x" }]), { maxEntries: 10, maxEntryBytes: 100, maxTotalBytes: 100 });
  assert.deepEqual(zip.names, ["ok/file.xml"]);
  // A sheet whose target climbs out of xl/ (or is external) is listed by name, with no cells read.
  const xlsx = buildXlsx([
    { name: "Escaping", rows: [], target: "../../../etc/passwd" },
    { name: "Real", rows: [[{ s: "kept" }]] },
  ]);
  assert.equal(extractOfficeText(xlsx, "xlsx").text, "--- Sheet: Escaping ---\n\n--- Sheet: Real ---\nkept");
});

test("entity expansion: a document with a DTD is refused, and unknown entities stay literal", () => {
  const laughs = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>';
  assert.throws(() => extractOfficeText(buildDocx(para(run("&lol2;")), { prolog: laughs }), "docx"), (error) => {
    assert.ok(error instanceof OfficeTextError);
    assert.equal(error.reason, "unsupported");
    assert.match(error.message, /DTD/);
    return true;
  });
  assert.equal(extractOfficeText(buildDocx(para(run("&lol2; &#0; &#xD800;"))), "docx").text, "&lol2; � �");
});

test("hostile XML stays linear: long whitespace runs, unclosed tags and quotes", () => {
  const started = Date.now();
  const spaces = " ".repeat(2_000_000);
  extractOfficeText(buildDocx(para(run(`a${spaces}b`)) + para(run(`c${spaces}`))), "docx", { maxChars: 10_000_000 });
  assert.throws(() => extractOfficeText(buildDocx(`<w:p ${'a="'.repeat(200_000)}`), "docx"), OfficeTextError);
  assert.throws(() => extractOfficeText(buildDocx("<".repeat(1_000_000)), "docx"), OfficeTextError);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});

test("damaged archives give a plain error", () => {
  assert.throws(() => extractOfficeText(Buffer.from("PK\x03\x04 not really a zip"), "docx"), (error) => error instanceof OfficeTextError && error.reason === "invalid");
  const docx = buildDocx(para(run("x")));
  assert.throws(() => extractOfficeText(docx.subarray(0, docx.length - 30), "docx"), OfficeTextError);
});

test("an Office file is recognised by its type, or by extension plus a ZIP header when sent as a generic type", () => {
  const docx = buildDocx(para(run("x")));
  assert.equal(officeKind(docx, DOCX_TYPE, "a"), "docx");
  assert.equal(officeKind(docx, "application/octet-stream", "Report.XLSX"), "xlsx");
  assert.equal(officeKind(docx, undefined, "deck.pptx"), "pptx");
  assert.equal(officeKind(Buffer.from("plain"), "application/octet-stream", "a.docx"), undefined, "not a ZIP");
  assert.equal(officeKind(docx, "text/plain", "a.docx"), undefined, "a declared text type is not second-guessed");
  assert.equal(officeKind(docx, "application/zip", "archive.zip"), undefined);
});

// ---- OCR ---------------------------------------------------------------------------------------------------

const posixOnly = process.platform === "win32" ? { skip: "the OCR stub is a shebang script" } : {};

async function ocrStub(body) {
  const dir = await mkdtemp(join(tmpdir(), "ocr-stub-"));
  const path = join(dir, "ocr-stub.cjs");
  await writeFile(path, `#!${process.execPath}\n${body}\n`);
  await chmod(path, 0o755);
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// Prints what it was given: the file's extension, the second argument, whether the file is a PNG, its size.
const ECHO_STUB = `const fs = require("node:fs"); const path = require("node:path");
const [file, out] = process.argv.slice(2);
const bytes = fs.readFileSync(file);
const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
process.stdout.write("OCR TEXT ext=" + path.extname(file) + " out=" + out + " png=" + png + " bytes=" + bytes.length + " args=" + process.argv.length + "\\n");`;

test("runOcr passes the image as a file argument, without a shell, and returns what the program prints", posixOnly, async () => {
  const stub = await ocrStub(ECHO_STUB);
  try {
    const result = await runOcr(stub.path, Buffer.from("fake-jpeg; rm -rf /"), ".jpg");
    assert.equal(result.truncated, false);
    assert.equal(result.text, "OCR TEXT ext=.jpg out=stdout png=false bytes=19 args=4");
  } finally {
    await stub.cleanup();
  }
});

test("runOcr stops a program that runs too long, caps its output, and explains a missing one", posixOnly, async () => {
  const slow = await ocrStub("setTimeout(() => {}, 60000);");
  const flood = await ocrStub('process.stdout.write("x".repeat(100000));');
  const failing = await ocrStub('process.stderr.write("Error: cannot read image\\n"); process.exit(1);');
  try {
    await assert.rejects(runOcr(slow.path, Buffer.from("x"), ".png", { timeoutMs: 300 }), (error) => error instanceof OcrError && /took longer than/.test(error.message));
    const capped = await runOcr(flood.path, Buffer.from("x"), ".png", { maxOutputBytes: 1000 });
    assert.equal(capped.truncated, true);
    assert.ok(capped.text.length <= 1000);
    await assert.rejects(runOcr(failing.path, Buffer.from("x"), ".png"), /The OCR command failed: Error: cannot read image/);
    await assert.rejects(runOcr(join(tmpdir(), "no-such-ocr-binary"), Buffer.from("x"), ".png"), /was not found/);
  } finally {
    await Promise.all([slow.cleanup(), flood.cleanup(), failing.cleanup()]);
  }
});

test("an image-only PDF hands back its page image as a PNG only when OCR asks for it", async () => {
  const pdf = buildImagePdf(2);
  await assert.rejects(extractPdfText(pdf), /no text layer/);
  const result = await extractPdfText(pdf, { ocrPages: 1 });
  assert.equal(result.pageImages.length, 1, "capped at ocrPages");
  assert.equal(result.pageImages[0].page, 1);
  assert.deepEqual([...result.pageImages[0].png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.deepEqual(result.pageTexts, ["", ""]);
});

// ---- get_attachment_text through the service ---------------------------------------------------------------

function service(runtime = {}) {
  return new SimpleIMAPService({
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "o@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "o@example.com", password: "x" },
    dataDir: "/tmp/office-attachment-text-test", debug: false, runtime,
  });
}

function withAttachment(svc, content, extra) {
  svc.getParsedAttachment = async () => ({ id: "att-1", size: content.length, content, isInline: false, ...extra });
}

test("getAttachmentText reads a DOCX, an XLSX sent as octet-stream, and a PPTX", async () => {
  const svc = service();
  withAttachment(svc, buildDocx(para(run("Contract terms"))), { filename: "contract.docx", contentType: DOCX_TYPE });
  const docx = await svc.getAttachmentText("INBOX::1", "att-1");
  assert.equal(docx.text, "Contract terms");
  assert.deepEqual(docx.document, { format: "docx", truncated: false });
  assert.equal(docx.attachment.content, undefined, "the raw bytes are not returned");

  withAttachment(svc, buildXlsx([{ name: "Q1", rows: [[{ s: "Total" }, { n: 99 }]] }]), { filename: "budget.xlsx", contentType: "application/octet-stream" });
  assert.equal((await svc.getAttachmentText("INBOX::1", "att-1")).text, "--- Sheet: Q1 ---\nTotal\t99");

  withAttachment(svc, buildPptx([["Roadmap"]]), { filename: "deck.pptx", contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
  assert.match((await svc.getAttachmentText("INBOX::1", "att-1")).text, /Roadmap/);
});

test("getAttachmentText turns a hostile document into one clear error", async () => {
  const svc = service();
  withAttachment(svc, buildZip([{ name: "word/document.xml", data: Buffer.alloc(40 * 1024 * 1024), declaredSize: 10 }]), { filename: "bomb.docx", contentType: DOCX_TYPE });
  await assert.rejects(svc.getAttachmentText("INBOX::1", "att-1"), /^Error: Cannot extract text from attachment att-1: .*zip bomb.*Use get_attachment_content or save_attachment instead\.$/);
});

test("without PROTONMAIL_OCR_COMMAND an image fails exactly as before", async () => {
  const svc = service();
  withAttachment(svc, Buffer.from("not really a png"), { filename: "scan.png", contentType: "image/png" });
  await assert.rejects(svc.getAttachmentText("INBOX::1", "att-1"), /its content type \(image\/png\) is not a supported text format/);
  withAttachment(svc, buildImagePdf(1), { filename: "scan.pdf", contentType: "application/pdf" });
  await assert.rejects(svc.getAttachmentText("INBOX::1", "att-1"), /no text layer/);
});

test("with PROTONMAIL_OCR_COMMAND an image and an image-only PDF are read by the OCR program", posixOnly, async () => {
  const stub = await ocrStub(ECHO_STUB);
  try {
    const svc = service({ ocrCommand: stub.path });
    withAttachment(svc, Buffer.from("jpeg bytes"), { filename: "photo.jpg", contentType: "image/jpeg" });
    const image = await svc.getAttachmentText("INBOX::1", "att-1");
    assert.match(image.text, /^OCR TEXT ext=\.jpg out=stdout png=false bytes=10/);
    assert.deepEqual(image.ocr, { truncated: false });

    withAttachment(svc, buildImagePdf(2), { filename: "scan.pdf", contentType: "application/pdf" });
    const pdf = await svc.getAttachmentText("INBOX::1", "att-1");
    assert.match(pdf.text, /^--- Page 1 of 2 ---\nOCR TEXT ext=\.png out=stdout png=true/);
    assert.match(pdf.text, /--- Page 2 of 2 ---\nOCR TEXT/);
    assert.equal(pdf.pdf.ocrPages, 2);
  } finally {
    await stub.cleanup();
  }
});

test("an OCR failure on a scan-only PDF is one clear error", posixOnly, async () => {
  const svc = service({ ocrCommand: join(tmpdir(), "no-such-ocr-binary") });
  withAttachment(svc, buildImagePdf(1), { filename: "scan.pdf", contentType: "application/pdf" });
  await assert.rejects(svc.getAttachmentText("INBOX::1", "att-1"), /the PDF has no text layer and OCR failed\. The OCR command .* was not found\./);
});
