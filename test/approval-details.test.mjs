import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";

// The question the person answers has to say what they approve. For these tools it used to carry the account and a word or
// two. It is now filled from what the server holds (the stored rule or proposal, the merged automatic reply, the local
// index), cleaned and capped like every other field, and for a rule and the automatic reply it is bound to the answer.

const ADDRESS = "owner@example.com";
const CHANGED = /changed after you were asked/;

async function withServer(fn, { answer = "decline" } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "approval-details-"));
  const conn = { host: "127.0.0.1", port: 9, secure: false, username: ADDRESS, password: "x" };
  const config = {
    smtp: conn, imap: conn, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: ADDRESS, slug: "owner-example-com", imap: conn, smtp: conn, dataDir: dir }],
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: false, allowedActions: ["delete", "trash", "archive", "move", "mark_read", "label"], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false,
      autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: true, allowEmptyFolder: true, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0, approval: "elicit" },
  };
  const { server, accountManager } = createServer(config, { startBackgroundSync: false });
  const bundle = accountManager.primary();
  const client = new Client({ name: "t", version: "0" }, { capabilities: { elicitation: {} } });
  const asked = [];
  const hooks = { onAsk: async () => {} };
  client.setRequestHandler(ElicitRequestSchema, async (request) => { asked.push(request.params.message); await hooks.onAsk(request.params.message); return { action: answer }; });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = (name, args) => client.callTool({ name, arguments: args });
  const text = (result) => result.content[0].text;
  try { await fn({ call, text, asked, hooks, dir, bundle }); } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const line = (question, label) => question.split("\n").find((entry) => entry.startsWith(`${label}: `));
const noHidden = (question) => assert.doesNotMatch(question.replace(/\n/g, ""), /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);

// ---- set_autoresponder ----------------------------------------------------------------------------------------------

test("set_autoresponder: the question shows the effective reply - mode, subject, text, languages, window, rules", async () => {
  await withServer(async ({ call, asked }) => {
    await call("set_autoresponder", {
      enabled: true, subject: "Away", body: "B".repeat(400), bodies: { pl: "P".repeat(200) }, mode: "draft",
      startsAt: "2026-11-01T00:00:00Z", endsAt: "2026-11-10T00:00:00Z", replyEveryDays: 3,
      rules: [{ name: "vip", from: ["boss@x.example"], action: "reply", body: "hi" }, { name: "rest", action: "skip" }],
    });
    const question = asked[0];
    assert.match(question, /^Approve set_autoresponder\?\nAccount: "owner@example\.com"\n/);
    assert.equal(line(question, "Automatic reply"), "Automatic reply: on");
    assert.equal(line(question, "Mode"), "Mode: draft");
    assert.equal(line(question, "Reply subject"), 'Reply subject: "Away"');
    assert.match(line(question, "Reply text"), /^Reply text: "B{299}…"$/);
    assert.match(line(question, "Text in pl"), /^Text in pl: "P{99}…"$/);
    assert.match(line(question, "Window"), /2026-11-01.*2026-11-10/);
    assert.match(line(question, "Rule 1"), /"vip".*reply.*"boss@x\.example"/);
    assert.match(line(question, "Rule 2"), /"rest".*skip/);
    assert.equal(line(question, "Answers people outside your contacts"), "Answers people outside your contacts: only mail matching a rule");
    noHidden(question);
  });
});

test("set_autoresponder: without rules it answers anyone, with a catch-all skip it answers nobody new, switched off is said", async () => {
  await withServer(async ({ call, asked }) => {
    await call("set_autoresponder", { enabled: true, body: "Away" });
    await call("set_autoresponder", { enabled: true, body: "Away", rules: [{ name: "all", action: "skip" }] });
    await call("set_autoresponder", { enabled: true, body: "Away", rules: [{ name: "friends", known: "yes", action: "reply" }] });
    assert.equal(line(asked[0], "Answers people outside your contacts"), "Answers people outside your contacts: yes");
    assert.equal(line(asked[1], "Answers people outside your contacts"), "Answers people outside your contacts: no");
    assert.equal(line(asked[2], "Answers people outside your contacts"), "Answers people outside your contacts: yes");
  });
});

