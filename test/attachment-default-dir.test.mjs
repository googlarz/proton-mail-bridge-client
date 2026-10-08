import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SimpleIMAPService } from "../dist/services/simple-imap-service.js";

// The rule is that attachments are only written into the configured download directory
// (PROTONMAIL_ALLOW_FILE_DOWNLOAD_DIR). With no output path given they went to the server's own data
// directory instead, whether or not that directory was configured.

function config(dataDir, allowFileDownloadDir) {
  return {
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "o@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "o@example.com", password: "x" },
    dataDir, debug: false,
    runtime: allowFileDownloadDir ? { allowFileDownloadDir } : {},
  };
}

const attachment = { id: "a1", filename: "report.pdf", content: Buffer.from("pdf-bytes") };

async function withDirs(fn) {
  const root = await mkdtemp(join(tmpdir(), "protonmail-attachment-default-"));
  try {
    await fn({ dataDir: join(root, "data"), downloads: join(root, "downloads") });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const filesUnder = async (dir) => (await readdir(dir, { recursive: true }).catch(() => [])).filter((name) => name.endsWith(".pdf"));

test("with a download directory configured, a save without a path goes there, not to the data directory", async () => {
  await withDirs(async ({ dataDir, downloads }) => {
    const service = new SimpleIMAPService(config(dataDir, downloads));
    await service.writeAttachmentToPath("INBOX::1::2", attachment);
    const inDownloads = await filesUnder(downloads);
    assert.equal(inDownloads.length, 1, "the file is under the download directory");
    assert.equal(await readFile(join(downloads, inDownloads[0]), "utf8"), "pdf-bytes");
    assert.deepEqual(await filesUnder(dataDir), [], "nothing is written under the data directory");
  });
});

test("the default path for an export also lands in the configured download directory", async () => {
  await withDirs(async ({ dataDir, downloads }) => {
    const service = new SimpleIMAPService(config(dataDir, downloads));
    const target = await service.resolveAttachmentOutputPath("INBOX::1::2", { filename: "m.eml" }, undefined);
    assert.ok(target.startsWith(downloads), target);
  });
});

test("without a download directory the private data directory is still the default", async () => {
  await withDirs(async ({ dataDir }) => {
    const service = new SimpleIMAPService(config(dataDir, undefined));
    await service.writeAttachmentToPath("INBOX::1::2", attachment);
    const inData = await filesUnder(join(dataDir, "attachments"));
    assert.equal(inData.length, 1);
  });
});
