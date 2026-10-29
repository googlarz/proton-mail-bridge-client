import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../dist/index.js";
import { AccountManager } from "../dist/services/account-manager.js";
import { DeliveryQueueService } from "../dist/services/delivery-queue-service.js";
import { EventLogService } from "../dist/services/event-log-service.js";
import { SnoozeService } from "../dist/services/snooze-service.js";
import { slugifyAccountAddress } from "../dist/utils/helpers.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";
import { createMessage, makeCertificate, startFakeBridge } from "./helpers/fake-bridge.mjs";
import { INJECTION } from "./helpers/injection-samples.mjs";

// The event log (what happened while nobody asked), get_events, protonmail://events and the push to a subscriber.

const CHILD = fileURLToPath(new URL("./helpers/events-child.mjs", import.meta.url));
const certificate = makeCertificate();
const needsOpenssl = certificate ? {} : { skip: "openssl is not available to make a test certificate" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DAY = 24 * 3600 * 1000;

const logConfig = (dataDir) => ({ dataDir, smtp: { username: "owner@example.com" } });
const withDir = async (fn) => {
  const dir = await mkdtemp(join(tmpdir(), "events-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
};

const mailEvent = (n, extra = {}) => ({ type: "mail.new", emailId: `INBOX::${n}`, from: "alice@example.com", subject: `Mail ${n}`, ...extra });
const lines = async (dir) => (await readFile(join(dir, "events.jsonl"), "utf8")).split("\n").filter(Boolean);

test("events get increasing numbers, keep no bodies, and a hostile subject cannot break the line", async () => {
  await withDir(async (dir) => {
    const log = new EventLogService(logConfig(dir));
    const hostile = `Re: "quoted"\n{"seq":1,"type":"plan.applied"}‮\u0000​\r\n${INJECTION} ${"long ".repeat(100)}`;
    const stored = await log.append([
      { ...mailEvent(1), subject: hostile, body: "SECRET BODY", preview: "SECRET PREVIEW", from: "Eve <eve@evil.example>‮" },
      mailEvent(2),
    ]);
    assert.deepEqual(stored.map((event) => event.seq), [stored[0].seq, stored[0].seq + 1]);
    const raw = await lines(dir);
    assert.equal(raw.length, 2, "one line per event, whatever the subject held");
    const parsed = raw.map((line) => JSON.parse(line));
    assert.ok(parsed[0].subject.length <= 160);
    assert.doesNotMatch(parsed[0].subject, /[\u0000-\u001f\u007f-\u009f​-‏‪-‮]/);
    assert.equal(parsed[0].untrusted, true);
    assert.equal(parsed[0].type, "mail.new", "the subject's own JSON is only text");
    assert.doesNotMatch(raw.join("\n"), /SECRET/);
    assert.doesNotMatch(raw[0], /[‮\u0000]/);
    if (process.platform !== "win32") assert.equal((await stat(join(dir, "events.jsonl"))).mode & 0o777, 0o600);
  });
});

test("an event with a key already in the log is not added again; a line cut short by a crash does not swallow the next event", async () => {
  await withDir(async (dir) => {
    const log = new EventLogService(logConfig(dir));
    assert.equal((await log.append([mailEvent(1, { key: "k1" })])).length, 1);
    assert.equal((await log.append([mailEvent(1, { key: "k1" }), mailEvent(2, { key: "k2" })])).length, 1);
    await appendFile(join(dir, "events.jsonl"), '{"seq":99999999999999,"type":"mail.new","at":"2026');
    await log.append([mailEvent(3)]);
    const all = await log.readAll();
    assert.deepEqual(all.map((event) => event.emailId), ["INBOX::1", "INBOX::2", "INBOX::3"]);
    assert.equal(new Set(all.map((event) => event.seq)).size, 3);
  });
});

test("the numbers continue after a restart", async () => {
  await withDir(async (dir) => {
    const first = new EventLogService(logConfig(dir));
    const [a, b] = await first.append([mailEvent(1), mailEvent(2)]);
    const second = new EventLogService(logConfig(dir));
    const [c] = await second.append([mailEvent(3)]);
    assert.equal(b.seq, a.seq + 1);
    assert.equal(c.seq, b.seq + 1);
  });
});

test("the log is bounded by count and by size: it rotates, keeps the newest events and numbers them without a gap", async () => {
  await withDir(async (dir) => {
    const log = new EventLogService(logConfig(dir));
    for (let batch = 0; batch < 9; batch += 1) {
      await log.append(Array.from({ length: 300 }, (_, i) => mailEvent(batch * 300 + i)));
    }
    const all = await log.readAll();
    assert.ok(all.length < 2700 && all.length >= 1000, `kept ${all.length}`);
    assert.equal(all.at(-1).emailId, "INBOX::2699", "the newest is there");
    for (let i = 1; i < all.length; i += 1) assert.equal(all[i].seq, all[i - 1].seq + 1);
    await stat(join(dir, "events.1.jsonl"));
    if (process.platform !== "win32") assert.equal((await stat(join(dir, "events.1.jsonl"))).mode & 0o777, 0o600);
  });
  await withDir(async (dir) => {
    const log = new EventLogService(logConfig(dir));
    const big = { type: "send.failed", refId: "q", subject: "s".repeat(200), detail: "d".repeat(400) };
    for (let batch = 0; batch < 15; batch += 1) await log.append(Array.from({ length: 100 }, () => big));
    assert.ok((await stat(join(dir, "events.jsonl"))).size < 700 * 1024, "the current file stays near its size cap");
    await stat(join(dir, "events.1.jsonl"));
  });
});

test("two server processes appending at once leave a valid log with every event once", async () => {
  await withDir(async (dir) => {
    const run = (tag) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [CHILD, dir, "60", tag], { stdio: "inherit" });
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child ${tag} exited ${code}`))));
        child.on("error", reject);
      });
    await Promise.all([run("a"), run("b")]);
    const raw = await lines(dir);
    assert.equal(raw.length, 120);
    const all = raw.map((line) => JSON.parse(line));
    assert.equal(new Set(all.map((event) => event.seq)).size, 120, "no number twice");
    for (let i = 1; i < all.length; i += 1) assert.equal(all[i].seq, all[i - 1].seq + 1);
    for (const tag of ["a", "b"]) assert.equal(all.filter((event) => event.emailId.startsWith(`INBOX::${tag}`)).length, 60);
  });
});

function accountConfig(dataDir, address) {
  return {
    address, slug: slugifyAccountAddress(address),
    imap: { host: "127.0.0.1", port: 9, secure: false, username: address, password: "x" },
    smtp: { host: "127.0.0.1", port: 9, secure: false, username: address, password: "x" }, dataDir,
  };
}
const baseRuntime = { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false,
  autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0 };

async function openServer(dirs, addresses) {
  const accounts = addresses.map((address, i) => accountConfig(dirs[i], address));
  const config = { smtp: accounts[0].smtp, imap: accounts[0].imap, dataDir: dirs[0], debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    runtime: baseRuntime, accounts };
  const { server, accountManager } = createServer(config, { startBackgroundSync: false, eventNotifications: { debounceMs: 40, pollMs: 40 } });
  const client = new Client({ name: "t", version: "0" });
  const updates = [];
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => { updates.push(notification.params.uri); });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    let json;
    try { json = JSON.parse(result.content.find((part) => part.type === "text")?.text ?? ""); } catch { /* not JSON */ }
    return { error: result.isError === true, text, json };
  };
  return { client, call, updates, bundles: accountManager.all(), close: async () => { await client.close(); await server.close(); await closeTrackedIndexes(); } };
}

async function withServer({ addresses = ["owner@example.com"] } = {}, fn) {
  const dirs = await Promise.all(addresses.map(() => mkdtemp(join(tmpdir(), "events-srv-"))));
  const opened = await openServer(dirs, addresses);
  try {
    await fn({ ...opened, dirs });
  } finally {
    await opened.close();
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
  }
}

test("get_events: the newest events first, then only what is new since the cursor, in pages, across a restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "events-restart-"));
  try {
    let cursor;
    {
      const s = await openServer([dir], ["owner@example.com"]);
      try {
        const empty = await s.call("get_events", {});
        assert.equal(empty.error, false, empty.text);
        assert.deepEqual(empty.json.events, []);
        await s.bundles[0].eventLog.append([mailEvent(1), mailEvent(2), mailEvent(3)]);
        const first = await s.call("get_events", {});
        assert.deepEqual(first.json.events.map((event) => event.emailId), ["INBOX::1", "INBOX::2", "INBOX::3"]);
        assert.equal(first.json.events[0].account, "owner@example.com");
        assert.equal(first.json.events[0].untrusted, true);
        assert.equal(first.json.hasMore, false);
        assert.match(first.json.note, /untrusted/);
        const nothing = await s.call("get_events", { sinceCursor: first.json.nextCursor });
        assert.deepEqual(nothing.json.events, []);
        assert.equal(nothing.json.nextCursor, first.json.nextCursor);
        cursor = first.json.nextCursor;
      } finally {
        await s.close();
      }
    }
    const s = await openServer([dir], ["owner@example.com"]);
    try {
      await s.bundles[0].eventLog.append([mailEvent(4), mailEvent(5), mailEvent(6), mailEvent(7), mailEvent(8)]);
      const seen = [];
      let page = await s.call("get_events", { sinceCursor: cursor, limit: 2 });
      assert.equal(page.json.hasMore, true);
      for (let i = 0; i < 5 && page.json.events.length > 0; i += 1) {
        seen.push(...page.json.events.map((event) => event.emailId));
        page = await s.call("get_events", { sinceCursor: page.json.nextCursor, limit: 2 });
      }
      assert.deepEqual(seen, ["INBOX::4", "INBOX::5", "INBOX::6", "INBOX::7", "INBOX::8"], "a cursor from before the restart still works; no event twice or missed");
      assert.notEqual(page.json.missed, true);
    } finally {
      await s.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("get_events: types and groups filter, bad arguments are refused, and a cursor that rotated away is reported", async () => {
  await withServer({}, async ({ call, bundles }) => {
    const log = bundles[0].eventLog;
    await log.append([mailEvent(1), { type: "send.sent", refId: "q1", subject: "Hello" }, { type: "snooze.woke", refId: "s1", emailId: "INBOX::9" }, mailEvent(2)]);
    const mail = await call("get_events", { types: ["mail.new"] });
    assert.deepEqual(mail.json.events.map((event) => event.type), ["mail.new", "mail.new"]);
    const group = await call("get_events", { types: "send,snooze" });
    assert.deepEqual(group.json.events.map((event) => event.type), ["send.sent", "snooze.woke"]);
    const cursorAfterFilter = (await call("get_events", { types: ["send"] })).json.nextCursor;
    await log.append([{ type: "send.failed", refId: "q2", detail: "SMTP down" }]);
    const next = await call("get_events", { types: ["send"], sinceCursor: cursorAfterFilter });
    assert.deepEqual(next.json.events.map((event) => event.type), ["send.failed"]);

    assert.equal((await call("get_events", { types: ["nonsense"] })).error, true);
    assert.equal((await call("get_events", { sinceCursor: "12345" })).error, true);
    assert.equal((await call("get_events", { sinceCursor: "c1.!!!" })).error, true);
    assert.equal((await call("get_events", { account: "nobody@example.com" })).error, true);

    const early = (await call("get_events", { limit: 1 })).json.nextCursor;
    for (let batch = 0; batch < 9; batch += 1) await log.append(Array.from({ length: 300 }, (_, i) => mailEvent(batch * 300 + i)));
    const late = await call("get_events", { sinceCursor: early, limit: 5 });
    assert.equal(late.json.missed, true, "events between the cursor and the oldest kept are gone");
    assert.equal(late.json.events.length, 5);
    assert.match(late.json.note, /dropped/);
    const current = await call("get_events", { limit: 3 });
    const caughtUp = await call("get_events", { sinceCursor: current.json.nextCursor });
    assert.deepEqual(caughtUp.json.events, []);
    assert.notEqual(caughtUp.json.missed, true);
  });
});

test("get_events: accounts keep their own place in the cursor, ids carry the account prefix, and account narrows", async () => {
  await withServer({ addresses: ["owner@example.com", "second@example.com"] }, async ({ call, bundles }) => {
    await bundles[0].eventLog.append([mailEvent(1)]);
    await bundles[1].eventLog.append([mailEvent(2, { from: "bob@example.com" }), { type: "snooze.woke", refId: "snz", emailId: "INBOX::7" }]);
    const all = await call("get_events", {});
    const second = all.json.events.filter((event) => event.account === "second@example.com");
    const prefix = `${slugifyAccountAddress("second@example.com")}::`;
    assert.ok(second.filter((event) => event.emailId).every((event) => event.emailId.startsWith(prefix)), JSON.stringify(second));
    assert.equal(all.json.events.find((event) => event.account === "owner@example.com").emailId, "INBOX::1", "the primary account's ids carry no prefix");
    assert.equal(second.find((event) => event.type === "snooze.woke").refId, `${prefix}snz`);
    await bundles[0].eventLog.append([mailEvent(3)]);
    const more = await call("get_events", { sinceCursor: all.json.nextCursor });
    assert.deepEqual(more.json.events.map((event) => event.emailId), ["INBOX::3"], "only the account with news");
    const only = await call("get_events", { account: "second@example.com" });
    assert.ok(only.json.events.every((event) => event.account === "second@example.com"));
  });
});

test("get_events marks a hostile subject like the readers do, and the JSON stays valid", async () => {
  await withServer({}, async ({ call, bundles }) => {
    await bundles[0].eventLog.append([
      { ...mailEvent(1), subject: `Invoice\n"}]} ${INJECTION}` },
      { type: "send.sent", refId: "q", subject: `Re: ${INJECTION}` },
      mailEvent(2),
    ]);
    const result = await call("get_events", {});
    assert.equal(result.error, false, result.text);
    const [hostile, sent, plain] = result.json.events;
    assert.equal(hostile.risk.level, "high");
    assert.equal(sent.risk.level, "high", "also an event with no message id");
    assert.equal(plain.risk, undefined);
    assert.doesNotMatch(hostile.subject, /\n/);
    assert.match(hostile.subject, /Invoice/);
  });
});

