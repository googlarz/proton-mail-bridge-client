// Entry points run as separate test processes by test/office-child-process.test.mjs, so that a crash of the process
// that reads documents shows up as a non-zero exit of that process instead of taking the test runner down.
import { extractOfficeTextAsync } from "../../dist/utils/office-text.js";
import { extractPdfText } from "../../dist/utils/pdf-text.js";
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
}
