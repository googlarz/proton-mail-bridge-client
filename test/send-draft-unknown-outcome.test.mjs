import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { sendOutcomeIsUnknown } from "../dist/services/smtp-service.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";

const failure = (message, extra = {}) => Object.assign(new Error(message), extra);

test("which send failures leave the outcome unknown", () => {
  assert.equal(sendOutcomeIsUnknown(failure("Connection closed unexpectedly", { code: "ECONNECTION", command: "DATA" })), true);
  assert.equal(sendOutcomeIsUnknown(failure("read ECONNRESET", { code: "ECONNRESET" })), true);
  assert.equal(sendOutcomeIsUnknown(failure("Timed out after 30000ms sending")), true);
  assert.equal(sendOutcomeIsUnknown(failure("Socket closed", { code: "ESOCKET" })), true);
  assert.equal(sendOutcomeIsUnknown(failure("550 No such user", { code: "EENVELOPE", responseCode: 550 })), false);
  assert.equal(sendOutcomeIsUnknown(failure("Invalid login", { code: "EAUTH" })), false);
  assert.equal(sendOutcomeIsUnknown(failure("Message rejected", { command: "DATA", responseCode: 554 })), false, "the server answered no");
  assert.equal(sendOutcomeIsUnknown(failure("SMTP send failed")), false);
  assert.equal(sendOutcomeIsUnknown("text"), false);
});

async function withServer(fn) {
  const dir = await mkdtemp(join(tmpdir(), "unknown-outcome-"));
  const conn = { host: "127.0.0.1", port: 9, secure: false, username: "owner@example.com", password: "x" };
  const config = {
    smtp: conn, imap: conn, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: "owner@example.com", slug: "owner-example-com", imap: conn, smtp: conn, dataDir: dir }],
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: false, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0, sendDelaySeconds: 0 },
  };
  const { server, accountManager } = createServer(config, { startBackgroundSync: false });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content.find((c) => c.type === "text").text;
    return result.isError ? { error: text } : JSON.parse(text);
  };
  try { await fn({ call, smtp: accountManager.primary().smtpService }); } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const newDraft = async (call) => (await call("create_draft", { to: "pat@client.example", subject: "Offer", body: "Hello", syncToRemote: false })).draftId ?? (await call("list_drafts", {})).drafts[0].id;

test("send_draft: a definite rejection makes the draft sendable again, a dropped connection after the data does not", async () => {
  await withServer(async ({ call, smtp }) => {
    const rejected = await newDraft(call);
    smtp.sendEmail = async () => { throw failure("550 mailbox unavailable", { code: "EENVELOPE", responseCode: 550 }); };
    assert.match((await call("send_draft", { draftId: rejected, confirmed: true })).error, /550/);
    let sends = 0;
    smtp.sendEmail = async () => { sends += 1; return { messageId: "<x@x>", accepted: ["pat@client.example"], rejected: [], response: "250" }; };
    assert.ok(!(await call("send_draft", { draftId: rejected, confirmed: true })).error, "a rejected draft can be sent again");
    assert.equal(sends, 1);

    const unsure = await newDraft(call);
    smtp.sendEmail = async () => { sends += 1; throw failure("Connection closed unexpectedly", { code: "ECONNECTION", command: "DATA" }); };
    const first = await call("send_draft", { draftId: unsure, confirmed: true });
    assert.match(first.error, /Check the Sent folder before sending again/);
    const before = sends;
    const second = await call("send_draft", { draftId: unsure, confirmed: true });
    assert.ok(second.error, "the draft is locked: a retry is refused");
    assert.equal(sends, before, "nothing was handed to SMTP the second time");
  });
});
