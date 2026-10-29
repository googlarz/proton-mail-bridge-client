import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { SimpleIMAPService } from "../dist/services/simple-imap-service.js";
import { writeAttachmentToDownloadDir } from "../dist/tools/drafts-support.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";

// PROTONMAIL_ALLOW_FILE_DOWNLOAD_DIR=$HOME contains the server's data directory, so "inside the download directory" is
// not enough: grants.json, the audit log, the event log and the rest of the server's state are never a place to save to
// (a saved attachment named grants.json would hand out grants). Both sides are compared by real path.

const STATE_FILES = ["grants.json", "audit.log", "events.jsonl", "rules.json", "autoresponder.json", "contacts.json"];
const attachment = { id: "a1", filename: "evil.json", content: Buffer.from('{"grants":"owned"}') };

function serviceConfig(dataDir, allowFileDownloadDir, extra = {}) {
  return {
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "o@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "o@example.com", password: "x" },
    dataDir, debug: false, runtime: { allowFileDownloadDir }, ...extra,
  };
}

// root is the download directory (like $HOME); the data directory is inside it.
async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "attachment-server-state-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  for (const name of STATE_FILES) await writeFile(join(dataDir, name), `state of ${name}`);
  try { await fn({ root, dataDir }); } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

const untouched = async (dataDir) => {
  for (const name of STATE_FILES) assert.equal(await readFile(join(dataDir, name), "utf8"), `state of ${name}`, `${name} is unchanged`);
};

test("outputPath onto a state file of the data directory is refused, though the download directory contains it", async () => {
  await withRoot(async ({ root, dataDir }) => {
    const service = new SimpleIMAPService(serviceConfig(dataDir, root));
    for (const name of STATE_FILES) {
      await assert.rejects(service.writeAttachmentToPath("INBOX::1::2", attachment, join(dataDir, name)), /data directory/, name);
      // Relative to the download directory, as an outputPath may be.
      await assert.rejects(service.writeAttachmentToPath("INBOX::1::2", attachment, join("data", name)), /data directory/, `relative ${name}`);
      await assert.rejects(service.writeAttachmentToPath("INBOX::1::2", attachment, join(root, "x", "..", "data", name)), /data directory/, `dotdot ${name}`);
    }
    await untouched(dataDir);
  });
});

test("a new file anywhere under the data directory is refused too, and nothing is created", async () => {
  await withRoot(async ({ root, dataDir }) => {
    const service = new SimpleIMAPService(serviceConfig(dataDir, root));
    await assert.rejects(service.writeAttachmentToPath("INBOX::1::2", attachment, join(dataDir, "new-state.json")), /data directory/);
    await assert.rejects(service.writeAttachmentToPath("INBOX::1::2", attachment, join(dataDir, "deep", "er", "x.json")), /data directory/);
    assert.equal(existsSync(join(dataDir, "new-state.json")), false);
    assert.equal(existsSync(join(dataDir, "deep")), false, "no directory is created under the data directory either");
  });
});

test("an outputPath that is the data directory, with an attachment named like a state file, is refused", async () => {
  await withRoot(async ({ root, dataDir }) => {
    const service = new SimpleIMAPService(serviceConfig(dataDir, root));
    await assert.rejects(service.writeAttachmentToPath("INBOX::1::2", { ...attachment, filename: "grants.json" }, dataDir), /data directory/);
    await assert.rejects(service.writeAttachmentToPath("INBOX::1::2", { ...attachment, filename: "grants.json" }, `${dataDir}/`), /data directory/);
    await untouched(dataDir);
  });
});

test("save_attachments: every attachment aimed at the data directory fails, and the call fails with it", async () => {
  await withRoot(async ({ root, dataDir }) => {
    const service = new SimpleIMAPService(serviceConfig(dataDir, root));
    service.getParsedMailDetail = async () => ({ parsed: {} });
    service.mapParsedAttachmentsWithContent = () => [{ ...attachment, filename: "grants.json" }, { ...attachment, id: "a2", filename: "audit.log" }];
    await assert.rejects(service.saveAttachments({ emailId: "INBOX::1::2", outputPath: dataDir }), /data directory/);
    await untouched(dataDir);
  });
});

