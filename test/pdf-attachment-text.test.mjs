import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { extractPdfText, extractPdfTextDirect, looksLikePdf, PdfTextError } from "../dist/utils/pdf-text.js";
import { SimpleIMAPService } from "../dist/services/simple-imap-service.js";

// get_attachment_text refused every PDF, so a statement or an invoice sent as a PDF could not be
// read in a chat at all (#39). The fixtures are built here: a few lines of PDF syntax, no binary
// files in the repository.

function pdfString(text) {
  return `(${text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")})`;
}

// Each entry of `pages` is the text drawn on that page, or null for a page that only draws a line
// (no text layer, like a scan). `encrypt` adds a Standard security handler whose user password is
// not empty, so the document cannot be opened without it.
function buildPdf(pages, { encrypt = false } = {}) {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids = [];
  for (const text of pages) {
    const stream = text === null
      ? "0 0 m 200 200 l S"
      : text.split("\n").map((line, i) => `BT /F1 12 Tf 72 ${720 - i * 16} Td ${pdfString(line)} Tj ET`).join("\n");
    const content = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let encryptRef = "";
  let id = "";
  if (encrypt) {
    const hex = () => randomBytes(32).toString("hex");
    const enc = add(`<< /Filter /Standard /V 1 /R 2 /O <${hex()}> /U <${hex()}> /P -4 >>`);
    encryptRef = ` /Encrypt ${enc} 0 R`;
    const docId = randomBytes(16).toString("hex");
    id = ` /ID [<${docId}> <${docId}>]`;
  }
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${encryptRef}${id} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

test("text comes back page by page, each page with its marker", async () => {
  const pdf = buildPdf(["Fee schedule 2027", "Account fee: 4.90 EUR\nCard fee: 0.00 EUR", "Valid from 1 January"]);
  const result = await extractPdfText(pdf);
  assert.equal(result.totalPages, 3);
  assert.equal(result.extractedPages, 3);
  assert.equal(result.truncated, false);
  assert.equal(result.omittedPages, 0);
  assert.match(result.text, /^--- Page 1 of 3 ---\nFee schedule 2027/);
  assert.match(result.text, /--- Page 2 of 3 ---\nAccount fee: 4\.90 EUR/);
  assert.match(result.text, /Card fee: 0\.00 EUR/);
  assert.match(result.text, /--- Page 3 of 3 ---\nValid from 1 January$/);
});

test("a PDF longer than the page limit is cut off with a note saying how many pages are missing", async () => {
  const pdf = buildPdf(Array.from({ length: 7 }, (_, i) => `Page text ${i + 1}`));
  const result = await extractPdfText(pdf, { maxPages: 3 });
  assert.equal(result.totalPages, 7);
  assert.equal(result.extractedPages, 3);
  assert.equal(result.omittedPages, 4);
  assert.equal(result.truncated, true);
  assert.match(result.text, /Page text 3/);
  assert.doesNotMatch(result.text, /Page text 4/);
  assert.match(result.text, /--- Truncated: read 3 of 7 pages; 4 pages not included \(limit PROTONMAIL_PDF_MAX_PAGES=3\) ---$/);
});

test("a damaged file gives a plain message, not a pdf.js stack", async () => {
  const broken = Buffer.concat([Buffer.from("%PDF-1.4\n"), randomBytes(2000)]);
  await assert.rejects(extractPdfText(broken), (error) => {
    assert.ok(error instanceof PdfTextError);
    assert.equal(error.reason, "invalid");
    assert.match(error.message, /^The PDF could not be read; the file looks damaged/);
    return true;
  });
  const truncated = buildPdf(["Some text"]).subarray(0, 40);
  await assert.rejects(extractPdfText(truncated), (error) => error instanceof PdfTextError && error.reason === "invalid");
});

test("a PDF without a text layer (a scan) says so instead of returning empty text", async () => {
  await assert.rejects(extractPdfText(buildPdf([null, null])), (error) => {
    assert.ok(error instanceof PdfTextError);
    assert.equal(error.reason, "no-text-layer");
    assert.match(error.message, /no text layer/);
    return true;
  });
});

test("a password-protected PDF says so", async () => {
  await assert.rejects(extractPdfText(buildPdf(["Secret"], { encrypt: true })), (error) => {
    assert.ok(error instanceof PdfTextError);
    assert.equal(error.reason, "encrypted");
    assert.match(error.message, /password-protected/);
    return true;
  });
});

test("extraction makes no network request", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(String(args[0]));
    throw new Error("network is not allowed in this test");
  };
  try {
    // In-process on purpose: fetch is only intercepted in this thread, not in the worker.
    const result = await extractPdfTextDirect(buildPdf(["Offline only"]));
    assert.match(result.text, /Offline only/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(calls, []);
});

test("a PDF is recognised by its content type, or by its header when sent as octet-stream", () => {
  const pdf = buildPdf(["x"]);
  assert.equal(looksLikePdf(pdf, "application/pdf", "a.pdf"), true);
  assert.equal(looksLikePdf(pdf, "application/octet-stream", "statement.PDF"), true);
  assert.equal(looksLikePdf(pdf, undefined, "noname"), true);
  assert.equal(looksLikePdf(Buffer.from("plain text"), "application/octet-stream", "a.pdf"), false);
  assert.equal(looksLikePdf(pdf, "text/plain", "notes.txt"), false, "a declared text type is not second-guessed");
});

// ---- get_attachment_text through the service -------------------------------------------------------

function service(runtime = {}) {
  return new SimpleIMAPService({
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "o@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "o@example.com", password: "x" },
    dataDir: "/tmp/pdf-attachment-text-test", debug: false, runtime,
  });
}

function withAttachment(svc, content, extra = {}) {
  svc.getParsedAttachment = async () => ({
    id: "att-1", filename: "fees.pdf", contentType: "application/pdf", size: content.length, content, isInline: false, ...extra,
  });
}

test("getAttachmentText returns PDF text with page counts", async () => {
  const svc = service({ pdfMaxPages: 2 });
  withAttachment(svc, buildPdf(["One", "Two", "Three"]));
  const result = await svc.getAttachmentText("INBOX::1", "att-1");
  assert.equal(result.attachment.filename, "fees.pdf");
  assert.equal(result.attachment.content, undefined, "the raw bytes are not returned");
  assert.match(result.text, /--- Page 1 of 3 ---\nOne/);
  assert.deepEqual(result.pdf, { totalPages: 3, extractedPages: 2, omittedPages: 1, truncated: true });
});

test("getAttachmentText reads a PDF sent as application/octet-stream", async () => {
  const svc = service();
  withAttachment(svc, buildPdf(["Invoice 42"]), { contentType: "application/octet-stream", filename: "invoice.pdf" });
  const result = await svc.getAttachmentText("INBOX::1", "att-1");
  assert.match(result.text, /Invoice 42/);
});

test("getAttachmentText refuses a PDF above PROTONMAIL_PDF_MAX_MB before parsing it", async () => {
  const svc = service({ pdfMaxMb: 1 });
  withAttachment(svc, Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(1024 * 1024 + 1, 0x20)]));
  await assert.rejects(svc.getAttachmentText("INBOX::1", "att-1"), /above the 1 MB limit for PDF text extraction \(PROTONMAIL_PDF_MAX_MB\)/);
});

test("getAttachmentText turns an unreadable PDF into one clear error", async () => {
  const svc = service();
  withAttachment(svc, buildPdf(["x"], { encrypt: true }));
  await assert.rejects(svc.getAttachmentText("INBOX::1", "att-1"), (error) => {
    assert.match(error.message, /^Cannot extract text from attachment att-1: The PDF is password-protected/);
    assert.match(error.message, /Use get_attachment_content or save_attachment instead\.$/);
    return true;
  });
});

test("the parse runs off the main thread, so the event loop keeps ticking", async () => {
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 1);
  try {
    await extractPdfText(buildPdf(Array.from({ length: 40 }, (_, i) => `Page ${i} ${"lorem ipsum ".repeat(200)}`)));
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks > 0, "no timer fired while the PDF was being read");
});
