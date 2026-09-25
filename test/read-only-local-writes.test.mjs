import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../dist/index.js";

// Found live (read-only audit): create_draft/create_reply_draft/create_forward_draft/
// update_draft/delete_draft/create_template/delete_template all write local state
// (draftStore/templateService) without ever calling ensureMailboxWriteAllowed — they
// only gated the REMOTE sync/delete side. PROTONMAIL_READ_ONLY never actually stopped
// a local draft or template being created, edited, or deleted. cancel_send/clear_cache/
// clear_index had no policy gate at all. These drive the real MCP handlers end-to-end
// so the fix is proven to run in index.ts, not just added to the runtime-policy helper.
// imapService.getEmailById is stubbed so the draft-from-email tools don't need real
// IMAP — the point of these tests is the read-only gate, not mailbox I/O.

const detail = {
  id: "INBOX::1", folder: "INBOX", uid: 1, subject: "Hello",
  from: [{ name: "Ann", address: "ann@example.com" }],
  to: [{ name: "", address: "owner@example.com" }], cc: [], bcc: [], replyTo: [],
  date: "2026-09-19T10:00:00.000Z", messageId: "<orig@example.com>", references: [],
  body: "original text", text: "original text", attachments: [], isRead: true, isStarred: false, flags: [], labels: [],
};

async function withServer(readOnly, fn) {
  const dir = await mkdtemp(join(tmpdir(), "read-only-local-writes-"));
  const account = {
    address: "owner@example.com", slug: "owner-example-com", dataDir: dir,
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "x" },
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "x" },
  };
  const config = {
    smtp: account.smtp, imap: account.imap, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true,
    autoSync: false, syncInterval: 5,
    runtime: {
      readOnly, allowSend: true, allowRemoteDraftSync: true, allowedActions: ["mark_read", "delete"], startupSync: false,
      autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30,
      confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false, allowFileDownloadDir: undefined,
      maxInlineBytes: 40960, opDelayMs: 0, sendDelaySeconds: 0,
    },
    accounts: [account],
  };
  const { server, imapService } = createServer(config, { startBackgroundSync: false });
  imapService.getEmailById = async () => ({ ...detail });
  const client = new Client({ name: "test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = (name, args) => client.callTool({ name, arguments: args });
  try {
    await fn({ call });
  } finally {
    await client.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const readOnlyLocalWriteCases = [
  ["create_draft", { subject: "hi", body: "hi", syncToRemote: false }],
  ["create_reply_draft", { emailId: detail.id, body: "thanks", syncToRemote: false }],
  ["create_forward_draft", { emailId: detail.id, to: "bob@example.com", syncToRemote: false }],
  ["update_draft", { draftId: "does-not-exist", subject: "renamed" }],
  ["delete_draft", { draftId: "does-not-exist", confirmed: true }],
  ["create_template", { name: "t", subject: "s", body: "b" }],
  ["delete_template", { id: "does-not-exist", confirmed: true }],
];

const zeroGateCases = [
  ["cancel_send", { id: "does-not-exist" }],
  ["clear_cache", {}],
  ["clear_index", {}],
];

for (const [tool, args] of [...readOnlyLocalWriteCases, ...zeroGateCases]) {
  test(`${tool} rejects with a read-only error when PROTONMAIL_READ_ONLY is set`, async () => {
    await withServer(true, async ({ call }) => {
      await assert.rejects(
        call(tool, args),
        /read-only mode/i,
        `${tool} should have been blocked by the read-only gate`,
      );
    });
  });

  test(`${tool} passes the read-only gate when PROTONMAIL_READ_ONLY is not set`, async () => {
    await withServer(false, async ({ call }) => {
      try {
        await call(tool, args);
      } catch (error) {
        // Reaching past the gate is what's being proven — any failure here must
        // be for an unrelated reason (e.g. a missing/unknown id), never the
        // read-only policy check.
        assert.doesNotMatch(String(error?.message ?? error), /read-only mode/i);
      }
    });
  });
}
