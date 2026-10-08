import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { slugifyAccountAddress } from "../dist/utils/helpers.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";

// Triage and statistics tools covered every configured account with no way to ask for one. They now take `account`
// (address or slug), the same argument search_indexed_emails already had.

const FILTERED = [
  "list_scheduled_sends", "list_drafts", "list_remote_drafts", "get_emails", "count_messages", "folder_stats", "top_senders",
  "get_folders", "list_snoozed", "get_email_stats", "get_email_analytics", "get_contacts", "get_volume_trends", "get_labels",
  "get_threads", "get_actionable_threads", "get_inbox_digest", "get_follow_up_candidates", "find_document_threads",
  "prepare_meeting_context", "get_index_status",
];

function accountConfig(dataDir, address) {
  return {
    address, slug: slugifyAccountAddress(address),
    imap: { host: "127.0.0.1", port: 9, secure: false, username: address, password: "x" },
    smtp: { host: "127.0.0.1", port: 9, secure: false, username: address, password: "x" },
    dataDir,
  };
}

async function withServer(addresses, fn) {
  const dirs = await Promise.all(addresses.map(() => mkdtemp(join(tmpdir(), "account-filter-"))));
  const accounts = addresses.map((address, i) => accountConfig(dirs[i], address));
  const config = {
    smtp: accounts[0].smtp, imap: accounts[0].imap, dataDir: dirs[0], debug: false, cacheEnabled: true,
    analyticsEnabled: true, autoSync: false, syncInterval: 5,
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false,
      autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30,
      confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0 },
    accounts,
  };
  const { server, accountManager } = createServer(config, { startBackgroundSync: false });
  const bundles = accountManager.all();
  for (const bundle of bundles) {
    // No Bridge in these tests: the refresh before an indexed read finds the index fresh and does nothing.
    bundle.localIndexService.getFreshness = async () => ({ storedMessageCount: 1, isStale: false });
    bundle.imapService.getFolderStats = async () => { throw new Error("no bridge"); };
    bundle.localIndexService.getSyncCheckpointMap = async () => ({ INBOX: { folder: "INBOX", uidNext: 2, total: 1 } });
  }
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try { await fn({ client, bundles }); } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
  }
}

const call = async (client, name, args) => {
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    return { error: r.isError === true, text, json: (() => { try { return JSON.parse(r.content.find((c) => c.type === "text" && !c.text.startsWith("Note:"))?.text ?? ""); } catch { return undefined; } })() };
  } catch (error) { return { error: true, text: String(error?.message ?? error), json: undefined }; }
};

test("every triage and statistics tool declares an account argument", async () => {
  await withServer(["owner@example.com", "work@example.com"], async ({ client }) => {
    const { tools } = await client.listTools();
    for (const name of FILTERED) assert.ok(tools.find((tool) => tool.name === name)?.inputSchema?.properties?.account, `${name} has no account argument`);
  });
});

for (const addresses of [["owner@example.com"], ["owner@example.com", "work@example.com"]]) {
  test(`an unknown account is an error for every one of them (${addresses.length} configured)`, async () => {
    await withServer(addresses, async ({ client }) => {
      for (const name of FILTERED) {
        const result = await call(client, name, { account: "nobody@example.com" });
        assert.equal(result.error, true, name);
        assert.match(result.text, /Unknown account/, name);
      }
    });
  });
}

const mail = (uid, subject, from, overrides = {}) => {
  const date = new Date(Date.now() - uid * 3 * 24 * 3600 * 1000).toISOString();
  return { id: `INBOX::${uid}`, folder: "INBOX", uid, seq: uid, messageId: `<m${uid}@example.com>`, subject,
    from: [{ name: from, address: from }], to: [{ address: "owner@example.com" }], cc: [], bcc: [], replyTo: [],
    date, internalDate: date, isRead: false, isStarred: false, flags: [], preview: "", hasAttachments: false, attachments: [], labels: [], ...overrides };
};
const folders = [{ path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "\\Inbox", listed: true, subscribed: true, flags: [], messages: 2, unseen: 2 }];
const seed = (bundle, emails) => bundle.localIndexService.recordSnapshot({
  syncedAt: new Date().toISOString(), folders, folderStats: [{ folder: "INBOX", fetched: emails.length, total: emails.length, strategy: "recent" }], emails,
});

