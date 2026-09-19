import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";

// Review of 2.1.20: PROTONMAIL_SEND_DELAY_SECONDS only covered send_email, so with a
// delay configured reply_to_email / reply_all_email / forward_email still sent at once.

const detail = {
  id: "INBOX::1::1::abc", folder: "INBOX", uid: 1, subject: "Hello",
  from: [{ name: "Ann", address: "ann@example.com" }],
  to: [{ name: "", address: "owner@example.com" }], cc: [], bcc: [], replyTo: [],
  date: "2026-09-19T10:00:00.000Z", messageId: "<orig@example.com>", references: [],
  body: "original text", text: "original text", attachments: [], isRead: true, isStarred: false, flags: [], labels: [],
};

async function withServer(sendDelaySeconds, fn) {
  const dir = await mkdtemp(join(tmpdir(), "undo-send-"));
  const account = {
    address: "owner@example.com", slug: "owner-example-com", dataDir: dir,
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "x" },
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "x" },
  };
  const config = {
    smtp: account.smtp, imap: account.imap, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true,
    autoSync: false, syncInterval: 5,
    runtime: {
      readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false,
      autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30,
      confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false, allowFileDownloadDir: undefined,
      maxInlineBytes: 40960, opDelayMs: 0, sendDelaySeconds,
    },
    accounts: [account],
  };
  const { server, imapService, smtpService, deliveryQueueService } = createServer(config, { startBackgroundSync: false });
  const sent = [];
  imapService.getEmailById = async () => ({ ...detail });
  imapService.sentCopyVerify = async () => ({ found: false });
  smtpService.sendEmail = async (payload) => { sent.push(payload); return { messageId: "<sent@example.com>", accepted: payload.to, rejected: [] }; };
  const client = new Client({ name: "test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    return { result, data: JSON.parse(result.content[0].text) };
  };
  try {
    await fn({ call, sent, deliveryQueueService });
  } finally {
    await client.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

for (const [tool, args] of [
  ["reply_to_email", { emailId: detail.id, body: "thanks" }],
  ["reply_all_email", { emailId: detail.id, body: "thanks" }],
  ["forward_email", { emailId: detail.id, to: "bob@example.com", body: "fyi" }],
]) {
  test(`${tool} queues instead of sending when a send delay is configured, and can be canceled`, async () => {
    await withServer(60, async ({ call, sent, deliveryQueueService }) => {
      const { data } = await call(tool, args);
      assert.equal(data.queued, true, JSON.stringify(data));
      assert.equal(sent.length, 0, "no SMTP call before the window elapses");
      const [record] = await deliveryQueueService.list();
      assert.equal(record.status, "pending");
      assert.equal(record.kind, "undo_send");
      if (tool !== "forward_email") assert.equal(record.payload.inReplyTo, "<orig@example.com>", "threading survives the queue");

      const { data: canceled } = await call("cancel_send", { id: data.id });
      assert.match(JSON.stringify(canceled), /cancel/i);
      assert.equal((await deliveryQueueService.list())[0].status, "canceled");
    });
  });

  test(`${tool} with undoWindowSeconds:0 sends immediately even when a delay is configured`, async () => {
    await withServer(60, async ({ call, sent }) => {
      await call(tool, { ...args, undoWindowSeconds: 0 });
      assert.equal(sent.length, 1);
    });
  });
}

test("with no delay configured, reply_to_email still sends immediately (unchanged default)", async () => {
  await withServer(0, async ({ call, sent }) => {
    await call("reply_to_email", { emailId: detail.id, body: "thanks" });
    assert.equal(sent.length, 1);
  });
});
