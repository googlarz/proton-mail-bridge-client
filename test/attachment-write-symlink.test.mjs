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
    assert.equal(lstatSync(join(downloads, "x.txt")).mode & 0o777, 0o600);
    const { readdirSync } = await import("node:fs");
    assert.deepEqual(readdirSync(downloads), ["x.txt"]);
  });
});
