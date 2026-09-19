import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAttachmentToDownloadDir } from "../dist/index.js";

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "attachment-dl-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

// A09 (audit 2.1.19): get_attachment_content(saveTo) wrote 0644 files in 0755 directories.
test("saved attachment is owner-only, and so are the directories created for it", async () => {
  await withDir(async (dir) => {
    const target = await writeAttachmentToDownloadDir(dir, "sub/dir/file.pdf", Buffer.from("secret"));
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "sub", "dir"))).mode & 0o777, 0o700);
  });
});

test("an existing file is tightened to 0600 when overwritten", async () => {
  await withDir(async (dir) => {
    const first = await writeAttachmentToDownloadDir(dir, "f.bin", Buffer.from("a"));
    const { chmod } = await import("node:fs/promises");
    await chmod(first, 0o644);
    await writeAttachmentToDownloadDir(dir, "f.bin", Buffer.from("b"));
    assert.equal((await stat(first)).mode & 0o777, 0o600);
  });
});

// A10: canonical target was compared with the non-canonical allowed dir.
test("a download dir that is itself a symlink is accepted", async () => {
  await withDir(async (dir) => {
    const real = join(dir, "real");
    await mkdir(real);
    const link = join(dir, "link");
    await symlink(real, link);
    const target = await writeAttachmentToDownloadDir(link, "ok.txt", Buffer.from("x"));
    assert.equal((await stat(join(real, "ok.txt"))).size, 1);
    assert.equal(target, join(link, "ok.txt"));
  });
});

test("traversal and a symlink pointing outside the download dir are still refused", async () => {
  await withDir(async (dir) => {
    const allowed = join(dir, "allowed");
    const outside = join(dir, "outside");
    await mkdir(allowed);
    await mkdir(outside);
    await symlink(outside, join(allowed, "escape"));
    await assert.rejects(writeAttachmentToDownloadDir(allowed, "../outside/x.txt", Buffer.from("x")), /escapes/);
    await assert.rejects(writeAttachmentToDownloadDir(allowed, "escape/x.txt", Buffer.from("x")), /escapes/);
  });
});