test("snooze and the delivery queue report what they did", async () => {
  await withDir(async (dir) => {
    const config = { ...logConfig(dir), runtime: baseRuntime, imap: {}, smtp: { username: "owner@example.com" } };
    const events = [];
    const imap = {
      fail: false,
      async createFolder() { return { path: "Folders/MCP-Snoozed", created: true }; },
      async withTimeout(promise) { return promise; },
      async moveEmail(_emailId, targetFolder) {
        if (this.fail) throw new Error("Message not found");
        return { targetEmailId: `${targetFolder}::7` };
      },
    };
    const snooze = new SnoozeService(config, imap);
    snooze.setEventSink((event) => events.push(event));
    const woke = await snooze.snooze("INBOX::5", new Date(Date.now() - 1000).toISOString());
    await snooze.checkDue();
    assert.deepEqual(events.map((event) => [event.type, event.refId]), [["snooze.woke", woke.id]]);

    imap.fail = false;
    const doomed = await snooze.snooze("INBOX::6", new Date(Date.now() - 1000).toISOString());
    imap.fail = true;
    for (let i = 0; i < 5; i += 1) await snooze.checkDue();
    assert.deepEqual(events.slice(1).map((event) => [event.type, event.refId]), [["snooze.failed", doomed.id]], "reported once, when it gives up");

    const queue = new DeliveryQueueService(config, { async sendEmail(payload) { if (payload.subject === "bad") throw new Error("SMTP send failed"); return { messageId: "<m@x>", accepted: payload.to, rejected: [] }; } });
    queue.setEventSink((event) => events.push(event));
    const past = new Date(Date.now() - 1000).toISOString();
    const ok = await queue.enqueue({ to: ["a@example.com"], subject: "good", body: "b" }, past, "scheduled_send");
    const bad = await queue.enqueue({ to: ["a@example.com"], subject: "bad", body: "b" }, past, "scheduled_send");
    await queue.checkDue();
    const sends = events.filter((event) => event.type.startsWith("send.")).sort((left, right) => left.type.localeCompare(right.type)).reverse();
    assert.deepEqual(sends.map((event) => [event.type, event.refId, event.subject]), [["send.sent", ok.id, "good"], ["send.failed", bad.id, "bad"]]);
    assert.match(sends[1].detail, /SMTP send failed/);
  });
});

