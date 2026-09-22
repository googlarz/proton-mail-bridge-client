import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../dist/index.js";

// A test that reaches past the policy check would otherwise hang trying to
// really connect to 127.0.0.1:1143/1025 — fail fast instead.
net.Socket.prototype.connect = () => { throw new Error("Network disabled in this test file"); };

// Found live: update_message_flags/bulk_update_flags/flag_thread set the same
// \Seen/\Flagged/\Deleted state as mark_email_read/star_email/delete_email but
// only called ensureMailboxWriteAllowed, never ensureEmailActionAllowed or
// ensureDestructiveConfirmed — so a policy restricting PROTONMAIL_ALLOWED_ACTIONS
// (e.g. excluding "delete") or requiring PROTONMAIL_CONFIRM_DESTRUCTIVE could be
// bypassed simply by setting the equivalent IMAP flag instead of calling the
// named tool. These drive the real MCP handlers end-to-end so the check is
// proven to run in index.ts, not just in the runtime-policy helper itself.
// The policy check must throw before any mailbox I/O is attempted, so no real
// IMAP/SMTP server is needed here.

async function withServer(overrides, fn) {
  const dataDir = await mkdtemp(join(tmpdir(), "flag-policy-"));
  const smtp = { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "secret" };
  const imap = { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "secret" };
  const config = {
    smtp,
    imap,
    dataDir,
    accounts: [{ address: "owner@example.com", slug: "owner-example-com", imap, smtp, dataDir }],
    debug: false,
    cacheEnabled: true,
    analyticsEnabled: true,
    autoSync: false,
    syncInterval: 5,
    runtime: {
      readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: ["mark_read"],
      startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25,
      idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: true, allowEmptyFolder: false,
      restrictOutboundToSelf: false, allowFileDownloadDir: undefined, maxInlineBytes: 40960, opDelayMs: 0,
      ...overrides,
    },
  };
  const { server } = createServer(config, { startBackgroundSync: false });
  const client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await fn(client);
  } finally {
    await client.close();
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("update_message_flags rejects setting \\Deleted when 'delete' is not in PROTONMAIL_ALLOWED_ACTIONS", async () => {
  await withServer({}, async (client) => {
    await assert.rejects(
      client.callTool({ name: "update_message_flags", arguments: { emailId: "INBOX::1", flagsToAdd: ["\\Deleted"], confirmed: true } }),
      /disabled by the current runtime policy/i,
    );
  });
});

test("update_message_flags rejects setting \\Deleted without confirmed:true when PROTONMAIL_CONFIRM_DESTRUCTIVE is on", async () => {
  await withServer({ allowedActions: ["delete"] }, async (client) => {
    await assert.rejects(
      client.callTool({ name: "update_message_flags", arguments: { emailId: "INBOX::1", flagsToAdd: ["\\Deleted"] } }),
      /Confirmation required/i,
    );
  });
});

test("bulk_update_flags rejects setting \\Flagged when 'star' is not in PROTONMAIL_ALLOWED_ACTIONS", async () => {
  await withServer({}, async (client) => {
    await assert.rejects(
      client.callTool({ name: "bulk_update_flags", arguments: { emailIds: ["INBOX::1"], flagsToAdd: ["\\Flagged"] } }),
      /disabled by the current runtime policy/i,
    );
  });
});

test("flag_thread rejects setting \\Deleted when 'delete' is not in PROTONMAIL_ALLOWED_ACTIONS", async () => {
  await withServer({}, async (client) => {
    await assert.rejects(
      client.callTool({ name: "flag_thread", arguments: { messageId: "<a@b>", flagsToAdd: ["\\Deleted"], confirmed: true } }),
      /disabled by the current runtime policy/i,
    );
  });
});

test("update_message_flags with only allowed, non-mapped flags reaches past the policy check", async () => {
  // \Answered has no named-action equivalent, and mark_read IS allowed — this
  // must fail on the (mocked-away) IMAP call, not on the policy check, proving
  // the gate isn't over-blocking flags it has no opinion about.
  await withServer({ allowedActions: ["mark_read"] }, async (client) => {
    await assert.rejects(
      client.callTool({ name: "update_message_flags", arguments: { emailId: "INBOX::1", flagsToAdd: ["\\Seen", "\\Answered"] } }),
      (error) => !/disabled by the current runtime policy/i.test(String(error?.message ?? error)),
    );
  });
});

// Found live: delete_folder and delete_label already required confirmed:true
// but, like the destructive tools above, only checked ensureMailboxWriteAllowed
// — never ensureEmailActionAllowed — so PROTONMAIL_ALLOWED_ACTIONS excluding
// "delete" had no effect on either, even though delete_folder/delete_label
// permanently delete a folder and every message in it.
test("delete_folder rejects when 'delete' is not in PROTONMAIL_ALLOWED_ACTIONS", async () => {
  await withServer({}, async (client) => {
    await assert.rejects(
      client.callTool({ name: "delete_folder", arguments: { path: "Folders/Old", confirmed: true } }),
      /disabled by the current runtime policy/i,
    );
  });
});

test("delete_label rejects when 'delete' is not in PROTONMAIL_ALLOWED_ACTIONS", async () => {
  await withServer({}, async (client) => {
    await assert.rejects(
      client.callTool({ name: "delete_label", arguments: { name: "Old", confirmed: true } }),
      /disabled by the current runtime policy/i,
    );
  });
});
