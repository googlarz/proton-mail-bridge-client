import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";

net.Socket.prototype.connect = () => { throw new Error("Network disabled in this test file"); };

// A reply to a message the user SENT must go to that message's original
// recipients, not back to the user.
const sent = {
  id: "Sent::1", folder: "Sent", uid: 1, subject: "Proposal",
  from: [{ address: "owner@example.com" }],
  to: [{ address: "alice@example.com" }], cc: [{ address: "bob@example.com" }], bcc: [], replyTo: [],
  date: "2026-09-19T10:00:00.000Z", messageId: "<sent@example.com>", references: [],
  body: "hi", text: "hi", attachments: [], isRead: true, isStarred: false, flags: [], labels: [],
};

test("create_reply_draft on an own sent message addresses the original recipients", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reply-own-"));
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
      maxInlineBytes: 40960, opDelayMs: 0, sendDelaySeconds: 0,
    },
    accounts: [account],
  };
  const { server, imapService } = createServer(config, { startBackgroundSync: false });
  imapService.getEmailById = async () => ({ ...sent });
  const client = new Client({ name: "test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const res = await client.callTool({ name: "create_reply_draft", arguments: { emailId: sent.id, body: "following up", replyAll: true, syncToRemote: false } });
    const draft = JSON.parse(res.content[0].text);
    assert.deepEqual(draft.to, ["alice@example.com"]);
    assert.deepEqual(draft.cc, ["bob@example.com"]);
  } finally {
    await client.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