test("a sync announces new unread mail once; the autoresponder, a rule and a due reminder are announced too", needsOpenssl, async () => {
  const dir = await mkdtemp(join(tmpdir(), "events-sync-"));
  const soon = (offset) => new Date(Date.now() + 60_000 + offset);
  const bridge = await startFakeBridge({
    mode: "starttls", certificate,
    folders: { INBOX: { uidValidity: 1, messages: [
      createMessage(1, { subject: "Lunch?", from: "alice@example.com", date: soon(0) }),
      createMessage(2, { subject: "Old", from: "bob@example.com", date: new Date(Date.UTC(2020, 0, 1)) }),
      createMessage(3, { subject: "Already read", from: "carol@example.com", flags: ["\\Seen"], date: soon(1) }),
      createMessage(4, { subject: "My own note", from: "owner@example.com", date: soon(2) }),
    ] }, Archive: { uidValidity: 3, specialUse: "\\Archive", messages: [] } },
  });
  const imap = { host: "127.0.0.1", port: bridge.port, secure: false, username: "owner@example.com", password: "secret" };
  const smtp = { host: "127.0.0.1", port: 9, secure: false, username: "owner@example.com", password: "secret" };
  const manager = new AccountManager({
    smtp, imap, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: true, syncInterval: 5,
    accounts: [{ address: "owner@example.com", slug: slugifyAccountAddress("owner@example.com"), imap, smtp, dataDir: dir }],
    runtime: { ...baseRuntime, allowedActions: ["mark_read", "archive", "move"], confirmDestructive: true },
  });
  const bundle = manager.primary();
  bundle.smtpService.sendEmail = async (input) => ({ messageId: "<r@x>", accepted: input.to, rejected: [], response: "250" });
  try {
    await bundle.autoresponderService.set({ enabled: true, body: "Away", subject: "Away: {subject}" });
    await bundle.rulesService.set({ name: "alice read", when: { from: ["alice@example.com"] }, actions: { markRead: true } });
    await bundle.replyReminderService.set({ emailId: "INBOX::1", messageId: "<sent-by-me@x>", subject: "Proposal", to: ["dan@example.com"], remindAt: new Date(Date.now() - 1000), now: new Date(Date.now() - DAY) });

    await bundle.backgroundSyncService.runNow("manual");
    await bundle.eventLog.flush();
    const first = await bundle.eventLog.readAll();
    const byType = (type) => first.filter((event) => event.type === type);
    assert.equal(byType("mail.new").length, 1, JSON.stringify(first.map((e) => [e.type, e.subject])));
    assert.equal(byType("mail.new")[0].subject, "Lunch?");
    assert.equal(byType("mail.new")[0].from, "alice@example.com");
    assert.ok(byType("autoresponder.replied").some((event) => event.emailId === byType("mail.new")[0].emailId && event.subject === "Lunch?"));
    assert.equal(byType("rule.acted").length, 1);
    assert.equal(byType("rule.acted")[0].emailId, byType("mail.new")[0].emailId);
    assert.match(byType("rule.acted")[0].detail, /alice read: marked read/);
    assert.equal(byType("reply_reminder.due").length, 1);
    assert.equal(byType("reply_reminder.due")[0].subject, "Proposal");

    await bundle.backgroundSyncService.runNow("manual");
    await bundle.eventLog.flush();
    assert.equal((await bundle.eventLog.readAll()).length, first.length, "a second sync announces nothing again");
  } finally {
    bundle.backgroundSyncService.stop();
    await bundle.imapService.disconnect().catch(() => {});
    await bundle.localIndexService.close();
    await bridge.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("applying and undoing a triage plan are announced", needsOpenssl, async () => {
  const dir = await mkdtemp(join(tmpdir(), "events-plan-"));
  const bridge = await startFakeBridge({
    mode: "starttls", certificate,
    folders: { INBOX: { uidValidity: 1, messages: [createMessage(1, { subject: "Newsletter", from: "news@example.com", date: new Date(Date.now() - 10 * DAY) })] } },
  });
  const imap = { host: "127.0.0.1", port: bridge.port, secure: false, username: "owner@example.com", password: "secret" };
  const smtp = { host: "127.0.0.1", port: 9, secure: false, username: "owner@example.com", password: "secret" };
  const config = {
    smtp, imap, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: "owner@example.com", slug: slugifyAccountAddress("owner@example.com"), imap, smtp, dataDir: dir }],
    runtime: { ...baseRuntime, allowedActions: ["mark_read", "archive", "move"] },
  };
  const { server, accountManager } = createServer(config, { startBackgroundSync: false });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  const bundle = accountManager.primary();
  try {
    const plan = await call("plan_inbox", { items: [{ emailId: "INBOX::1", action: "mark_read" }] });
    const planId = plan.plan?.id ?? plan.planId;
    assert.ok(planId, JSON.stringify(plan));
    await call("approve_plan", { planId });
    await call("undo_plan", { planId });
    await bundle.eventLog.flush();
    const events = (await bundle.eventLog.readAll()).filter((event) => event.type.startsWith("plan."));
    assert.deepEqual(events.map((event) => [event.type, event.refId]), [["plan.applied", planId], ["plan.undone", planId]]);
    assert.match(events[0].detail, /1 applied/);
  } finally {
    await client.close();
    await server.close();
    await bundle.imapService.disconnect().catch(() => {});
    await closeTrackedIndexes();
    await bridge.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("protonmail://events: listed, readable, subscribable, and the only resource that is", async () => {
  await withServer({}, async ({ client, bundles }) => {
    const capabilities = client.getServerCapabilities();
    assert.equal(capabilities.resources.subscribe, true);
    assert.equal(capabilities.resources.listChanged, undefined, "list changes are not announced, so they are not advertised");
    const listed = await client.listResources();
    assert.equal(listed.resources[0].uri, "protonmail://events");
    await bundles[0].eventLog.append([mailEvent(1, { subject: `Hi ${INJECTION}` })]);
    const read = await client.readResource({ uri: "protonmail://events" });
    const body = JSON.parse(read.contents[0].text);
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].risk.level, "high", "the resource goes through the same check as the tool");
    assert.ok(body.nextCursor);
    await assert.rejects(client.subscribeResource({ uri: "protonmail://email/INBOX::1" }), /Only protonmail:\/\/events/);
  });
});

test("a subscriber is told once per batch of events; nobody who did not subscribe is told anything", async () => {
  await withServer({}, async ({ client, bundles, updates }) => {
    const log = bundles[0].eventLog;
    await log.append([mailEvent(1)]);
    await sleep(150);
    assert.deepEqual(updates, [], "no subscription, no notification");

    await client.subscribeResource({ uri: "protonmail://events" });
    log.emit(mailEvent(2));
    log.emit(mailEvent(3));
    log.emit(mailEvent(4));
    await log.flush();
    await sleep(250);
    assert.deepEqual(updates, ["protonmail://events"], "three events in one batch give one notification");

    await log.append([mailEvent(5)]);
    await sleep(250);
    assert.equal(updates.length, 2, "the next batch gives the next notification");

    await client.unsubscribeResource({ uri: "protonmail://events" });
    await log.append([mailEvent(6)]);
    await sleep(250);
    assert.equal(updates.length, 2, "after unsubscribing nothing more is sent");
  });
});

test("events appended by another server process reach a subscriber too", async () => {
  await withServer({}, async ({ client, bundles, updates, dirs }) => {
    await client.subscribeResource({ uri: "protonmail://events" });
    await sleep(120);
    const other = new EventLogService(logConfig(dirs[0]));
    await other.append([mailEvent(1), mailEvent(2)]);
    await sleep(400);
    assert.deepEqual(updates, ["protonmail://events"]);
    assert.equal((await bundles[0].eventLog.readAll()).length, 2);
  });
});
