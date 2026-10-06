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

net.Socket.prototype.connect = () => { throw new Error("Network disabled in this test file"); };

// search_emails (live IMAP) and search_indexed_emails must both search every
// configured account by default, and accept `account` (address or slug) to
// restrict to one. Per-account services are stubbed; nothing touches a network.

function account(dir, address, slug) {
  return {
    address, slug, dataDir: dir,
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: address, password: "x" },
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: address, password: "x" },
  };
}

function summary(id, date) {
  return { id, folder: "Sent", uid: 1, subject: `s-${id}`, from: [{ address: "a@example.com" }], to: [], cc: [], bcc: [], date, internalDate: date, isRead: true, isStarred: false, flags: [], labels: [], hasAttachments: false, attachments: [] };
}

async function withServer(fn) {
  const d1 = await mkdtemp(join(tmpdir(), "search-tools-1-"));
  const d2 = await mkdtemp(join(tmpdir(), "search-tools-2-"));
  const primary = account(d1, "primary@example.com", "primary-example-com");
  const secondary = account(d2, "second@example.com", "second-example-com");
  const config = {
    smtp: primary.smtp, imap: primary.imap, dataDir: d1, debug: false, cacheEnabled: true, analyticsEnabled: true,
    autoSync: false, syncInterval: 5,
    runtime: {
      readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false,
      autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30,
      confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false, allowFileDownloadDir: undefined,
      maxInlineBytes: 40960, opDelayMs: 0, sendDelaySeconds: 0,
    },
    accounts: [primary, secondary],
  };
  const { server, accountManager } = createServer(config, { startBackgroundSync: false });
  const [p, s] = accountManager.all();
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const stubLive = (bundle, emails) => {
    bundle.imapService.searchEmails = async (input) => {
      calls.push({ slug: bundle.account.slug, input });
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { folders: ["Sent"], limit: input.limit, total: emails.length, totalMatched: emails.length, hasMore: false, emails };
    };
  };
  stubLive(p, [summary("Sent::1::1::aa", "2026-09-01T00:00:00Z")]);
  stubLive(s, [summary("Sent::2::1::bb", "2026-09-02T00:00:00Z")]);
  const stubIndexed = (bundle, emails) => {
    bundle.localIndexService.search = async () => ({ total: emails.length, hasMore: false, emails });
  };
  stubIndexed(p, [summary("Sent::1::1::aa", "2026-09-01T00:00:00Z")]);
  stubIndexed(s, [summary("Sent::2::1::bb", "2026-09-02T00:00:00Z")]);
  const client = new Client({ name: "test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  try {
    await fn({ call, calls, secondarySlug: secondary.slug, maxInFlight: () => maxInFlight, primaryBundle: p, secondBundle: s });
  } finally {
    await client.close();
    await server.close();
    await closeTrackedIndexes();
    await rm(d1, { recursive: true, force: true });
    await rm(d2, { recursive: true, force: true });
  }
}

for (const tool of ["search_emails", "search_indexed_emails"]) {
  test(`${tool} searches all accounts by default and prefixes non-primary ids`, async () => {
    await withServer(async ({ call, secondarySlug }) => {
      const result = await call(tool, { folder: "Sent" });
      assert.deepEqual(result.emails.map((e) => e.id), [`${secondarySlug}::Sent::2::1::bb`, "Sent::1::1::aa"]);
    });
  });

  test(`${tool} with account (slug or address) restricts to that account`, async () => {
    await withServer(async ({ call, secondarySlug }) => {
      for (const account of [secondarySlug, "SECOND@example.com"]) {
        const result = await call(tool, { folder: "Sent", account });
        assert.deepEqual(result.emails.map((e) => e.id), [`${secondarySlug}::Sent::2::1::bb`]);
      }
      const primaryOnly = await call(tool, { folder: "Sent", account: "primary@example.com" });
      assert.deepEqual(primaryOnly.emails.map((e) => e.id), ["Sent::1::1::aa"]);
    });
  });

  test(`${tool} rejects an unknown account with a clear error`, async () => {
    await withServer(async ({ call }) => {
      await assert.rejects(call(tool, { account: "nobody@example.com" }), /Unknown account "nobody@example.com"/);
    });
  });
}

test("search_emails queries accounts one at a time and honours limit across the merge", async () => {
  await withServer(async ({ call, calls, maxInFlight }) => {
    const result = await call("search_emails", { folder: "Sent", limit: 1 });
    assert.equal(calls.length, 2);
    assert.equal(maxInFlight(), 1, "per-account IMAP searches must not overlap");
    assert.equal(result.emails.length, 1);
    assert.equal(result.hasMore, true);
  });
});

// Found in review: the default became "all accounts", so ONE unreachable account (or a folder that
// exists in only one account) made the whole live search fail. It must return the rest and say what failed.
test("search_emails without account returns the other accounts' results when one account fails", async () => {
  await withServer(async ({ call, secondBundle }) => {
    secondBundle.imapService.searchEmails = async () => { throw new Error("Mailbox does not exist"); };
    const result = await call("search_emails", { folder: "Sent" });
    assert.equal(result.emails.length, 1);
    assert.deepEqual(result.failedAccounts, [{ account: "second-example-com", error: "Mailbox does not exist" }]);
  });
});

test("search_emails throws when the account was named explicitly, or when every account fails", async () => {
  await withServer(async ({ call, primaryBundle, secondBundle }) => {
    secondBundle.imapService.searchEmails = async () => { throw new Error("boom"); };
    await assert.rejects(call("search_emails", { folder: "Sent", account: "second@example.com" }), /boom/);
    primaryBundle.imapService.searchEmails = async () => { throw new Error("boom too"); };
    await assert.rejects(call("search_emails", { folder: "Sent" }), /boom/);
  });
});

// Found while checking count_messages against search_emails: the tool handler replaced the
// service's own hasMore with "returned == limit", so a search whose candidates were cut (the
// non-ASCII scan checks only the newest 500) still said hasMore:false with 0 results.
test("search_emails keeps an account's own hasMore when fewer than limit results came back", async () => {
  await withServer(async ({ call, primaryBundle }) => {
    primaryBundle.imapService.searchEmails = async (input) => ({
      folders: ["Sent"], limit: input.limit, total: 0, totalMatched: 0, hasMore: true, emails: [],
    });
    const result = await call("search_emails", { folder: "Sent", limit: 10 });
    assert.equal(result.emails.length, 1); // only the second account returned something
    assert.equal(result.hasMore, true);
  });
});

test("search_emails reports hasMore:false when no account has more and fewer than limit came back", async () => {
  await withServer(async ({ call }) => {
    const result = await call("search_emails", { folder: "Sent", limit: 10 });
    assert.equal(result.hasMore, false);
  });
});

test("search_emails on a single-account server keeps the service's own hasMore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "search-tools-single-"));
  const only = account(dir, "only@example.com", "only-example-com");
  const config = {
    smtp: only.smtp, imap: only.imap, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true,
    autoSync: false, syncInterval: 5,
    runtime: {
      readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false,
      autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30,
      confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false, allowFileDownloadDir: undefined,
      maxInlineBytes: 40960, opDelayMs: 0, sendDelaySeconds: 0,
    },
    accounts: [only],
  };
  const { server, imapService } = createServer(config, { startBackgroundSync: false });
  imapService.searchEmails = async (input) => ({ folders: ["INBOX"], limit: input.limit, total: 0, totalMatched: 0, hasMore: true, emails: [] });
  const client = new Client({ name: "test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const result = JSON.parse((await client.callTool({ name: "search_emails", arguments: { limit: 10 } })).content[0].text);
    assert.equal(result.hasMore, true);
  } finally {
    await client.close();
    await server.close();
    await closeTrackedIndexes();
    await rm(dir, { recursive: true, force: true });
  }
});
