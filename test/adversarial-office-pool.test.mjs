import assert from "node:assert/strict";
import test from "node:test";
import { extractOfficeTextAsync } from "../dist/utils/office-text.js";
import { childCount } from "./helpers/child-processes.mjs";
import { buildDocx } from "./helpers/office-fixtures.mjs";

// Office text is read in child processes (not threads): the pool bound and the cleanup are counted on those.
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const big = () => buildDocx("<w:p><w:r><w:t>x</w:t></w:r></w:p>".repeat(900_000));
const small = () => buildDocx("<w:p><w:r><w:t>hello</w:t></w:r></w:p>");

test("40 parallel big docs: bounded, every call settles with ok/busy/timeout only", { skip: process.platform === "win32", timeout: 180000 }, async () => {
  const docx = big();
  const base = childCount();
  let peakT = 0;
  let peakRss = 0;
  const timer = setInterval(() => {
    peakT = Math.max(peakT, childCount());
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 25);
  const res = await Promise.allSettled(Array.from({ length: 40 }, () => extractOfficeTextAsync(docx, "docx")));
  clearInterval(timer);
  const tally = {};
  for (const r of res) {
    const k = r.status === "fulfilled" ? "ok" : (r.reason.reason ?? String(r.reason));
    tally[k] = (tally[k] ?? 0) + 1;
  }
  console.log("tally", JSON.stringify(tally), "extra child processes", peakT - base, "rss MB", Math.round(peakRss / 1048576));
  assert.ok(peakT - base <= 2, `peak extra child processes ${peakT - base}`);
  assert.ok(Object.keys(tally).every((k) => ["ok", "busy", "timeout"].includes(k)), JSON.stringify(tally));
  await settle(500);
  assert.equal(childCount() - base, 0, "child processes return to baseline");
});

test("timeout kills the child, pool is not wedged, next job is fine", { timeout: 60000 }, async () => {
  const docx = big();
  const base = childCount();
  const r = await Promise.allSettled([1, 2, 3, 4, 5, 6].map(() => extractOfficeTextAsync(docx, "docx", { timeoutMs: 20 })));
  assert.ok(r.every((x) => x.status === "rejected" && x.reason.reason === "timeout"), JSON.stringify(r.map((x) => x.reason?.reason)));
  await settle(300);
  assert.equal(childCount() - base, 0, `leaked child processes ${childCount() - base}`);
  const ok = await extractOfficeTextAsync(small(), "docx");
  assert.match(ok.text, /hello/);
});

test("failing jobs (garbage, wrong kind, truncated zip) do not poison the next", async () => {
  const garbage = Buffer.from("not a zip at all".repeat(100));
  const bad = await Promise.allSettled([
    extractOfficeTextAsync(garbage, "docx"),
    extractOfficeTextAsync(garbage, "xlsx"),
    extractOfficeTextAsync(small().subarray(0, 60), "docx"),
    extractOfficeTextAsync(small(), "xlsx"),
    extractOfficeTextAsync(Buffer.alloc(0), "docx"),
  ]);
  assert.ok(bad.every((x) => x.status === "rejected"), "all should fail");
  for (const x of bad) assert.ok(x.reason.reason, String(x.reason));
  for (let i = 0; i < 6; i++) assert.match((await extractOfficeTextAsync(small(), "docx")).text, /hello/);
});

test("queue cap: 2 running + 16 queued, rest busy immediately; slots recycled afterwards", { timeout: 120000 }, async () => {
  const docx = big();
  const t0 = Date.now();
  const calls = Array.from({ length: 25 }, () => extractOfficeTextAsync(docx, "docx", { timeoutMs: 60000 }).then(() => "ok", (e) => e.reason));
  const res = await Promise.all(calls);
  console.log("queue cap results", JSON.stringify(res.reduce((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {})), Date.now() - t0, "ms");
  assert.equal(res.filter((x) => x === "busy").length, 25 - 18);
  const again = await Promise.all([extractOfficeTextAsync(small(), "docx"), extractOfficeTextAsync(small(), "docx"), extractOfficeTextAsync(small(), "docx")]);
  assert.ok(again.every((r) => /hello/.test(r.text)));
});

test("timeout is counted from job start, not from queueing", { timeout: 120000 }, async () => {
  const docx = big();
  const hogs = [1, 2, 3, 4].map(() => extractOfficeTextAsync(docx, "docx"));
  const t0 = Date.now();
  const waiter = await extractOfficeTextAsync(small(), "docx", { timeoutMs: 1500 }).then(() => "ok", (e) => e.reason);
  console.log("waiter", waiter, Date.now() - t0, "ms");
  assert.equal(waiter, "ok");
  await Promise.allSettled(hogs);
});