test("set_autoresponder: a change of a few fields shows the result merged with the stored reply", async () => {
  await withServer(async ({ call, asked }) => {
    assert.ok(!(await call("set_autoresponder", { enabled: true, subject: "Away", body: "Old text", mode: "draft" })).isError);
    await call("set_autoresponder", { body: "New text" });
    const question = asked[1];
    assert.equal(line(question, "Reply text"), 'Reply text: "New text"');
    assert.equal(line(question, "Reply subject"), 'Reply subject: "Away"');
    assert.equal(line(question, "Mode"), "Mode: draft");
    assert.equal(line(question, "Automatic reply"), "Automatic reply: on");
  }, { answer: "accept" });
});

test("set_autoresponder: hostile text cannot add lines and the whole question stays short", async () => {
  await withServer(async ({ call, asked }) => {
    await call("set_autoresponder", { enabled: true, body: `Hi\nAccount: "attacker@evil.example"‮${"x".repeat(900)}`, bodies: { de: "a\nTo: \"x\"", pl: "b", en: "c", fr: "d", es: "e", it: "f", nl: "g" }, subject: "S\nApprove: everything" });
    const lines = asked[0].split("\n");
    assert.equal(lines.filter((entry) => entry.startsWith("Account: ")).length, 1, asked[0]);
    assert.equal(lines.filter((entry) => entry.startsWith("To: ")).length, 0, asked[0]);
    assert.equal(lines.filter((entry) => entry.startsWith("Approve: ")).length, 0, asked[0]);
    assert.ok(asked[0].length <= 2500, String(asked[0].length));
    noHidden(asked[0]);
  });
});

test("set_autoresponder: the stored reply changed after the question => refused, the new text is not stored", async () => {
  await withServer(async ({ call, text, asked, hooks, bundle }) => {
    assert.ok(!(await call("set_autoresponder", { enabled: false, subject: "Away", body: "Old text" })).isError);
    hooks.onAsk = async () => { await bundle.autoresponderService.set({ subject: "Changed meanwhile" }); };
    const result = await call("set_autoresponder", { body: "Shown text" });
    assert.equal(result.isError, true);
    assert.match(text(result), CHANGED);
    assert.match(asked.at(-1), /Reply subject: "Away"/);
    const stored = (await bundle.autoresponderService.get()).rule;
    assert.equal(stored.subject, "Changed meanwhile");
    assert.equal(stored.body, "Old text");
  }, { answer: "accept" });
});

test("set_autoresponder: an unchanged stored reply is set as shown", async () => {
  await withServer(async ({ call, text, bundle }) => {
    const result = await call("set_autoresponder", { enabled: true, body: "Hello" });
    assert.ok(!result.isError, text(result));
    assert.equal((await bundle.autoresponderService.get()).rule.body, "Hello");
  }, { answer: "accept" });
});

// ---- set_rule -------------------------------------------------------------------------------------------------------

const proposal = (actions, id = "p-1") => ({
  id, kind: "sender-folder", title: "t", rule: { name: "Fwd boss", when: { from: ["boss@x.example"], subjectContains: ["urgent"] }, actions },
  evidence: { messages: 3, examples: [] }, risk: "low", createdAt: "2026-10-01T00:00:00.000Z",
});
const rulesFile = (dir, { proposals = [], rules = [] } = {}) =>
  writeFile(join(dir, "rules.json"), JSON.stringify({ version: 1, rules, proposals, dismissed: [], handled: {}, forwarded: { date: "", count: 0 }, log: [] }));
const readRules = async (dir) => JSON.parse(await readFile(join(dir, "rules.json"), "utf8"));