test("threads, digest, follow-ups, actionable threads, labels and documents follow the account that was asked for", async () => {
  await withServer(["owner@example.com", "work@example.com"], async ({ client, bundles }) => {
    const [personal, work] = bundles;
    await seed(personal, [mail(1, "Personal invoice", "ann@example.com", { labels: ["Labels/Private"], hasAttachments: true, attachments: [{ id: "1", filename: "invoice.pdf", contentType: "application/pdf", size: 5, kind: "document" }] })]);
    await seed(work, [mail(2, "Work contract", "bob@example.com", { labels: ["Labels/Clients"], hasAttachments: true, attachments: [{ id: "1", filename: "contract.pdf", contentType: "application/pdf", size: 5, kind: "document" }] })]);
    const subjectsOf = (json) => (json?.threads ?? []).map((thread) => thread.subject).sort();

    for (const tool of ["get_threads", "get_actionable_threads", "get_follow_up_candidates"]) {
      const both = await call(client, tool, tool === "get_follow_up_candidates" ? { minAgeHours: 1, pendingOn: "any" } : {});
      assert.deepEqual(subjectsOf(both.json), ["Personal invoice", "Work contract"], `${tool}: both accounts by default`);
      const onlyWork = await call(client, tool, { account: "work@example.com", ...(tool === "get_follow_up_candidates" ? { minAgeHours: 1, pendingOn: "any" } : {}) });
      assert.deepEqual(subjectsOf(onlyWork.json), ["Work contract"], `${tool}: work only, by address`);
      const onlyPersonal = await call(client, tool, { account: personal.account.slug, ...(tool === "get_follow_up_candidates" ? { minAgeHours: 1, pendingOn: "any" } : {}) });
      assert.deepEqual(subjectsOf(onlyPersonal.json), ["Personal invoice"], `${tool}: personal only, by slug`);
    }

    const digestWork = await call(client, "get_inbox_digest", { account: "work@example.com", minAgeHours: 1 });
    assert.deepEqual((digestWork.json.topThreads ?? []).map((t) => t.subject), ["Work contract"]);
    const docsPersonal = await call(client, "find_document_threads", { account: personal.account.slug });
    assert.deepEqual(subjectsOf(docsPersonal.json), ["Personal invoice"]);
    const labelsWork = await call(client, "get_labels", { account: "work@example.com" });
    const labelNames = JSON.stringify(labelsWork.json);
    assert.ok(labelNames.includes("Clients") && !labelNames.includes("Private"), labelNames);
    const statusWork = await call(client, "get_index_status", { account: "work@example.com" });
    assert.match(statusWork.json.path, /account-filter-/);
    assert.notEqual(statusWork.json.path, (await call(client, "get_index_status", {})).json.path, "the primary account's index is the default");
  });
});

test("drafts and folders follow the account too", async () => {
  await withServer(["owner@example.com", "work@example.com"], async ({ client, bundles }) => {
    const [personal, work] = bundles;
    await personal.draftStore.createDraft({ to: ["x@example.com"], subject: "Personal draft", body: "b" });
    await work.draftStore.createDraft({ to: ["x@example.com"], subject: "Work draft", body: "b" });
    personal.imapService.getFolders = async () => [{ path: "INBOX", name: "INBOX" }, { path: "Folders/Private", name: "Private" }];
    work.imapService.getFolders = async () => [{ path: "INBOX", name: "INBOX" }, { path: "Folders/Clients", name: "Clients" }];
    const draftSubjects = (json) => (json?.drafts ?? json ?? []).map?.((draft) => draft.subject).sort();
    assert.deepEqual(draftSubjects((await call(client, "list_drafts", {})).json), ["Personal draft", "Work draft"]);
    assert.deepEqual(draftSubjects((await call(client, "list_drafts", { account: "work@example.com" })).json), ["Work draft"]);
    const folderText = (await call(client, "get_folders", { account: "work@example.com" })).text;
    assert.ok(folderText.includes("Clients") && !folderText.includes("Private"), folderText.slice(0, 300));
  });
});
