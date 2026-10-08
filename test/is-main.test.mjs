import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { isMainModule } from "../dist/is-main.js";

// These assert POSIX file modes, symlinks or hardcoded "/" paths, which Windows does not have.
const WIN_SKIP = { skip: process.platform === "win32" ? "POSIX-only" : false };

// Run `fn` with process.argv[1] temporarily set to `entry`, then restore it.
function withEntry(entry, fn) {
  const original = process.argv[1];
  if (entry === undefined) {
    delete process.argv[1];
  } else {
    process.argv[1] = entry;
  }
  try {
    return fn();
  } finally {
    process.argv[1] = original;
  }
}

test("returns false when there is no entry point", () => {
  withEntry(undefined, () => {
    assert.equal(isMainModule("file:///anything.js"), false);
  });
});

test("matches the realpath-resolved entry (symlinked bin, default Node)", WIN_SKIP, async () => {
  const dir = await mkdtemp(join(tmpdir(), "protonmail-ismain-test-"));
  try {
    const real = join(dir, "real.js");
    const link = join(dir, "link.js");
    await writeFile(real, "");
    await symlink(real, link);
    // Launched via the symlink; default Node sets import.meta.url to the fully
    // realpath-resolved entry (the link and any symlinked parent dir).
    const resolvedUrl = pathToFileURL(await realpath(link)).href;
    withEntry(link, () => {
      assert.equal(isMainModule(resolvedUrl), true);
    });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("matches the raw entry (symlinked bin, --preserve-symlinks-main)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "protonmail-ismain-test-"));
  try {
    const real = join(dir, "real.js");
    const link = join(dir, "link.js");
    await writeFile(real, "");
    await symlink(real, link);
    // import.meta.url keeps the symlink path under --preserve-symlinks-main.
    withEntry(link, () => {
      assert.equal(isMainModule(pathToFileURL(link).href), true);
    });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("returns false for an unrelated module url", async () => {
  const dir = await mkdtemp(join(tmpdir(), "protonmail-ismain-test-"));
  try {
    const real = join(dir, "real.js");
    await writeFile(real, "");
    withEntry(real, () => {
      assert.equal(isMainModule(pathToFileURL(join(dir, "other.js")).href), false);
    });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("falls back to the raw entry when realpath cannot resolve it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "protonmail-ismain-test-"));
  try {
    const missing = join(dir, "does-not-exist.js");
    withEntry(missing, () => {
      assert.equal(isMainModule(pathToFileURL(missing).href), true);
    });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
