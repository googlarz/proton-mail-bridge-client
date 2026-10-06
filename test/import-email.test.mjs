import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { SimpleIMAPService } from "../dist/services/simple-imap-service.js";
import { createServer } from "../dist/index.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";

net.Socket.prototype.connect = () => { throw new Error("Network disabled in this test file"); };

// import_email stamped every message with the time of the import, so mail from 2019 sorted as new; it swallowed a
// failure of its "already imported?" check and went on to import, so a retry could create a duplicate; and it
// accepted a message of any size.

function service({ searchResult = [], searchThrows } = {}) {
  const svc = new SimpleIMAPService({
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "o@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "o@example.com", password: "x" },
    dataDir: "/tmp/import-email-test", debug: false, runtime: {},
  });
  const appended = [];
  const client = {
    mailbox: { uidValidity: 100n },
    search: async () => { if (searchThrows) throw searchThrows; return searchResult; },
    append: async (folder, raw, flags, internalDate) => { appended.push({ folder, flags, internalDate }); return { uid: 7 }; },
  };
  svc.withMailbox = async (_folder, _ro, action) => action(client);
  svc.ensureConnected = async () => client;
  svc.getMailboxUidValidity = async () => "100";
  return { svc, appended };
}

const message = (headers) => Buffer.from(`${headers.join("\r\n")}\r\n\r\nBody\r\n`);

test("an imported message keeps the date of its Date header as its internal date", async () => {
  const { svc, appended } = service();
  await svc.importEmail({ raw: message(["Message-ID: <a@x.example>", "Date: Tue, 05 Feb 2019 10:30:00 +0000", "From: a@x.example", "Subject: old"]), targetFolder: "Archive" });
  assert.equal(appended.length, 1);
  assert.equal(appended[0].internalDate.toISOString(), "2019-02-05T10:30:00.000Z");
});

test("a message with no usable date, or one dated in the future, is stamped with the import time", async () => {
  for (const dateHeader of [null, "Date: not a date", "Date: Mon, 01 Jan 2093 00:00:00 +0000"]) {
    const { svc, appended } = service();
    const before = Date.now();
    await svc.importEmail({ raw: message(["Message-ID: <b@x.example>", ...(dateHeader ? [dateHeader] : []), "From: a@x.example", "Subject: s"]), targetFolder: "Archive" });
    const stamped = appended[0].internalDate.getTime();
    assert.ok(stamped >= before - 1000 && stamped <= Date.now() + 1000, `${dateHeader}: ${appended[0].internalDate.toISOString()}`);
  }
});

test("an explicit internalDate wins over the Date header", async () => {
  const { svc, appended } = service();
  await svc.importEmail({ raw: message(["Message-ID: <c@x.example>", "Date: Tue, 05 Feb 2019 10:30:00 +0000", "Subject: s"]), targetFolder: "Archive", internalDate: new Date("2020-01-01T00:00:00Z") });
  assert.equal(appended[0].internalDate.toISOString(), "2020-01-01T00:00:00.000Z");
});

test("if the 'already imported?' check fails, nothing is imported and the error is raised", async () => {
  const { svc, appended } = service({ searchThrows: new Error("search failed") });
  await assert.rejects(svc.importEmail({ raw: message(["Message-ID: <d@x.example>", "Subject: s"]), targetFolder: "Archive" }), /search failed/);
  assert.equal(appended.length, 0, "a retry must not be able to create a duplicate");
});

test("a message that is already there is not imported again", async () => {
  const { svc, appended } = service({ searchResult: [42] });
  const result = await svc.importEmail({ raw: message(["Message-ID: <e@x.example>", "Subject: s"]), targetFolder: "Archive" });
  assert.equal(result.alreadyExists, true);
  assert.equal(appended.length, 0);
});

test("import_email refuses a message larger than the limit", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "import-email-handler-"));
  const smtp = { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "x" };
  const imap = { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "x" };
  const { server, imapService } = createServer({
    smtp, imap, dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: "owner@example.com", slug: "owner-example-com", imap, smtp, dataDir }],
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false,
      autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false,
      maxInlineBytes: 40960, opDelayMs: 0, sendDelaySeconds: 0 },
  }, { startBackgroundSync: false });
  let called = 0;
  imapService.importEmail = async () => { called += 1; return { folder: "Archive" }; };
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    const tooBig = Buffer.alloc(51 * 1024 * 1024, 65).toString("base64");
    await assert.rejects(
      client.callTool({ name: "import_email", arguments: { rawBase64: tooBig, targetFolder: "Archive" } }),
      (error) => error instanceof McpError && error.code === -32602 && /larger than|too large|limit/i.test(error.message),
    );
    assert.equal(called, 0);
    await client.callTool({ name: "import_email", arguments: { rawBase64: Buffer.from("Subject: s\r\n\r\nx").toString("base64"), targetFolder: "Archive" } });
    assert.equal(called, 1, "a normal message still imports");
  } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
