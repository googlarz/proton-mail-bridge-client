import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withFileLock } from "../dist/utils/file-lock.js";

test("withFileLock serializes two concurrent callers instead of interleaving", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-file-lock-test-"));
  const storePath = join(dataDir, "store.json");
  try {
    const order = [];
    const record = (label, ms) => async () => {
      order.push(`${label}-start`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(`${label}-end`);
    };

    await Promise.all([
      withFileLock(storePath, record("a", 30)),
      withFileLock(storePath, record("b", 5)),
    ]);

    // Whichever ran first, its start/end must be adjacent — the other
    // caller's start can't land between them.
    const aStart = order.indexOf("a-start");
    const aEnd = order.indexOf("a-end");
    const bStart = order.indexOf("b-start");
    const bEnd = order.indexOf("b-end");
    const interleaved = (aStart < bStart && bStart < aEnd) || (bStart < aStart && aStart < bEnd);
    assert.equal(interleaved, false, `expected no interleaving, got: ${order.join(",")}`);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("withFileLock always releases the lock, even when fn throws", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-file-lock-throw-test-"));
  const storePath = join(dataDir, "store.json");
  try {
    await assert.rejects(
      () =>
        withFileLock(storePath, async () => {
          throw new Error("boom");
        }),
      /boom/,
    );

    // A second acquisition must succeed promptly — proves the lock file
    // from the failed call was released, not left behind.
    let ran = false;
    await withFileLock(storePath, async () => {
      ran = true;
    });
    assert.equal(ran, true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a slow holder whose lock was stolen as stale can't delete the new owner's active lock, letting a third caller double-acquire", async () => {
  // Found on review: the first version of file-lock.ts's release()
  // unlinked unconditionally, with no ownership check. If a slow holder's
  // (A's) lock got stolen as stale by another process (B), A finishing
  // later would delete B's now-active lock — letting a third caller (C)
  // acquire while B still believed it held exclusivity: two holders running
  // at once, the exact lost-update race this file exists to prevent.
  //
  // Timeline: A acquires and immediately back-dates its own lock file to
  // look abandoned (simulating a legitimately slow — not crashed — holder).
  // B starts shortly after, sees the lock as stale, steals it, and holds
  // it for a while. A finishes and releases *while B is still holding*.
  // C then races to acquire. With the bug, A's release deletes B's lock
  // and C acquires immediately, overlapping B. Fixed, A's release is a
  // no-op (token mismatch) and C has to wait for B to finish naturally.
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-file-lock-steal-test-"));
  const storePath = join(dataDir, "store.json");
  const lockPath = `${storePath}.lock`;
  const B_HOLD_MS = 200;
  const windows = {};

  try {
    const holderA = withFileLock(storePath, async () => {
      const old = new Date(Date.now() - 60_000);
      await utimes(lockPath, old, old).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    await new Promise((resolve) => setTimeout(resolve, 15));

    const holderB = withFileLock(storePath, async () => {
      windows.bStart = Date.now();
      await new Promise((resolve) => setTimeout(resolve, B_HOLD_MS));
      windows.bEnd = Date.now();
    });

    // A finishes (and releases) well before B does — this is the moment
    // the bug would have let A's release corrupt B's active lock.
    await holderA;

    const holderC = withFileLock(storePath, async () => {
      windows.cStart = Date.now();
    });

    await Promise.all([holderB, holderC]);

    assert.ok(windows.bStart !== undefined && windows.bEnd !== undefined && windows.cStart !== undefined);
    assert.ok(
      windows.cStart >= windows.bEnd,
      `C must not start until B finishes — B ran [${windows.bStart},${windows.bEnd}], C started at ${windows.cStart}`,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a lock file older than the stale threshold is stolen instead of blocking forever", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-file-lock-stale-test-"));
  const storePath = join(dataDir, "store.json");
  const lockPath = `${storePath}.lock`;
  try {
    await writeFile(lockPath, "pid-99999-abandoned");
    // Back-date it well past STALE_LOCK_MS (30s) so it reads as abandoned
    // rather than actually waiting out the real threshold in this test.
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    let ran = false;
    const start = Date.now();
    await withFileLock(storePath, async () => {
      ran = true;
    });
    assert.equal(ran, true);
    // Should steal near-immediately, not wait out LOCK_ACQUIRE_TIMEOUT_MS (10s).
    assert.ok(Date.now() - start < 2000, "expected the stale lock to be stolen quickly");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