test("set_rule from a proposal: the question shows its name, conditions and every action, and the forwarding cap", async () => {
  await withServer(async ({ call, asked, dir }) => {
    await rulesFile(dir, { proposals: [proposal({ forwardTo: ["fwd@other.example"], label: "VIP", markRead: true, moveTo: "Folders/Boss" })] });
    await call("set_rule", { proposalId: "p-1" });
    const question = asked[0];
    assert.equal(line(question, "Rule"), 'Rule: "Fwd boss"');
    assert.equal(line(question, "From"), 'From: proposal "p-1"');
    assert.match(line(question, "When"), /"boss@x\.example".*"urgent"/);
    const actions = line(question, "Actions");
    for (const part of ['forward to "fwd@other.example"', 'label "VIP"', "mark read", 'move to "Folders/Boss"']) assert.ok(actions.includes(part), `${part}: ${actions}`);
    assert.match(line(question, "Forwarding"), /at most 50 messages a day.*without asking each time/);
    noHidden(question);
  });
});

test("set_rule on an existing rule shows the stored rule; a rule that does not forward says nothing about forwarding", async () => {
  await withServer(async ({ call, asked, dir }) => {
    const rule = (id, actions) => ({ id, name: `Rule ${id}`, enabled: false, when: { from: ["a@x.example"] }, actions, createdAt: "2026-10-01T00:00:00.000Z" });
    await rulesFile(dir, { rules: [rule("r-1", { forwardTo: ["f@other.example"] }), rule("r-2", { archive: true, trash: true })] });
    await call("set_rule", { id: "r-1", enabled: true });
    await call("set_rule", { id: "r-2", name: "Rule r-2 renamed" });
    assert.equal(line(asked[0], "Rule"), 'Rule: "Rule r-1"');
    assert.equal(line(asked[0], "From"), 'From: existing rule "r-1"');
    assert.match(line(asked[0], "Actions"), /forward to "f@other\.example"/);
    assert.match(line(asked[0], "Forwarding"), /50 messages a day/);
    assert.equal(line(asked[0], "Switched on"), "Switched on: yes");
    assert.equal(line(asked[1], "Rule"), 'Rule: "Rule r-2 renamed"');
    assert.match(line(asked[1], "Actions"), /archive.*move to Trash/);
    assert.equal(line(asked[1], "Forwarding"), undefined);
  });
});

test("set_rule from a proposal: the proposal rewritten after the question => refused, no rule is stored", async () => {
  await withServer(async ({ call, text, asked, hooks, dir }) => {
    await rulesFile(dir, { proposals: [proposal({ forwardTo: ["fwd@other.example"] })] });
    hooks.onAsk = async () => { await rulesFile(dir, { proposals: [proposal({ forwardTo: ["evil@other.example"] })] }); };
    const result = await call("set_rule", { proposalId: "p-1" });
    assert.equal(result.isError, true);
    assert.match(text(result), CHANGED);
    assert.match(asked[0], /fwd@other\.example/);
    assert.deepEqual((await readRules(dir)).rules, []);
  }, { answer: "accept" });
});

test("set_rule on an existing rule: its actions changed after the question => refused; unchanged => stored", async () => {
  await withServer(async ({ call, text, hooks, dir }) => {
    const rule = (forwardTo) => ({ id: "r-1", name: "Old", enabled: false, when: { from: ["a@x.example"] }, actions: { forwardTo: [forwardTo] }, createdAt: "2026-10-01T00:00:00.000Z" });
    await rulesFile(dir, { rules: [rule("f@other.example")] });
    hooks.onAsk = async () => { await rulesFile(dir, { rules: [rule("evil@other.example")] }); };
    const refused = await call("set_rule", { id: "r-1", enabled: true });
    assert.equal(refused.isError, true);
    assert.match(text(refused), CHANGED);
    assert.equal((await readRules(dir)).rules[0].enabled, false);
    hooks.onAsk = async () => {};
    const ok = await call("set_rule", { id: "r-1", enabled: true });
    assert.ok(!ok.isError, text(ok));
    assert.equal((await readRules(dir)).rules[0].enabled, true);
  }, { answer: "accept" });
});

// ---- the local index: apply_rules, bulk_delete, empty_folder, delete_folder ---------------------------------------------

