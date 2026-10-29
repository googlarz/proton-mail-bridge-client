import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAttachmentToDownloadDir } from "../dist/tools/drafts-support.js";
import { writeFileNoFollow } from "../dist/utils/safe-write.js";

async function withDirs(fn) {
  const root = await mkdtemp(join(tmpdir(), "attach-symlink-"));
  const downloads = join(root, "downloads");
  const outside = join(root, "outside");
  await mkdir(downloads);
  await mkdir(outside);
  try { await fn({ downloads, outside }); } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

test("a dangling symlink at the target is replaced, not written through", async () => {
  await withDirs(async ({ downloads, outside }) => {
    const planted = join(outside, "created-by-the-write");
    await symlink(planted, join(downloads, "offer.pdf"));
    await writeAttachmentToDownloadDir(downloads, "offer.pdf", Buffer.from("private"));
    assert.equal(existsSync(planted), false, "nothing was created outside the download directory");
    assert.equal(lstatSync(join(downloads, "offer.pdf")).isSymbolicLink(), false, "the link itself was replaced");
    assert.equal(await readFile(join(downloads, "offer.pdf"), "utf8"), "private");
  });
});

test("a symlink to an existing outside file is refused and the outside file is left alone", async () => {
  await withDirs(async ({ downloads, outside }) => {
    const victim = join(outside, "victim.txt");
    await writeFile(victim, "keep me");
    await symlink(victim, join(downloads, "a.txt"));
    await assert.rejects(writeAttachmentToDownloadDir(downloads, "a.txt", Buffer.from("new")), /escapes the allowed directory/);
    assert.equal(await readFile(victim, "utf8"), "keep me");
  });
});

test("an explicit destination is still replaced, owner-only, and no temp file is left behind", async () => {
  await withDirs(async ({ downloads }) => {
    await writeFile(join(downloads, "x.txt"), "old", { mode: 0o644 });
    await writeFileNoFollow(join(downloads, "x.txt"), Buffer.from("fresh"));
    assert.equal(await readFile(join(downloads, "x.txt"), "utf8"), "fresh");
    // Windows has no Unix permission bits to check.
    if (process.platform !== "win32") assert.equal(lstatSync(join(downloads, "x.txt")).mode & 0o777, 0o600);
    const { readdirSync } = await import("node:fs");
    assert.deepEqual(readdirSync(downloads), ["x.txt"]);
  });
});

// A rename that Windows refuses while another program holds the destination open: injected, so it runs everywhere.
const locked = (code) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

test("a destination that is locked for a moment is replaced once the rename succeeds on a later try", async () => {
  await withDirs(async ({ downloads }) => {
    const target = join(downloads, "existing.png");
    await writeFile(target, "old");
    const { rename } = await import("node:fs/promises");
    const delays = [];
    let calls = 0;
    await writeFileNoFollow(target, Buffer.from("fresh"), {
      retry: true,
      sleep: async (ms) => void delays.push(ms),
      rename: async (from, to) => {
        calls += 1;
        if (calls <= 3) throw locked(["EPERM", "EBUSY", "EACCES"][calls - 1]);
        await rename(from, to);
      },
    });
    assert.equal(calls, 4);
    assert.deepEqual(delays, [10, 20, 40], "the wait grows");
    assert.equal(await readFile(target, "utf8"), "fresh");
    const { readdirSync } = await import("node:fs");
    assert.deepEqual(readdirSync(downloads), ["existing.png"], "no temp file is left");
  });
});

test("a destination that stays locked gives a clear error naming it, keeps the old file and removes the temp file", async () => {
  await withDirs(async ({ downloads }) => {
    const target = join(downloads, "existing.png");
    await writeFile(target, "old");
    const delays = [];
    let calls = 0;
    const failure = await writeFileNoFollow(target, Buffer.from("fresh"), {
      retry: true,
      sleep: async (ms) => void delays.push(ms),
      rename: async () => {
        calls += 1;
        throw locked("EPERM");
      },
    }).then(() => undefined, (error) => error);
    assert.ok(failure, "the write fails");
    assert.match(failure.message, /existing\.png: the file is open in another program or locked/);
    assert.ok(!failure.message.includes(".tmp"), "the temp file is not named");
    assert.equal(failure.code, "EPERM");
    assert.equal(failure.cause.code, "EPERM");
    assert.ok(delays.length >= 5 && delays.reduce((a, b) => a + b, 0) <= 2000, "a bounded wait of about two seconds at most");
    assert.equal(calls, delays.length + 1);
    assert.equal(await readFile(target, "utf8"), "old");
    const { readdirSync } = await import("node:fs");
    assert.deepEqual(readdirSync(downloads), ["existing.png"], "the temp file is removed");
  });
});

test("without the retry (not Windows) a refused rename fails at once with the original error", async () => {
  await withDirs(async ({ downloads }) => {
    const target = join(downloads, "existing.png");
    await writeFile(target, "old");
    let calls = 0;
    const original = locked("EACCES");
    await assert.rejects(
      writeFileNoFollow(target, Buffer.from("fresh"), { retry: false, rename: async () => { calls += 1; throw original; } }),
      (error) => error === original,
    );
    assert.equal(calls, 1);
    assert.equal(await readFile(target, "utf8"), "old");
  });
});
