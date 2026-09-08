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
      // Impersonate a dead PID on disk (A's own real token stays held only
      // in withFileLock's closure, untouched) so B's steal is triggered by
      // the liveness check — not by age alone, which a confirmed-alive PID
      // (this test process's own, always A's real encoded PID) can no
      // longer be stolen on, per the isStale() liveness-override fix.
      await writeFile(lockPath, "999999-impersonated-dead-holder");
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

test("a lock file whose encoded PID is confirmed dead is stolen immediately, without waiting out STALE_LOCK_MS", async () => {
  // Closes the found-live crash-loop gap: an ungraceful holder death leaves
  // a fresh (not yet age-stale) lock file behind. Every other process
  // sharing the store used to have to wait out the full 30s age threshold
  // before stealing it. With PID-liveness checked first, a lock file whose
  // encoded PID no longer exists is stealable immediately, regardless of age.
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-file-lock-dead-pid-test-"));
  const storePath = join(dataDir, "store.json");
  const lockPath = `${storePath}.lock`;
  try {
    // PID 999999 is exceedingly unlikely to be a live process; write the
    // lock with a *fresh* mtime so only the PID-liveness check (not age)
    // can explain a fast steal.
    await writeFile(lockPath, "999999-dead-holder-uuid");

    let ran = false;
    const start = Date.now();
    await withFileLock(storePath, async () => {
      ran = true;
    });
    assert.equal(ran, true);
    // Should steal near-immediately, not wait out STALE_LOCK_MS (30s).
    assert.ok(Date.now() - start < 2000, "expected the dead-PID lock to be stolen quickly");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a lock file whose encoded PID is confirmed alive is never stolen, even well past STALE_LOCK_MS", async () => {
  // Reproduces the found-live bug: isStale() checked liveness first, but on
  // alive===true it fell through to the plain age check anyway — so a
  // confirmed-alive holder still lost its lock after 30s of legitimately
  // slow I/O (a long critical section, or the process resuming from sleep),
  // silently reintroducing the exact lost-update race this lock exists to
  // prevent. This process's own PID is trivially "alive" from isProcessAlive's
  // perspective, so it doubles as the live holder here.
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-file-lock-alive-pid-test-"));
  const storePath = join(dataDir, "store.json");
  const lockPath = `${storePath}.lock`;
  try {
    await writeFile(lockPath, `${process.pid}-live-holder-uuid`);
    // Back-date well past STALE_LOCK_MS (30s) — age alone would call this
    // stealable; liveness must override that.
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    let acquired = false;
    const attempt = withFileLock(storePath, async () => {
      acquired = true;
    });
    // Swallow the eventual timeout/success so it doesn't become an unhandled
    // rejection once we release the lock below.
    attempt.catch(() => {});

    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(acquired, false, "a confirmed-alive holder's lock must not be stolen regardless of age");

    // Release it as the "holder" would, then confirm the waiting caller can
    // now proceed normally — this isn't a permanently wedged lock, just
    // correctly not stealable while the owner is alive.
    await rm(lockPath, { force: true });
    await attempt;
    assert.equal(acquired, true, "once released, the waiting caller should still be able to acquire it");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
