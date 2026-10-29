import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { extractOfficeTextAsync } from "../dist/utils/office-text.js";
import { buildDocx } from "./helpers/office-fixtures.mjs";

const threads = () => {
  if (process.platform === "linux") return Number(/Threads:\s+(\d+)/.exec(readFileSync("/proc/self/status", "utf8"))?.[1]);
  return Number(execSync(`ps -M ${process.pid} | wc -l`).toString()) - 1;
};

test("many concurrent extractions keep threads and memory bounded and every call settles cleanly", { skip: process.platform === "win32" }, async () => {
  // About 90 KB compressed, tens of MB expanded: the worst case for a worker.
  const docx = buildDocx("<w:p><w:r><w:t>x</w:t></w:r></w:p>".repeat(900_000));
  const base = threads();
  let peakThreads = 0;
  let peakRss = 0;
  const timer = setInterval(() => {
    peakThreads = Math.max(peakThreads, threads());
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 20);
  const results = await Promise.allSettled(Array.from({ length: 40 }, () => extractOfficeTextAsync(docx, "docx")));
  clearInterval(timer);
  assert.ok(peakThreads - base <= 8, `peak extra threads ${peakThreads - base}`);
  assert.ok(peakRss < 1.5 * 1024 ** 3, `peak rss ${Math.round(peakRss / 1024 ** 2)} MB`);
  const done = results.filter((r) => r.status === "fulfilled").length;
  assert.ok(done >= 2, "some calls complete");
  for (const r of results) if (r.status === "rejected") assert.equal(r.reason.reason, "busy", String(r.reason));
});

test("a job that waits in the queue still completes within its own limit", async () => {
  const docx = buildDocx("<w:p><w:r><w:t>hi</w:t></w:r></w:p>");
  const slow = buildDocx("<w:p><w:r><w:t>x</w:t></w:r></w:p>".repeat(900_000));
  // Two slow jobs occupy the pool; the third waits behind them and must still get its whole own limit.
  const hogs = [extractOfficeTextAsync(slow, "docx"), extractOfficeTextAsync(slow, "docx")];
  const waited = extractOfficeTextAsync(docx, "docx", { timeoutMs: 5000 });
  const [, , result] = await Promise.allSettled([...hogs, waited]);
  assert.equal(result.status, "fulfilled");
  assert.match(result.value.text, /hi/);
});
