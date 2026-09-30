import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";

// No real Bridge: any connection attempt fails immediately.
net.Socket.prototype.connect = () => { throw new Error("Network disabled in this test file"); };

async function withServer(fn, stubImap) {
  const dataDir = await mkdtemp(join(tmpdir(), "search-refresh-"));
  const smtp = { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "x" };
  const imap = { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "x" };
  const config = {
    smtp, imap, dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: "owner@example.com", slug: "owner-example-com", imap, smtp, dataDir }],
    runtime: {
      readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false,
      autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30,
      confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0,
    },
  };
  const { server, imapService, localIndexService } = createServer(config, { startBackgroundSync: false });
  stubImap?.(imapService, localIndexService);
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try { await fn(client); } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

test("search_indexed_emails still serves the local index when the refresh cannot reach Bridge", async () => {
  await withServer(async (client) => {
    const result = await client.callTool({ name: "search_indexed_emails", arguments: { query: "anything" } });
    assert.ok(!result.isError, "a failed refresh must not turn the search into an error");
  });
});

test("search_indexed_emails probes the mailbox for changes before answering", async () => {
  let probed = 0;
  await withServer(async (client) => {
    await client.callTool({ name: "search_indexed_emails", arguments: { query: "x" } });
    assert.ok(probed > 0, "the handler must consult the mailbox (getFolderStats/STATUS) instead of trusting the index blindly");
  }, (imapService) => {
    // Index is empty, so a refresh is attempted; count the attempt at the IMAP layer.
    const original = imapService.collectEmailsForIndex?.bind(imapService);
    imapService.collectEmailsForIndex = async (...args) => { probed += 1; return original ? original(...args) : Promise.reject(new Error("no bridge")); };
    imapService.getFolderStats = async () => { probed += 1; throw new Error("no bridge"); };
  });
});

test("a stalled refresh is abandoned after a few seconds and skipped on the next search", async () => {
  let calls = 0;
  await withServer(async (client) => {
    const started = Date.now();
    const first = await client.callTool({ name: "search_indexed_emails", arguments: { query: "x" } });
    assert.ok(!first.isError);
    assert.ok(Date.now() - started < 8000, "a Bridge that never answers must not hold the search");
    const second = Date.now();
    await client.callTool({ name: "search_indexed_emails", arguments: { query: "x" } });
    assert.ok(Date.now() - second < 500, "after a failed refresh the probe is skipped for a while");
    assert.equal(calls, 1, "the stalled probe must not be retried on every search");
  }, (imapService) => {
    imapService.getFolderStats = () => { calls += 1; return new Promise(() => {}); };
    imapService.collectEmailsForIndex = () => { calls += 1; return new Promise(() => {}); };
  });
});

// Found in review: with the change probe added, ONE new INBOX message made the analytics tools
// (get_email_stats etc.) run an UNSCOPED refresh — every folder, with attachment text — the pattern
// that used to exceed the client's 60 s timeout. The refresh must stay on the probed folder.
test("a change in INBOX refreshes only INBOX for the analytics tools, not every folder", async () => {
  const refreshed = [];
  let index;
  await withServer(async (client) => {
    const fresh = new Date().toISOString();
    await index.recordSnapshot({
      syncedAt: fresh,
      folders: [{ path: "INBOX", name: "INBOX", delimiter: "/", listed: true, subscribed: true, flags: [], messages: 1, unseen: 0 }],
      folderStats: [{ folder: "INBOX", fetched: 1, total: 1, uidNext: 11, highestUid: 10 }],
      emails: [{
        id: "INBOX::1", folder: "INBOX", uid: 1, seq: 1, messageId: "<a@x>", subject: "s", from: [{ address: "a@x.test" }],
        to: [], cc: [], bcc: [], replyTo: [], date: fresh, internalDate: fresh, isRead: true, isStarred: false,
        flags: [], preview: "p", hasAttachments: false, attachments: [], labels: [],
      }],
    });
    await client.callTool({ name: "get_volume_trends", arguments: {} });
    assert.ok(refreshed.length > 0, "the new INBOX UID must trigger a refresh");
    assert.deepEqual([...new Set(refreshed)], ["INBOX"], "only INBOX may be refreshed, never every folder");
  }, (imapService, localIndexService) => {
    index = localIndexService;
    imapService.getFolderStats = async () => ({ folder: "INBOX", uidNext: 15, total: 5, unseen: 0 });
    imapService.collectEmailsForIndex = async (input) => {
      refreshed.push(input.folder ?? "ALL");
      return { syncedAt: new Date().toISOString(), full: false, folders: [], folderStats: [], emails: [] };
    };
  });
});
