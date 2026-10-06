import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { SimpleIMAPService } from "../dist/services/simple-imap-service.js";
import { sanitizeFileName, isPathInside, createEmailId } from "../dist/utils/helpers.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";

net.Socket.prototype.connect = () => { throw new Error("Network disabled in this test file"); };

const POSIX = process.platform !== "win32";

// ---- sanitizeFileName ----------------------------------------------------------------------------------

test("sanitizeFileName makes any attachment name safe to write on every platform", () => {
  assert.equal(sanitizeFileName("report.pdf"), "report.pdf");
  assert.equal(sanitizeFileName("a/b\\c:d*e?f\"g<h>i|j.txt"), "a_b_c_d_e_f_g_h_i_j.txt");
  assert.match(sanitizeFileName("../../etc/passwd"), /^_+etc_passwd$/, "no dots or separators survive");
  assert.equal(sanitizeFileName(undefined, "fallback"), "fallback");
  assert.equal(sanitizeFileName("", "fallback"), "fallback");
  assert.equal(sanitizeFileName("   ", "fallback"), "fallback");
  for (const bad of [".", "..", "...", " . "]) assert.equal(sanitizeFileName(bad, "fallback"), "fallback", JSON.stringify(bad));
  assert.equal(sanitizeFileName("a\u0000b\u0007c.txt"), "abc.txt", "control characters are removed");
  assert.equal(sanitizeFileName("name. . "), "name", "Windows strips trailing dots and spaces, so the name must not rely on them");
});

test("sanitizeFileName avoids Windows reserved device names", () => {
  for (const reserved of ["CON", "con.txt", "PRN", "Aux.pdf", "NUL", "COM1", "lpt9.log"]) {
    const result = sanitizeFileName(reserved);
    assert.notEqual(result.split(".")[0].toUpperCase(), reserved.split(".")[0].toUpperCase(), reserved);
    assert.match(result, /^_/);
  }
  assert.equal(sanitizeFileName("console.txt"), "console.txt");
});

test("sanitizeFileName keeps a very long name within the 255-byte limit and keeps the extension", () => {
  const name = `${"é".repeat(300)}.pdf`;
  const result = sanitizeFileName(name);
  assert.ok(Buffer.byteLength(result) <= 200, `${Buffer.byteLength(result)} bytes`);
  assert.ok(result.endsWith(".pdf"));
  assert.ok(!result.includes("\uFFFD"), "a multi-byte character is not cut in half");
});

// ---- isPathInside --------------------------------------------------------------------------------------

test("isPathInside works for ordinary directories and for a filesystem root", () => {
  assert.equal(isPathInside("/a/b", "/a/b/c.txt", "/"), true);
  assert.equal(isPathInside("/a/b", "/a/b", "/"), true);
  assert.equal(isPathInside("/a/b", "/a/bc/c.txt", "/"), false);
  assert.equal(isPathInside("/a/b", "/a/c.txt", "/"), false);
  assert.equal(isPathInside("/", "/c.txt", "/"), true, "a download directory at the filesystem root");
  assert.equal(isPathInside("C:\\", "C:\\a.txt", "\\"), true);
  assert.equal(isPathInside("C:\\dl", "C:\\dl\\a.txt", "\\"), true);
  assert.equal(isPathInside("C:\\dl", "C:\\dlx\\a.txt", "\\"), false);
});

// ---- saveAttachments / output path guard ----------------------------------------------------------------

function service(downloads) {
  return new SimpleIMAPService({
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "o@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "o@example.com", password: "x" },
    dataDir: join(downloads, "..", "data"), debug: false,
    runtime: { allowFileDownloadDir: downloads, maxInlineBytes: 40 },
  });
}

const att = (filename, content = "x", extra = {}) => ({ id: filename, filename, contentType: "text/plain", size: content.length, content: Buffer.from(content), isInline: false, ...extra });

function withAttachments(svc, attachments) {
  svc.getParsedMailDetail = async () => ({ parsed: {}, detail: { id: "INBOX::1::x" } });
  svc.mapParsedAttachmentsWithContent = () => attachments;
}

async function withDirs(fn) {
  const root = await mkdtemp(join(tmpdir(), "protonmail-attachment-handling-"));
  const downloads = join(root, "downloads");
  await mkdir(downloads);
  try {
    await fn({ root, downloads });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("two attachments whose names differ only in case are both saved (case-insensitive filesystems)", async () => {
  await withDirs(async ({ downloads }) => {
    const svc = service(downloads);
    withAttachments(svc, [att("Invoice.pdf", "first"), att("invoice.pdf", "second")]);
    const result = await svc.saveAttachments({ emailId: "INBOX::1::x", outputPath: downloads });
    assert.equal(result.saved.length, 2);
    const files = (await readdir(downloads)).sort();
    assert.equal(files.length, 2, `both must exist on disk: ${files}`);
    const contents = (await Promise.all(files.map((f) => readFile(join(downloads, f), "utf8")))).sort();
    assert.deepEqual(contents, ["first", "second"]);
  });
});

test("one attachment that cannot be saved does not lose the others, and is reported", async () => {
  await withDirs(async ({ downloads }) => {
    const svc = service(downloads);
    const good = att("ok.txt", "fine");
    const bad = att("bad.txt", "boom");
    withAttachments(svc, [good, bad, att("also-ok.txt", "fine too")]);
    const original = svc.writeAttachmentToPath.bind(svc);
    svc.writeAttachmentToPath = async (emailId, attachment, target) => {
      if (attachment.filename === "bad.txt") throw new Error("disk full");
      return original(emailId, attachment, target);
    };
    const result = await svc.saveAttachments({ emailId: "INBOX::1::x", outputPath: downloads });
    assert.equal(result.saved.length, 2);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].filename, "bad.txt");
    assert.match(result.failed[0].error, /disk full/);
    assert.deepEqual((await readdir(downloads)).sort(), ["also-ok.txt", "ok.txt"]);
  });
});

