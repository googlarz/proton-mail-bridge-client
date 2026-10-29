import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";
import { createMessage, makeCertificate, startFakeBridge } from "./helpers/fake-bridge.mjs";
import { INJECTION } from "./helpers/injection-samples.mjs";
import { buildDocx, buildXlsx, para, run } from "./helpers/office-fixtures.mjs";

// The whole route against a fake Bridge: a DOCX read with get_attachment_text goes through the mail firewall like a
// message body, and with PROTONMAIL_INDEX_ATTACHMENTS the text of Office attachments becomes searchable in the index.

const certificate = makeCertificate();
const needsOpenssl = certificate ? {} : { skip: "openssl is not available to make a test certificate" };

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function messageWithAttachment(uid, { subject, filename, contentType, content }) {
  const base = createMessage(uid, { subject });
  const boundary = `b${uid}`;
  const source = [
    "From: Alice <alice@example.com>",
    "To: owner@example.com",
    `Subject: ${subject}`,
    `Date: ${base.internalDate.toUTCString()}`,
    `Message-ID: ${base.messageId}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "See the attached file.",
    `--${boundary}`,
    `Content-Type: ${contentType}; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    content.toString("base64").replace(/.{76}/g, "$&\r\n"),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return { ...base, source: Buffer.from(source) };
}

async function session(runtimeExtra, fn) {
  const dir = await mkdtemp(join(tmpdir(), "attachment-routes-"));
  const bridge = await startFakeBridge({
    mode: "starttls", certificate,
    folders: { INBOX: { uidValidity: 1, messages: [
      messageWithAttachment(1, { subject: "Offer", filename: "offer.docx", contentType: DOCX_TYPE, content: buildDocx(para(run(`Terms of the offer. ${INJECTION}`))) }),
      messageWithAttachment(2, { subject: "Budget", filename: "budget.xlsx", contentType: XLSX_TYPE, content: buildXlsx([{ name: "Costs", rows: [[{ s: "Zebracornfield" }, { n: 42 }]] }]) }),
    ] } },
  });
  const conn = { imap: { host: "127.0.0.1", port: bridge.port, secure: false, username: "owner@example.com", password: "secret" }, smtp: { host: "127.0.0.1", port: 9, secure: false, username: "owner@example.com", password: "secret" } };
  const config = {
    ...conn, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: "owner@example.com", slug: "owner-example-com", ...conn, dataDir: dir }],
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: ["delete"], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 50, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0, ...runtimeExtra },
  };
  const { server } = createServer(config, { startBackgroundSync: false });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    return { result, text: result.content.find((c) => c.type === "text").text };
  };
  try {
    await fn(call);
  } finally {
    await client.close(); await server.close(); await closeTrackedIndexes(); await bridge.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("a DOCX that tries to steer an AI is flagged by the mail firewall and arms the confirmation gate", needsOpenssl, async () => {
  await session({}, async (call) => {
    await call("sync_emails", { folder: "INBOX" });
    const listed = JSON.parse((await call("search_indexed_emails", { query: "Offer" })).text);
    const offer = listed.emails.find((email) => email.subject === "Offer");
    assert.equal(offer.risk, undefined, "the listing itself does not carry the document text");
    const attachments = JSON.parse((await call("list_attachments", { emailId: offer.id })).text).attachments;
    const read = await call("get_attachment_text", { emailId: offer.id, attachmentId: attachments[0].id });
    assert.ok(!read.result.isError, read.text);
    const body = JSON.parse(read.text);
    assert.match(body.text, /^Terms of the offer\./);
    assert.equal(body.document.format, "docx");
    assert.equal(body.risk?.level, "high", "the extracted text was scanned");
    const send = await call("send_email", { to: "someone@example.com", subject: "x", body: "y" });
    assert.equal(send.result.isError, true);
    assert.match(send.text, /looks like an attempt to steer an AI/);
  });
});

test("with PROTONMAIL_INDEX_ATTACHMENTS the text inside an XLSX is found by search_indexed_emails", needsOpenssl, async () => {
  await session({ indexAttachments: true }, async (call) => {
    const synced = await call("sync_emails", { folder: "INBOX" });
    assert.ok(!synced.result.isError, synced.text);
    const found = JSON.parse((await call("search_indexed_emails", { query: "zebracornfield" })).text);
    assert.deepEqual(found.emails.map((email) => email.subject), ["Budget"]);
    assert.doesNotMatch(JSON.stringify(found), /Zebracornfield/, "the matched document text is not echoed in the result");
  });
});

test("without the setting the index keeps only what it indexed before", needsOpenssl, async () => {
  await session({}, async (call) => {
    await call("sync_emails", { folder: "INBOX" });
    assert.equal(JSON.parse((await call("search_indexed_emails", { query: "Budget" })).text).emails.length, 1, "the message itself is indexed");
    const found = JSON.parse((await call("search_indexed_emails", { query: "zebracornfield" })).text);
    assert.equal(found.emails.length, 0);
  });
});