test("symlinks: a link in the download directory to the data directory, and a data directory that is itself a link", async () => {
  await withRoot(async ({ root, dataDir }) => {
    await symlink(dataDir, join(root, "innocent"));
    const service = new SimpleIMAPService(serviceConfig(dataDir, root));
    await assert.rejects(service.writeAttachmentToPath("INBOX::1::2", attachment, join(root, "innocent", "grants.json")), /data directory/);
    await assert.rejects(service.writeAttachmentToPath("INBOX::1::2", attachment, join(root, "innocent", "fresh.json")), /data directory/);
    // The configured data directory is the link; the write names the real directory.
    const viaLink = new SimpleIMAPService(serviceConfig(join(root, "innocent"), root));
    await assert.rejects(viaLink.writeAttachmentToPath("INBOX::1::2", attachment, join(dataDir, "grants.json")), /data directory/);
    await untouched(dataDir);
  });
});

test("on a case-insensitive file system another spelling of the data directory is the same directory", async (t) => {
  await withRoot(async ({ root, dataDir }) => {
    if (!existsSync(join(root, "DATA"))) return t.skip("case-sensitive file system");
    const service = new SimpleIMAPService(serviceConfig(dataDir, root));
    await assert.rejects(service.writeAttachmentToPath("INBOX::1::2", attachment, join(root, "DATA", "GRANTS.JSON")), /data directory/);
    await assert.rejects(service.writeAttachmentToPath("INBOX::1::2", attachment, join(root, "Data", "new.json")), /data directory/);
    await untouched(dataDir);
  });
});

test("the data directory of every account is protected, wherever it is", async () => {
  await withRoot(async ({ root, dataDir }) => {
    const other = join(root, "elsewhere", "second-account");
    await mkdir(other, { recursive: true });
    await writeFile(join(other, "grants.json"), "second");
    const service = new SimpleIMAPService(serviceConfig(dataDir, root, { accounts: [{ dataDir }, { dataDir: other }] }));
    await assert.rejects(service.writeAttachmentToPath("INBOX::1::2", attachment, join(other, "grants.json")), /data directory/);
    assert.equal(await readFile(join(other, "grants.json"), "utf8"), "second");
  });
});

