import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runJob } from "../dist/utils/child-job.js";
import { extractOfficeTextAsync } from "../dist/utils/office-text.js";
import { childPids } from "./helpers/child-processes.mjs";
import { extractPdfText } from "../dist/utils/pdf-text.js";
import { buildDocx, buildImagePdf } from "./helpers/office-fixtures.mjs";

const run = promisify(execFile);
const script = fileURLToPath(new URL("./helpers/child-job-scripts.mjs", import.meta.url));
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const posix = { skip: process.platform === "win32" ? "needs pgrep" : false };

test("a timeout kills the child process, the parent survives and the next read works", { ...posix, timeout: 30000 }, async () => {
  const heavy = buildDocx("<w:r></w:r>".repeat(2_800_000)); // seconds of scanning, ends in "no text"
  const seen = new Set();
  const watcher = setInterval(() => { for (const pid of childPids()) seen.add(pid); }, 5);
  const results = await Promise.allSettled([1, 2, 3].map(() => extractOfficeTextAsync(heavy, "docx", { timeoutMs: 250 })));
  clearInterval(watcher);
  assert.ok(results.every((r) => r.status === "rejected" && r.reason.reason === "timeout"), JSON.stringify(results.map((r) => r.reason?.reason)));
  assert.ok(seen.size >= 1, "the jobs really ran in child processes");
  // The promise settles only once the child is gone: no waiting needed.
  assert.deepEqual(childPids(), []);
  assert.deepEqual([...seen].filter(alive), [], "every child that was started is dead");
  await settle(50);
  assert.match((await extractOfficeTextAsync(buildDocx("<w:p><w:r><w:t>still fine</w:t></w:r></w:p>"), "docx")).text, /still fine/);
  assert.deepEqual(childPids(), []);
});

test("killing the job at many random early moments never aborts the process that reads documents", { timeout: 60000 }, async () => {
  // The regression behind the move from worker_threads: terminate during zlib construction aborts the whole process
  // (SIGABRT). It runs in its own process, so an abort shows as a non-zero exit here and not as a dead test runner.
  // On the worker_threads code, 200 jobs killed at 1-60 ms aborted in about 16 of 20 runs.
  const { stdout } = await run(process.execPath, [script, "terminate-loop", "200", "60"], { timeout: 55000 });
  assert.match(stdout, /^LOOP-DONE 200$/m);
});

test("a read writes nothing to the parent's stdout", { timeout: 30000 }, async () => {
  const { stdout } = await run(process.execPath, [script, "stdout-marker"], { timeout: 25000 });
  assert.equal(stdout, "ONLY-THIS-LINE\n");
});

test("by default reads run in child processes; with PROTONMAIL_FORCE_WORKER_THREADS (the Electron path) they run in worker threads", { ...posix, timeout: 40000 }, async () => {
  const read = async (env) => JSON.parse((await run(process.execPath, [script, "read-both"], { timeout: 30000, env: { ...process.env, ...env } })).stdout);
  const forked = await read({ PROTONMAIL_FORCE_WORKER_THREADS: "" });
  assert.ok(forked.children >= 1, "default mode forks");
  assert.ok(forked.officeChars > 0 && forked.pdfHasText, JSON.stringify(forked));
  const threaded = await read({ PROTONMAIL_FORCE_WORKER_THREADS: "1" });
  assert.equal(threaded.children, 0, "worker mode starts no child process");
  assert.ok(threaded.officeChars > 0 && threaded.pdfHasText, JSON.stringify(threaded));
});

test("exit code 134 without a signal (a memory abort on Windows) is reported as SIGABRT", { timeout: 30000 }, async () => {
  const end = await runJob(new URL("./helpers/exit-134-job.mjs", import.meta.url), {}, { timeoutMs: 20000 });
  assert.equal(end.kind, "died");
  assert.equal(end.started, true);
  assert.equal(end.signal, "SIGABRT");
});

test("a child that runs out of memory is reported as started and killed by a signal, and the parent survives", { ...posix, timeout: 30000 }, async () => {
  const end = await runJob(new URL("./helpers/oom-job.mjs", import.meta.url), {}, { timeoutMs: 20000, execArgv: ["--max-old-space-size=32"] });
  assert.equal(end.kind, "died");
  assert.equal(end.started, true);
  assert.equal(end.crashed, true);
  assert.equal(end.signal, "SIGABRT");
  assert.deepEqual(childPids(), []);
});

test("PDFs are read in a bounded pool too: 2 at a time, 16 waiting, the rest answer busy", { ...posix, timeout: 60000 }, async () => {
  const pdf = buildImagePdf(1);
  let peak = 0;
  const watcher = setInterval(() => {
    peak = Math.max(peak, childPids().length);
  }, 5);
  const results = await Promise.all(Array.from({ length: 25 }, () => extractPdfText(pdf, { ocrPages: 1 }).then(() => "ok", (error) => error.reason)));
  clearInterval(watcher);
  assert.equal(results.filter((r) => r === "busy").length, 25 - 18);
  assert.equal(results.filter((r) => r === "ok").length, 18);
  assert.ok(peak >= 1 && peak <= 2, `peak child processes ${peak}`);
  assert.deepEqual(childPids(), []);
});
