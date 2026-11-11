// Entry points run as separate test processes by test/office-child-process.test.mjs, so that a crash of the process
// that reads documents shows up as a non-zero exit of that process instead of taking the test runner down.
import { extractOfficeTextAsync } from "../../dist/utils/office-text.js";
import { extractPdfText } from "../../dist/utils/pdf-text.js";
import { childPids } from "./child-processes.mjs";
import { buildDocx, buildImagePdf, buildPptx } from "./office-fixtures.mjs";

const docx = buildDocx("<w:p><w:r><w:t>hello</w:t></w:r></w:p>");

if (process.argv[2] === "terminate-loop") {
  // Kills the job at random early moments, from before the child has started to just after it began to parse. With
  // worker_threads, a terminate that lands while zlib is being constructed aborts the whole process.
  const rounds = Number(process.argv[3] ?? 200);
  const maxMs = Number(process.argv[4] ?? 60);
  // Every slide is a ZIP entry that gets its own inflate, so zlib is constructed again and again while the job runs.
  const deck = buildPptx(Array.from({ length: 2000 }, (_, i) => [`slide ${i}`]));
  let settled = 0;
  for (let i = 0; i < rounds; i += 2) {
    const jobs = [0, 1].map(() => extractOfficeTextAsync(deck, "pptx", { timeoutMs: 1 + Math.floor(Math.random() * maxMs) }));
    for (const result of await Promise.allSettled(jobs)) {
      if (result.status === "fulfilled" || ["timeout", "invalid"].includes(result.reason?.reason)) settled += 1;
    }
  }
  console.log(`LOOP-DONE ${settled}`);
} else if (process.argv[2] === "stdout-marker") {
  const office = await extractOfficeTextAsync(docx, "docx");
  const pdf = await extractPdfText(buildImagePdf(1), { ocrPages: 1 });
  if (!/hello/.test(office.text) || pdf.extractedPages !== 1) throw new Error("the reads did not give the expected result");
  console.log("ONLY-THIS-LINE");
} else if (process.argv[2] === "read-both") {
  // Reads one Office file and one text PDF while counting this process's child processes; the test sets or leaves
  // PROTONMAIL_FORCE_WORKER_THREADS to compare the two modes.
  const pdfText = "BT /F1 12 Tf 72 720 Td (Fee schedule 2027) Tj ET";
  const pdfBytes = Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n` +
      `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n` +
      `4 0 obj\n<< /Length ${pdfText.length} >>\nstream\n${pdfText}\nendstream\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n` +
      `trailer\n<< /Size 6 /Root 1 0 R >>\n%%EOF\n`,
    "latin1",
  );
  const seen = new Set();
  const watcher = setInterval(() => {
    for (const pid of childPids()) seen.add(pid);
  }, 5);
  const office = await extractOfficeTextAsync(buildDocx("<w:p><w:r><w:t>x</w:t></w:r></w:p>".repeat(300_000)), "docx");
  const pdf = await extractPdfText(pdfBytes);
  clearInterval(watcher);
  console.log(JSON.stringify({ children: seen.size, officeChars: office.text.length, pdfHasText: /Fee schedule 2027/.test(pdf.text) }));
}