const mail = (uid, subject, from = "boss@x.example", overrides = {}) => {
  const date = new Date(Date.now() - uid * 3 * 24 * 3600 * 1000).toISOString();
  return { id: `INBOX::${uid}`, folder: "INBOX", uid, seq: uid, messageId: `<m${uid}@example.com>`, subject,
    from: [{ name: from, address: from }], to: [{ address: ADDRESS }], cc: [], bcc: [], replyTo: [],
    date, internalDate: date, isRead: false, isStarred: false, flags: [], preview: "", hasAttachments: false, attachments: [], labels: [], isAutomated: false, ...overrides };
};
const seed = (bundle, emails) => bundle.localIndexService.recordSnapshot({
  syncedAt: new Date().toISOString(),
  folders: [{ path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "\\Inbox", listed: true, subscribed: true, flags: [], messages: emails.length, unseen: emails.length }],
  folderStats: [{ folder: "INBOX", fetched: emails.length, total: emails.length, strategy: "recent" }], emails,
});

test("apply_rules (a real run): the question counts the messages each rule matches and names its actions", async () => {
  await withServer(async ({ call, asked, dir, bundle }) => {
    await seed(bundle, [mail(1, "a"), mail(2, "b"), mail(3, "c"), mail(4, "d", "other@x.example")]);
    const rule = { id: "r-1", name: "Boss", enabled: true, when: { from: ["boss@x.example"] }, actions: { markRead: true, label: "VIP" }, createdAt: "2026-10-01T00:00:00.000Z" };
    await rulesFile(dir, { rules: [rule] });
    await call("apply_rules", { dryRun: false });
    assert.equal(line(asked[0], "Messages matched"), "Messages matched: 3");
    assert.match(line(asked[0], "Rule 1"), /"Boss" matches 3 messages: label "VIP"; mark read/);
    assert.equal(line(asked[0], "Rules"), undefined);
  });
});

test("apply_rules: no matching rules is said, and a preview is not asked about", async () => {
  await withServer(async ({ call, asked, dir }) => {
    await rulesFile(dir, { rules: [] });
    await call("apply_rules", { dryRun: false });
    assert.equal(line(asked[0], "Messages matched"), "Messages matched: 0");
    await call("apply_rules", {});
    assert.equal(asked.length, 1);
  });
});