test("Bridge's certificate file, which the server trusts, is not a place to save to either", async () => {
  await withRoot(async ({ root, dataDir }) => {
    const pem = join(root, "bridge-cert.pem");
    await writeFile(pem, "pem");
    const service = new SimpleIMAPService({ ...serviceConfig(dataDir, root), runtime: { allowFileDownloadDir: root, tlsCaFile: pem } });
    await assert.rejects(service.writeAttachmentToPath("INBOX::1::2", attachment, pem), /data directory|server's own/);
    assert.equal(await readFile(pem, "utf8"), "pem");
  });
});

test("ordinary saves still work: beside the data directory, and in its attachments folder", async () => {
  await withRoot(async ({ root, dataDir }) => {
    const service = new SimpleIMAPService(serviceConfig(dataDir, root));
    const saved = await service.writeAttachmentToPath("INBOX::1::2", attachment, join(root, "invoices", "a.json"));
    assert.equal(await readFile(saved.outputPath, "utf8"), '{"grants":"owned"}');
    // No outputPath: the default folder under the download directory.
    const byDefault = await service.writeAttachmentToPath("INBOX::1::2", attachment);
    assert.ok(byDefault.outputPath.startsWith(root));
    // The folder the server itself saves into when no download directory is set.
    const attachmentsDir = join(dataDir, "attachments");
    const inFolder = await new SimpleIMAPService(serviceConfig(dataDir, attachmentsDir)).writeAttachmentToPath("INBOX::1::2", attachment, join(attachmentsDir, "kept.json"));
    assert.equal(await readFile(inFolder.outputPath, "utf8"), '{"grants":"owned"}');
    const noDownloadDir = await new SimpleIMAPService(serviceConfig(dataDir, undefined)).writeAttachmentToPath("INBOX::1::2", attachment);
    assert.ok(noDownloadDir.outputPath.startsWith(attachmentsDir));
    await untouched(dataDir);
  });
});

test("writeAttachmentToDownloadDir (saveTo) refuses the data directory with the same rules", async () => {
  await withRoot(async ({ root, dataDir }) => {
    const state = { dataDir, accounts: [{ dataDir }] };
    for (const name of STATE_FILES) {
      await assert.rejects(writeAttachmentToDownloadDir(root, join("data", name), Buffer.from("x"), state), /data directory/, name);
    }
    await assert.rejects(writeAttachmentToDownloadDir(root, "data/brand-new.json", Buffer.from("x"), state), /data directory/);
    assert.equal(existsSync(join(dataDir, "brand-new.json")), false);
    await symlink(dataDir, join(root, "innocent"));
    await assert.rejects(writeAttachmentToDownloadDir(root, "innocent/grants.json", Buffer.from("x"), state), /data directory/);
    await untouched(dataDir);
    const ok = await writeAttachmentToDownloadDir(root, "invoices/a.pdf", Buffer.from("fine"), state);
    assert.equal(await readFile(ok, "utf8"), "fine");
  });
});

// Through a whole server, for each tool that writes a saved attachment.
async function withServer(fn) {
  await withRoot(async ({ root, dataDir }) => {
    const conn = { host: "127.0.0.1", port: 9, secure: false, username: "owner@example.com", password: "x" };
    const config = {
      smtp: conn, imap: conn, dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
      accounts: [{ address: "owner@example.com", slug: "owner-example-com", imap: conn, smtp: conn, dataDir }],
      runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: false, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25,
        idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: true, allowEmptyFolder: true, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0, allowFileDownloadDir: root },
    };
    const { server, accountManager } = createServer(config, { startBackgroundSync: false });
    const bundle = accountManager.primary();
    bundle.imapService.getParsedAttachment = async () => ({ ...attachment, filename: "grants.json" });
    bundle.imapService.getParsedMailDetail = async () => ({ parsed: {} });
    bundle.imapService.mapParsedAttachmentsWithContent = () => [{ ...attachment, filename: "grants.json" }];
    bundle.imapService.getAttachmentContent = async () => ({ emailId: "INBOX::1::2", base64: attachment.content.toString("base64"), attachment: { filename: "grants.json" } });
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    try { await fn({ call: (name, args) => client.callTool({ name, arguments: args }), root, dataDir }); } finally {
      await client.close(); await server.close(); await closeTrackedIndexes();
    }
  });
}

test("through a server: save_attachment, save_attachments and get_attachment_content cannot reach grants.json", async () => {
  await withServer(async ({ call, dataDir }) => {
    const results = [
      await call("save_attachment", { emailId: "INBOX::1::2", attachmentId: "a1", saveTo: "data/grants.json" }),
      await call("save_attachment", { emailId: "INBOX::1::2", attachmentId: "a1", outputPath: join(dataDir, "grants.json") }),
      await call("save_attachments", { emailId: "INBOX::1::2", outputPath: dataDir }),
      await call("save_attachments", { emailId: "INBOX::1::2", outputPath: "data" }),
      await call("get_attachment_content", { emailId: "INBOX::1::2", attachmentId: "a1", saveTo: "data/grants.json" }),
      await call("get_attachment_content", { emailId: "INBOX::1::2", attachmentId: "a1", saveTo: "data/" }),
    ];
    results.forEach((result, index) => {
      assert.equal(result.isError, true, `call ${index}: ${result.content[0].text}`);
      assert.match(result.content[0].text, /data directory/, `call ${index}`);
    });
    await untouched(dataDir);
  });
});

test("through a server: a save into the download directory outside the data directory works", async () => {
  await withServer(async ({ call, root }) => {
    const result = await call("save_attachment", { emailId: "INBOX::1::2", attachmentId: "a1", saveTo: "saved/a.json" });
    assert.ok(!result.isError, result.content[0].text);
    assert.equal(await readFile(join(root, "saved", "a.json"), "utf8"), '{"grants":"owned"}');
  });
});
