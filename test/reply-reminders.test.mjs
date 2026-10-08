import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { ReplyReminderService } from "../dist/services/reply-reminder-service.js";
import { LocalIndexService } from "../dist/services/local-index-service.js";
import { slugifyAccountAddress } from "../dist/utils/helpers.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";

// "Tell me if nobody answers this by <date>": a local note, with its state (waiting / due / answered) worked out
// from the local index when it is read.

const DAY = 24 * 3600 * 1000;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

function accountConfig(dataDir, address) {
  return { address, slug: slugifyAccountAddress(address),
    imap: { host: "127.0.0.1", port: 9, secure: false, username: address, password: "x" },
    smtp: { host: "127.0.0.1", port: 9, secure: false, username: address, password: "x" }, dataDir };
}
const baseRuntime = { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false,
  autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0 };

const mail = (uid, subject, from, when, extra = {}) => ({
  id: `INBOX::${uid}`, folder: "INBOX", uid, seq: uid, messageId: `<m${uid}@example.com>`, subject,
  from: [{ name: from, address: from }], to: [{ address: from === "owner@example.com" ? "ann@example.com" : "owner@example.com" }], cc: [], bcc: [], replyTo: [],
  date: when, internalDate: when, isRead: true, isStarred: false, flags: [], preview: "", hasAttachments: false, attachments: [], labels: [], ...extra,
});
const folders = [{ path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "\\Inbox", listed: true, subscribed: true, flags: [], messages: 3, unseen: 0 }];
const seed = (service, emails) => service.recordSnapshot({ syncedAt: new Date().toISOString(), folders, folderStats: [{ folder: "INBOX", fetched: emails.length, total: emails.length, strategy: "recent" }], emails });

async function withServer({ addresses = ["owner@example.com"], runtime = {} } = {}, fn) {
  const dirs = await Promise.all(addresses.map(() => mkdtemp(join(tmpdir(), "reminders-"))));
  const accounts = addresses.map((address, i) => accountConfig(dirs[i], address));
  const config = { smtp: accounts[0].smtp, imap: accounts[0].imap, dataDir: dirs[0], debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    runtime: { ...baseRuntime, ...runtime }, accounts };
  const { server, accountManager } = createServer(config, { startBackgroundSync: false });
  const bundles = accountManager.all();
  for (const bundle of bundles) {
    bundle.localIndexService.getFreshness = async () => ({ storedMessageCount: 1, isStale: false });
    bundle.imapService.getFolderStats = async () => { throw new Error("no bridge"); };
    bundle.localIndexService.getSyncCheckpointMap = async () => ({ INBOX: { folder: "INBOX", uidNext: 2, total: 1 } });
    bundle.imapService.getEmailById = async (id) => {
      const uid = Number(String(id).split("::").pop());
      return mail(uid, uid === 1 ? "Proposal" : "Other", bundle.account.address, iso(-2 * DAY));
    };
  }
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (name, args) => {
    try {
      const r = await client.callTool({ name, arguments: args });
      const text = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      let json; try { json = JSON.parse(r.content.find((c) => c.type === "text" && !c.text.startsWith("Note:"))?.text ?? ""); } catch { /* not JSON */ }
      return { error: r.isError === true, text, json };
    } catch (error) { return { error: true, text: String(error?.message ?? error) }; }
  };
  try { await fn({ call, bundles }); } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
  }
}

test("a reminder is set for a message, moved by setting it again, and listed as waiting", async () => {
  await withServer({}, async ({ call }) => {
    const set = await call("set_reply_reminder", { emailId: "INBOX::1", afterDays: 5, note: "ask about the budget" });
    assert.equal(set.error, false, set.text);
    assert.equal(set.json.state, "waiting");
    assert.equal(set.json.subject, "Proposal");
    assert.equal(set.json.note, "ask about the budget");
    const again = await call("set_reply_reminder", { emailId: "INBOX::1", afterDays: 10 });
    assert.equal(again.json.id, set.json.id, "same message, same reminder");
    const listed = await call("list_reply_reminders", {});
    assert.equal(listed.json.total, 1);
    assert.equal(listed.json.reminders[0].state, "waiting");
    assert.ok(new Date(listed.json.reminders[0].remindAt).getTime() > Date.now() + 9 * DAY);
  });
});

