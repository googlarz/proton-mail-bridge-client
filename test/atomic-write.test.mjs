import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../dist/utils/atomic-write.js";

// Writing a temp file and renaming it is atomic, but without flushing the data first the rename can reach
// the disk before the contents do: after a power loss the store is an empty file. writeFileAtomic flushes
// the file before the rename and the directory after it.

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "protonmail-atomic-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("writes the content, leaves no temp file behind and creates an owner-only file", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "store.json");
    await writeFileAtomic(path, '{"a":1}');
    assert.equal(await readFile(path, "utf8"), '{"a":1}');
    assert.deepEqual(await readdir(dir), ["store.json"]);
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
});

function busy(code = "EPERM") {
  return Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
}

test("retries a rename that fails with EPERM twice, then succeeds", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "store.json");
    await writeFile(path, "old");
    let calls = 0;
    const flaky = async (from, to) => {
      calls += 1;
      if (calls <= 2) throw busy();
      return rename(from, to);
    };
    await writeFileAtomic(path, "new", flaky);
    assert.equal(calls, 3);
    assert.equal(await readFile(path, "utf8"), "new");
    assert.deepEqual(await readdir(dir), ["store.json"]);
  });
});

test("gives up after the retry cap, rethrows the last error and removes the temp file", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "store.json");
    await writeFile(path, "old");
    let calls = 0;
    await assert.rejects(writeFileAtomic(path, "new", async () => { calls += 1; throw busy("EBUSY"); }), /EBUSY/);
    assert.equal(calls, 5);
    assert.equal(await readFile(path, "utf8"), "old");
    assert.deepEqual(await readdir(dir), ["store.json"]);
  });
});

test("does not retry an error that is not contention", async () => {
  await withDir(async (dir) => {
    let calls = 0;
    await assert.rejects(writeFileAtomic(join(dir, "store.json"), "x", async () => { calls += 1; throw busy("ENOENT"); }), /ENOENT/);
    assert.equal(calls, 1);
  });
});

test("replaces an existing file", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "store.json");
    await writeFile(path, "old");
    await writeFileAtomic(path, "new");
    assert.equal(await readFile(path, "utf8"), "new");
  });
});

test("flushes the file to disk before the rename", async () => {
  await withDir(async (dir) => {
    const probe = await open(join(dir, "probe"), "w");
    const proto = Object.getPrototypeOf(probe);
    await probe.close();
    const sync = mock.method(proto, "sync");
    try {
      await writeFileAtomic(join(dir, "store.json"), "x");
      assert.ok(sync.mock.callCount() >= 1, "the file handle must be synced");
    } finally {
      sync.mock.restore();
    }
  });
});

test("if flushing fails, the existing file is untouched and the error is raised", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "store.json");
    await writeFile(path, "original");
    const probe = await open(join(dir, "probe"), "w");
    const proto = Object.getPrototypeOf(probe);
    await probe.close();
    const sync = mock.method(proto, "sync", async () => { throw new Error("disk error"); });
    try {
      await assert.rejects(writeFileAtomic(path, "replacement"), /disk error/);
    } finally {
      sync.mock.restore();
    }
    assert.equal(await readFile(path, "utf8"), "original");
  });
});
