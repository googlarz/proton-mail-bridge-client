import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "../dist/utils/file-lock.js";

// A lock left behind by a process that died is stolen by the next waiter. Two waiters could both decide it was
// stale: the first removed it and took a new lock, the second then removed THAT lock and took its own, so both
// were inside the critical section at once and one update was lost.

function deadPid() {
  // A process that has already exited: its PID is no longer alive.
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(child.stdout);
}

test("with a lock left by a dead process, concurrent waiters still exclude each other", async () => {
  const dir = await mkdtemp(join(tmpdir(), "protonmail-lock-race-"));
  try {
    const store = join(dir, "store.json");
    const trials = 60;
    const callers = 4;
    for (let trial = 0; trial < trials; trial += 1) {
      await writeFile(store, "0");
      await writeFile(`${store}.lock`, `${deadPid()}-stale-${trial}`);
      await Promise.all(
        Array.from({ length: callers }, () =>
          withFileLock(store, async () => {
            const value = Number(await readFile(store, "utf8"));
            await new Promise((resolve) => setTimeout(resolve, 2)); // widen the window for a lost update
            await writeFile(store, String(value + 1));
          }),
        ),
      );
      assert.equal(Number(await readFile(store, "utf8")), callers, `trial ${trial}: an update was lost`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a live lock is never stolen, however many waiters there are", async () => {
  const dir = await mkdtemp(join(tmpdir(), "protonmail-lock-live-"));
  try {
    const store = join(dir, "store.json");
    await writeFile(store, "0");
    let inside = 0;
    let maxInside = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        withFileLock(store, async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inside -= 1;
        }),
      ),
    );
    assert.equal(maxInside, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an empty lock file left by a holder that died before writing its token is taken over after a moment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "protonmail-lock-empty-"));
  try {
    const store = join(dir, "store.json");
    await writeFile(`${store}.lock`, "");
    const old = new Date(Date.now() - 5_000);
    await utimes(`${store}.lock`, old, old);
    const started = Date.now();
    await withFileLock(store, async () => undefined);
    assert.ok(Date.now() - started < 3_000, "waited for the 30 s staleness limit instead of taking the empty lock over");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