test("bad dates are refused", async () => {
  await withServer({}, async ({ call }) => {
    for (const args of [{ remindAt: "not a date" }, { remindAt: iso(-DAY) }, { afterDays: 2, remindAt: iso(DAY) }, { afterDays: "soon" }]) {
      const result = await call("set_reply_reminder", { emailId: "INBOX::1", ...args });
      assert.equal(result.error, true, JSON.stringify(args));
    }
    assert.equal((await call("list_reply_reminders", {})).json.total, 0);
    // Like every number argument here, afterDays is kept inside its range (1-365) rather than refused.
    const far = await call("set_reply_reminder", { emailId: "INBOX::1", afterDays: 400 });
    const days = (new Date(far.json.remindAt).getTime() - Date.now()) / DAY;
    assert.ok(days > 364 && days <= 365, String(days));
  });
});

test("past its date with no answer a reminder is due, shows in the digest, and an answer from someone else settles it", async () => {
  await withServer({}, async ({ call, bundles }) => {
    const [bundle] = bundles;
    await seed(bundle.localIndexService, [mail(1, "Proposal", "owner@example.com", iso(-4 * DAY))]);
    // Set three days ago for a date one second ahead of now: it is due as soon as that second has passed.
    await bundle.replyReminderService.set({ emailId: "INBOX::1", messageId: "<m1@example.com>", subject: "Proposal", to: ["ann@example.com"], remindAt: new Date(Date.now() + 1000), now: new Date(Date.now() - 3 * DAY) });
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const due = await call("list_reply_reminders", {});
    assert.equal(due.json.due, 1);
    assert.equal(due.json.reminders[0].state, "due");
    assert.ok(due.json.reminders[0].daysOverdue >= 0);

    const digest = await call("get_inbox_digest", {});
    assert.equal(digest.json.repliesDueTotal, 1);
    assert.equal(digest.json.repliesDue[0].subject, "Proposal");

    // Your own follow-up does not count as an answer; Ann's reply does.
    await seed(bundle.localIndexService, [mail(2, "Re: Proposal", "owner@example.com", iso(-1000), { inReplyTo: "<m1@example.com>", references: ["<m1@example.com>"] })]);
    assert.equal((await call("list_reply_reminders", {})).json.reminders[0].state, "due");
    await seed(bundle.localIndexService, [mail(3, "Re: Proposal", "ann@example.com", iso(-500), { inReplyTo: "<m1@example.com>", references: ["<m1@example.com>"] })]);
    const after = await call("list_reply_reminders", { status: "all" });
    assert.equal(after.json.reminders[0].state, "answered");
    assert.equal(after.json.reminders[0].answeredBy, "ann@example.com");
    assert.equal((await call("list_reply_reminders", {})).json.total, 0, "answered ones are left out by default");
    assert.equal((await call("get_inbox_digest", {})).json.repliesDue, undefined, "nothing due, nothing in the digest");
  });
});

test("a reminder is cancelled by its id, and an unknown id says so", async () => {
  await withServer({}, async ({ call }) => {
    const set = await call("set_reply_reminder", { emailId: "INBOX::1", afterDays: 2 });
    assert.deepEqual((await call("cancel_reply_reminder", { id: "constructor" })).json, { id: "constructor", canceled: false });
    assert.equal((await call("cancel_reply_reminder", { id: set.json.id })).json.canceled, true);
    assert.equal((await call("cancel_reply_reminder", { id: set.json.id })).json.canceled, false);
    assert.equal((await call("list_reply_reminders", { status: "all" })).json.total, 0);
  });
});