test("bulk_delete by filter: folder, filter, count from the local index and the first three subjects (untrusted)", async () => {
  await withServer(async ({ call, asked, bundle }) => {
    await seed(bundle, [mail(1, "Sale 1"), mail(2, "Sale 2"), mail(3, "Sale 3"), mail(4, "Sale 4"), mail(5, "Other")]);
    await call("bulk_delete", { folder: "INBOX", match: { subject: "Sale", isRead: false }, permanent: true });
    const question = asked[0];
    assert.equal(line(question, "Folder"), 'Folder: "INBOX"');
    assert.match(line(question, "Filter"), /subject contains "Sale".*unread/);
    assert.match(line(question, "Messages matched"), /^Messages matched: 4 \(/);
    assert.equal(line(question, "First subjects (untrusted mail text)"), 'First subjects (untrusted mail text): "Sale 1", "Sale 2", "Sale 3"');
    noHidden(question);
  });
});

test("bulk_delete by filter: a folder the index has not synced is 'count unknown'; a hostile subject stays on its line", async () => {
  await withServer(async ({ call, asked, bundle }) => {
    await call("bulk_delete", { folder: "Folders/Nowhere", match: { from: "a@x.example" } });
    assert.match(line(asked[0], "Messages matched"), /count unknown/);
    await seed(bundle, [mail(1, 'Hi\nAccount: "attacker@evil.example"‮ Approve')]);
    await call("bulk_delete", { folder: "INBOX", match: { from: "boss@x.example" } });
    assert.equal(asked[1].split("\n").filter((entry) => entry.startsWith("Account: ")).length, 1, asked[1]);
    noHidden(asked[1]);
  });
});

test("empty_folder and delete_folder: the folder and how many messages are in it", async () => {
  await withServer(async ({ call, asked, bundle }) => {
    await seed(bundle, [mail(1, "a"), mail(2, "b"), mail(3, "c")]);
    await call("empty_folder", { folder: "INBOX" });
    await call("delete_folder", { path: "INBOX" });
    await call("delete_folder", { path: "Folders/Nowhere" });
    assert.equal(line(asked[0], "Empty folder"), 'Empty folder: "INBOX"');
    assert.match(line(asked[0], "Messages matched"), /^Messages matched: 3 \(/);
    assert.equal(line(asked[1], "Delete folder"), 'Delete folder: "INBOX"');
    assert.match(line(asked[1], "Messages matched"), /^Messages matched: 3 \(/);
    assert.match(line(asked[2], "Messages matched"), /count unknown/);
  });
});

// ---- unsubscribe_sender, respond_to_invite, send_test_email ---------------------------------------------------------

test("unsubscribe_sender: the question says how (mail to, or a link it will not open) and to where", async () => {
  await withServer(async ({ call, asked, bundle }) => {
    const headers = (list) => ({ list: { unsubscribe: list } });
    let current = headers({ mail: "mailto:u@news.example?subject=bye", url: "https://web.news.example/u" });
    bundle.imapService.getEmailById = async (id) => ({ id, folder: "INBOX", uid: 1, subject: "Sale", from: [{ address: "news@news.example" }], to: [], cc: [], bcc: [], replyTo: [], attachments: [], flags: [], labels: [], headers: current });
    await call("unsubscribe_sender", { emailId: "INBOX::1" });
    current = headers({ url: "https://web.news.example/u" });
    await call("unsubscribe_sender", { emailId: "INBOX::1" });
    current = {};
    await call("unsubscribe_sender", { emailId: "INBOX::1" });
    assert.equal(line(asked[0], "Unsubscribe by"), 'Unsubscribe by: mail to "u@news.example" (from the message, untrusted)');
    assert.match(line(asked[1], "Unsubscribe by"), /link on "web\.news\.example".*not open/);
    assert.match(line(asked[2], "Unsubscribe by"), /no List-Unsubscribe/);
  });
});

test("respond_to_invite: the question names the response, the organiser and the event (untrusted)", async () => {
  await withServer(async ({ call, asked, bundle }) => {
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:evt-1@example.com", "SEQUENCE:1", "DTSTART:20261015T090000Z", "DTEND:20261015T100000Z",
      "SUMMARY:Quarterly planning", "ORGANIZER;CN=Anna:mailto:anna@corp.example", `ATTENDEE;PARTSTAT=NEEDS-ACTION;CN=Me:mailto:${ADDRESS}`, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
    bundle.imapService.getEmailById = async (id) => ({ id, folder: "INBOX", uid: 1, subject: "Invitation", from: [{ address: "anna@corp.example" }], to: [], cc: [], bcc: [], replyTo: [], flags: [], labels: [],
      attachments: [{ id: "a1", filename: "invite.ics", contentType: "text/calendar", isCalendarInvite: true, kind: "calendar" }] });
    bundle.imapService.getAttachmentContent = async () => ({ base64: Buffer.from(ics, "utf8").toString("base64") });
    await call("respond_to_invite", { emailId: "INBOX::1", response: "accept" });
    assert.equal(line(asked[0], "Response"), 'Response: "accept"');
    assert.equal(line(asked[0], "Organiser (from the invitation, untrusted)"), 'Organiser (from the invitation, untrusted): "anna@corp.example"');
    assert.equal(line(asked[0], "Event (from the invitation, untrusted)"), 'Event (from the invitation, untrusted): "Quarterly planning"');
  });
});

test("send_test_email: the question names the recipient, the sender address and the message", async () => {
  await withServer(async ({ call, asked }) => {
    await call("send_test_email", { to: "dest@example.org", from: ADDRESS, customMessage: "Hello\nAccount: \"x\"" });
    assert.equal(line(asked[0], "To"), 'To: "dest@example.org"');
    assert.equal(line(asked[0], "Send as"), `Send as: "${ADDRESS}"`);
    assert.match(line(asked[0], "Message"), /^Message: "Hello Account: \\"x\\""$/);
    assert.equal(asked[0].split("\n").filter((entry) => entry.startsWith("Account: ")).length, 1);
  });
});