test("when every attachment fails, saveAttachments fails instead of reporting an empty success", async () => {
  await withDirs(async ({ downloads }) => {
    const svc = service(downloads);
    withAttachments(svc, [att("a.txt"), att("b.txt")]);
    svc.writeAttachmentToPath = async () => { throw new Error("read-only file system"); };
    await assert.rejects(svc.saveAttachments({ emailId: "INBOX::1::x", outputPath: downloads }), /read-only file system/);
  });
});

test("an attachment named '.' or with a 300-character name is saved under a safe name", async () => {
  await withDirs(async ({ downloads }) => {
    const svc = service(downloads);
    withAttachments(svc, [att(".", "dot", { id: "att-dot" }), att(`${"x".repeat(300)}.txt`, "long"), att("ok.txt", "ok")]);
    const result = await svc.saveAttachments({ emailId: "INBOX::1::x", outputPath: downloads });
    assert.equal(result.saved.length, 3);
    assert.equal((await readdir(downloads)).length, 3);
  });
});

test("an output path in a new subdirectory of the download directory works", { skip: !POSIX && "POSIX paths" }, async () => {
  await withDirs(async ({ downloads }) => {
    const svc = service(downloads);
    withAttachments(svc, [att("a.txt", "in a new dir")]);
    await svc.saveAttachments({ emailId: "INBOX::1::x", outputPath: join(downloads, "new", "deeper") });
    assert.equal(await readFile(join(downloads, "new", "deeper", "a.txt"), "utf8"), "in a new dir");
  });
});

test("an output path with a trailing slash is a directory, not a file name", { skip: !POSIX && "POSIX paths" }, async () => {
  await withDirs(async ({ downloads }) => {
    const svc = service(downloads);
    withAttachments(svc, [att("a.txt", "x")]);
    await svc.saveAttachments({ emailId: "INBOX::1::x", outputPath: `${join(downloads, "folder")}/` });
    const info = await stat(join(downloads, "folder"));
    assert.ok(info.isDirectory());
    assert.equal(await readFile(join(downloads, "folder", "a.txt"), "utf8"), "x");
  });
});

test("an output path that escapes through a symlink is refused and creates nothing outside", { skip: !POSIX && "symlinks" }, async () => {
  await withDirs(async ({ root, downloads }) => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(downloads, "link"));
    const svc = service(downloads);
    withAttachments(svc, [att("a.txt")]);
    await assert.rejects(svc.saveAttachments({ emailId: "INBOX::1::x", outputPath: join(downloads, "link", "newdir") }));
    assert.deepEqual(await readdir(outside), []);
  });
});

// ---- lookup by filename ---------------------------------------------------------------------------------

test("looking an attachment up by a filename that two attachments share is an error listing their ids", async () => {
  await withDirs(async ({ downloads }) => {
    const svc = service(downloads);
    svc.getParsedMailDetail = async () => ({ parsed: {}, detail: { id: "INBOX::1::x" } });
    svc.mapParsedAttachmentsWithContent = () => [att("image.png", "FIRST", { id: "id-1" }), att("image.png", "SECOND", { id: "id-2" })];
    await assert.rejects(svc.getParsedAttachment("INBOX::1::x", "image.png"), /id-1.*id-2|id-2.*id-1/s);
    assert.equal((await svc.getParsedAttachment("INBOX::1::x", "id-2")).content.toString(), "SECOND", "an id is unambiguous");
  });
});

// ---- get_attachment_content with saveTo ----------------------------------------------------------------

async function withServer(downloads, fn) {
  const dataDir = join(downloads, "..", "server-data");
  await mkdir(dataDir, { recursive: true });
  const smtp = { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "x" };
  const imap = { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "x" };
  const config = {
    smtp, imap, dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: "owner@example.com", slug: "owner-example-com", imap, smtp, dataDir }],
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false,
      autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false,
      maxInlineBytes: 40960, opDelayMs: 0, sendDelaySeconds: 0, allowFileDownloadDir: downloads },
  };
  const { server, imapService } = createServer(config, { startBackgroundSync: false });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try { await fn(client, imapService); } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
  }
}

test("get_attachment_content with saveTo saves a large attachment instead of refusing it, without includeBase64", async () => {
  await withDirs(async ({ downloads }) => {
    await withServer(downloads, async (client, imapService) => {
      const big = Buffer.alloc(5 * 1024 * 1024, 7);
      const options = [];
      imapService.getAttachmentContent = async (emailId, attachmentId, opt) => {
        options.push(opt);
        return { emailId, attachment: { id: attachmentId, filename: "big.bin" }, base64: big.toString("base64") };
      };
      const emailId = createEmailId("INBOX", 5, "100");
      const result = await client.callTool({ name: "get_attachment_content", arguments: { emailId, attachmentId: "a1", saveTo: "big.bin" } });
      assert.ok(!result.isError, JSON.stringify(result.content));
      assert.equal(JSON.parse(result.content[0].text).saved, true);
      assert.equal((await stat(join(downloads, "big.bin"))).size, big.length);
      assert.equal(options[0]?.forSave, true, "the service must be told this is a save, so the inline-size limit does not apply");
    });
  });
});

test("get_attachment_content is no longer declared read-only, since saveTo writes a file", async () => {
  await withDirs(async ({ downloads }) => {
    await withServer(downloads, async (client) => {
      const tool = (await client.listTools()).tools.find((t) => t.name === "get_attachment_content");
      assert.notEqual(tool.annotations?.readOnlyHint, true);
    });
  });
});