test("read-only mode keeps reminders from being set or cancelled, but still lists them", async () => {
  await withServer({ runtime: { readOnly: true, allowSend: false } }, async ({ call }) => {
    assert.match((await call("set_reply_reminder", { emailId: "INBOX::1", afterDays: 2 })).text, /read-only/i);
    assert.match((await call("cancel_reply_reminder", { id: "x" })).text, /read-only/i);
    assert.equal((await call("list_reply_reminders", {})).error, false);
  });
});

test("with two accounts ids carry the account prefix and the account argument narrows the list", async () => {
  await withServer({ addresses: ["owner@example.com", "work@example.com"] }, async ({ call }) => {
    const personal = await call("set_reply_reminder", { emailId: "INBOX::1", afterDays: 2 });
    const work = await call("set_reply_reminder", { emailId: "dawid-x::INBOX::1".replace("dawid-x", slugifyAccountAddress("work@example.com")), afterDays: 2 });
    assert.ok(!personal.json.id.includes("::"), "the primary account's ids stay plain");
    assert.ok(work.json.id.startsWith(`${slugifyAccountAddress("work@example.com")}::`), work.json.id);
    assert.equal((await call("list_reply_reminders", {})).json.total, 2);
    assert.equal((await call("list_reply_reminders", { account: "work@example.com" })).json.total, 1);
    assert.equal((await call("cancel_reply_reminder", { id: work.json.id })).json.canceled, true);
    assert.equal((await call("list_reply_reminders", {})).json.total, 1);
  });
});

test("the service survives a damaged file and cleans up", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reminders-svc-"));
  try {
    const service = new ReplyReminderService({ dataDir: dir, smtp: { username: "o@example.com" } });
    await writeFile(join(dir, "reply-reminders.json"), "{ not json");
    assert.deepEqual(await service.list(), []);
    const record = await service.set({ emailId: "INBOX::1", messageId: "<a@b>", subject: "s", to: ["x@y.z"], remindAt: new Date(Date.now() + DAY) });
    assert.equal((await service.list()).length, 1);
    assert.ok((await readdir(dir)).some((name) => name.startsWith("reply-reminders.json.corrupt")), "the damaged file was set aside, not overwritten");
    assert.deepEqual(await service.cancel(record.id), { id: record.id, canceled: true });
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("getRepliesSince returns only newer messages from other people in the same thread", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reminders-idx-"));
  const config = { dataDir: dir, smtp: { username: "owner@example.com", host: "127.0.0.1", port: 9 }, imap: { username: "owner@example.com", host: "127.0.0.1", port: 9 } };
  const index = new LocalIndexService(config);
  try {
    await seed(index, [
      mail(1, "Proposal", "owner@example.com", iso(-5 * DAY)),
      mail(2, "Re: Proposal", "ann@example.com", iso(-4.5 * DAY), { inReplyTo: "<m1@example.com>", references: ["<m1@example.com>"] }),
      mail(3, "Re: Proposal", "owner@example.com", iso(-1 * DAY), { inReplyTo: "<m2@example.com>", references: ["<m1@example.com>", "<m2@example.com>"] }),
      mail(4, "Re: Proposal", "bob@example.com", iso(-0.5 * DAY), { inReplyTo: "<m3@example.com>", references: ["<m1@example.com>", "<m3@example.com>"] }),
      mail(5, "Unrelated", "ann@example.com", iso(-0.1 * DAY)),
    ]);
    const own = ["owner@example.com"];
    assert.deepEqual((await index.getRepliesSince("<m1@example.com>", iso(-3 * DAY), own)).map((e) => e.uid), [4]);
    assert.deepEqual((await index.getRepliesSince("<m1@example.com>", iso(-6 * DAY), own)).map((e) => e.uid).sort(), [2, 4]);
    assert.deepEqual(await index.getRepliesSince("<nope@example.com>", iso(-6 * DAY), own), []);
    assert.deepEqual(await index.getRepliesSince("", iso(-6 * DAY), own), []);
  } finally { await index.close(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
