import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { GrantService } from "../dist/services/grant-service.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";
import { INJECTION } from "./helpers/injection-samples.mjs";

// The gate in front of every tool call and the claim just before the send, through a whole server: what a grant lets
// through, what it never does, and that a use is spent exactly when mail is sent or queued.

const ADDRESS = "owner@example.com";
const SECOND = "second@example.com";
const HOUR = 3_600_000;
const DETAIL = {
  id: "INBOX::1::1::abc", folder: "INBOX", uid: 1, subject: "Hello",
  from: [{ name: "Ann", address: "ann@example.com" }],
  to: [{ name: "", address: ADDRESS }, { name: "", address: "dan@example.com" }], cc: [{ name: "", address: "carol@example.com" }], bcc: [], replyTo: [],
  date: "2026-09-19T10:00:00.000Z", messageId: "<orig@example.com>", references: [],
  body: "original text", text: "original text", attachments: [], isRead: true, isStarred: false, flags: [], labels: [],
};
const BAD_DETAIL = { ...DETAIL, id: "INBOX::2::1::bad", subject: "Invoice", body: INJECTION, text: INJECTION };

// delegation / approval / confirmDestructive and the rest of the runtime are the knobs; `answer` is what the person does when asked.
async function withServer(options, fn) {
  const delegation = "delegation" in options ? options.delegation : "on";
  const { approval, confirmDestructive = true, readOnly = false, allowSend = true, restrictOutboundToSelf = false, allowedActions = ["delete", "trash"], answer = "decline", capability = { elicitation: {} }, sendDelaySeconds, secondAccount = false } = options;
  const dir = await mkdtemp(join(tmpdir(), "delegation-gate-"));
  const conn = { host: "127.0.0.1", port: 9, secure: false, username: ADDRESS, password: "x" };
  const config = {
    smtp: conn, imap: conn, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [
      { address: ADDRESS, slug: "owner-example-com", imap: conn, smtp: conn, dataDir: dir },
      ...(secondAccount ? [{ address: SECOND, slug: "second-example-com", imap: { ...conn, username: SECOND }, smtp: { ...conn, username: SECOND }, dataDir: join(dir, "second") }] : []),
    ],
    runtime: {
      readOnly, allowSend, allowRemoteDraftSync: false, allowedActions, startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false,
      autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive, allowEmptyFolder: true, restrictOutboundToSelf,
      maxInlineBytes: 40960, opDelayMs: 0, ...(delegation ? { delegation } : {}), ...(approval ? { approval } : {}), ...(sendDelaySeconds ? { sendDelaySeconds } : {}),
    },
  };
  const { server, accountManager } = createServer(config, { startBackgroundSync: false });
  const bundle = accountManager.primary();
  const sent = [];
  const second = secondAccount ? accountManager.byAddress(SECOND) : undefined;
  for (const each of [bundle, second].filter(Boolean)) {
    each.smtpService.sendEmail = async (payload) => { sent.push({ ...payload, through: each.account.address }); return { messageId: "<sent@example.com>", accepted: payload.to, rejected: [], response: "250" }; };
    each.imapService.getEmailById = async (id) => ({ ...(String(id).includes("bad") ? BAD_DETAIL : DETAIL) });
  }
  const client = new Client({ name: "t", version: "0" }, { capabilities: capability });
  const asked = [];
  if (capability.elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      asked.push(request.params.message);
      return typeof answer === "function" ? answer(request) : { action: answer };
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const grants = new GrantService({ dataDir: dir, smtp: { username: ADDRESS } }, ADDRESS);
  const grant = (extra = {}) => grants.createGrant({ tools: ["send_email"], recipients: ["bob@example.com"], maxUses: 2, expiresAt: new Date(Date.now() + HOUR), ...extra });
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const used = async () => (await grants.list()).map((entry) => entry.usedCount);
  try {
    await fn({ call, sent, asked, grants, grant, used, bundle, dir, client, second, accountManager });
  } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const text = (result) => result.content[0].text;
const mail = (to = "bob@example.com", extra = {}) => ({ to, subject: "Hi", body: "text", ...extra });
const ok = (result) => assert.ok(!result.isError, text(result));
const refused = (result, pattern) => { assert.equal(result.isError, true, text(result)); if (pattern) assert.match(text(result), pattern); };

test("with approval required, a covered send goes out without asking and spends one use each time, until the grant is used up", async () => {
  await withServer({ approval: "require", answer: "decline" }, async ({ call, sent, asked, grant, used, bundle, dir }) => {
    await grant({ maxUses: 2, note: "for the audit" });
    ok(await call("send_email", mail()));
    // A display name is ignored when matching, but the send paths accept bare addresses only: stopped before any use is spent.
    refused(await call("send_email", mail("Bob <BOB@example.com>")), /Invalid to email address/);
    assert.deepEqual(await used(), [1]);
    ok(await call("send_email", mail("BOB@Example.COM")));
    assert.equal(sent.length, 2);
    assert.deepEqual(asked, [], "the person was not asked");
    assert.deepEqual(await used(), [2]);

    // The third is refused by the normal gate: the person is asked, and declines.
    refused(await call("send_email", mail()), /Not approved/);
    assert.equal(asked.length, 1);
    assert.equal(sent.length, 2);
    assert.deepEqual(await used(), [2]);

    // Both uses are in the audit log and the event log.
    const audit = (await readFile(join(dir, "audit.log"), "utf8")).split("\n").filter((line) => line.includes('"delegation_use"')).map((line) => JSON.parse(line));
    assert.equal(audit.length, 2);
    assert.deepEqual(audit.map((entry) => entry.input.remainingUses), [1, 0]);
    assert.equal(audit[0].input.tool, "send_email");
    assert.deepEqual(audit[0].input.recipients, ["bob@example.com"]);
    await bundle.eventLog.flush();
    const events = (await bundle.eventLog.readAll()).filter((event) => event.type === "delegation.used");
    assert.equal(events.length, 2);
    assert.match(events[1].refId, /^g-[0-9a-f]{8}$/);
    assert.match(events[1].detail, /send_email under grant .*: 0 of 2 uses left/);
  });
});

test("the confirmation after a refused or missing grant is the usual one, whatever the mode", async () => {
  // require, client that cannot be asked: refused, a grant is what lets it through
  await withServer({ approval: "require", capability: {} }, async ({ call, sent, grant }) => {
    refused(await call("send_email", mail()), /needs the user's approval/);
    await grant();
    ok(await call("send_email", mail()));
    assert.equal(sent.length, 1);
    refused(await call("send_email", mail("eve@example.com")), /needs the user's approval/);
  });
  // elicit, person says yes: asked when no grant covers it
  await withServer({ approval: "elicit", answer: "accept" }, async ({ call, sent, asked, grant, used }) => {
    await grant({ maxUses: 1 });
    ok(await call("send_email", mail()));
    assert.equal(asked.length, 0);
    ok(await call("send_email", mail()));
    assert.equal(asked.length, 1, "the grant was used up, so the person is asked");
    assert.equal(sent.length, 2);
    assert.deepEqual(await used(), [1]);
  });
  // approval off, PROTONMAIL_CONFIRM_DESTRUCTIVE on: the handler wants confirmed: true, a grant supplies it
  await withServer({}, async ({ call, sent, grant, used }) => {
    refused(await call("send_email", mail()), /Confirmation required/);
    await grant();
    ok(await call("send_email", mail()));
    assert.equal(sent.length, 1);
    assert.deepEqual(await used(), [1]);
    // ...but a call that confirms itself does not spend a grant.
    ok(await call("send_email", mail("anyone@example.com", { confirmed: true })));
    ok(await call("send_email", mail("bob@example.com", { confirmed: true })));
    assert.equal(sent.length, 3);
    assert.deepEqual(await used(), [1]);
  });
  // nothing asks for a confirmation at all: a grant is not consulted and nothing is spent
  await withServer({ confirmDestructive: false }, async ({ call, sent, grant, used }) => {
    await grant();
    ok(await call("send_email", mail()));
    assert.equal(sent.length, 1);
    assert.deepEqual(await used(), [0]);
  });
});

test("PROTONMAIL_DELEGATION off (the default) is exactly today's behaviour, grants or not", async () => {
  for (const delegation of [undefined, "off"]) {
    await withServer({ delegation, approval: "elicit", answer: "accept" }, async ({ call, sent, asked, grant, used }) => {
      await grant();
      ok(await call("send_email", mail()));
      assert.equal(asked.length, 1, "the person is still asked");
      assert.equal(sent.length, 1);
      assert.deepEqual(await used(), [0], "and nothing is spent");
      const listed = JSON.parse(text(await call("list_grants")));
      assert.equal(listed.delegation, "off");
      assert.equal(listed.count, 1);
      assert.match(listed.note, /not applied/);
    });
    await withServer({ delegation, approval: "require", answer: "decline" }, async ({ call, sent, grant }) => {
      await grant();
      refused(await call("send_email", mail()), /Not approved/);
      assert.equal(sent.length, 0);
    });
    await withServer({ delegation }, async ({ call, grant }) => {
      await grant();
      refused(await call("send_email", mail()), /Confirmation required/);
    });
  }
});

test("a grant covers a call only when its tool is listed and EVERY To, Cc and Bcc is on it", async () => {
  await withServer({ approval: "require", answer: "decline" }, async ({ call, sent, asked, grant, used }) => {
    await grant({ tools: ["send_email"], recipients: ["bob@example.com", "@acme.org"], maxUses: 20 });
    ok(await call("send_email", mail(["bob@example.com", "x@acme.org"], { cc: "y@acme.org", bcc: ["bob@example.com"] })));
    assert.equal(sent.length, 1);
    assert.deepEqual(asked, []);

    for (const bad of [
      mail("bob@example.com", { cc: "eve@example.com" }),
      mail("bob@example.com", { bcc: "eve@example.com" }),
      mail(["bob@example.com", "eve@example.com"]),
      mail("x@sub.acme.org"),
      mail("bob+tag@example.com"),
      mail("bob@example.com.evil.example"),
      mail("bob@example.com, eve@example.com"),
      mail("bob@example.com;eve@example.com"),
      mail("bоb@example.com"),
      mail("bob@example.com", { cc: "boK@example.com" }),
    ]) {
      const before = asked.length;
      refused(await call("send_email", bad), /Not approved/);
      assert.equal(asked.length, before + 1, `the person is asked about ${JSON.stringify(bad)}`);
    }
    assert.equal(sent.length, 1);
    assert.deepEqual(await used(), [1]);

    // Another tool the grant does not list.
    refused(await call("forward_email", { emailId: DETAIL.id, to: "bob@example.com" }), /Not approved/);
    refused(await call("reply_to_email", { emailId: DETAIL.id, body: "x", cc: "bob@example.com" }), /Not approved/);
  });
});

test("an expired or revoked grant covers nothing", async () => {
  await withServer({ approval: "require", answer: "decline" }, async ({ call, sent, asked, grants, grant, used }) => {
    // made an hour ago with a life of 30 minutes
    await grants.createGrant({ tools: ["send_email"], recipients: ["bob@example.com"], maxUses: 5, expiresAt: new Date(Date.now() - HOUR / 2) }, new Date(Date.now() - HOUR));
    refused(await call("send_email", mail()), /Not approved/);
    const live = await grant({ maxUses: 5 });
    ok(await call("send_email", mail()));
    await grants.revokeGrant(live.id);
    refused(await call("send_email", mail()), /Not approved/);
    assert.equal(sent.length, 1);
    assert.equal(asked.length, 2);
    assert.deepEqual(await used(), [0, 1]);
  });
});

test("a session that read steering mail still needs the person: a grant does not stand in", async () => {
  await withServer({ approval: "require", answer: "decline" }, async ({ call, sent, asked, grant, used }) => {
    await grant({ maxUses: 5 });
    ok(await call("send_email", mail()));
    assert.deepEqual(asked, []);

    const read = JSON.parse(text(await call("get_email_by_id", { emailId: BAD_DETAIL.id })));
    assert.equal(read.risk?.level, "high", "the message was rated high risk");

    refused(await call("send_email", mail()), /Not approved/);
    assert.equal(asked.length, 1, "the person is asked although a grant covers it");
    assert.equal(sent.length, 1);
    assert.deepEqual(await used(), [1], "nothing more was spent");
  });
  await withServer({ approval: "require", answer: "accept" }, async ({ call, sent, asked, grant, used }) => {
    await grant({ maxUses: 5 });
    await call("get_email_by_id", { emailId: BAD_DETAIL.id });
    ok(await call("send_email", mail()));
    assert.equal(asked.length, 1, "the person said yes themselves");
    assert.equal(sent.length, 1);
    assert.deepEqual(await used(), [0], "and the grant was not spent");
  });
  // With nobody to ask (approval off) the taint gate is what it always was; a grant does not skip it.
  await withServer({}, async ({ call, sent, grant, used }) => {
    await grant({ maxUses: 5 });
    await call("get_email_by_id", { emailId: BAD_DETAIL.id });
    refused(await call("send_email", mail()), /looks like an attempt to steer an AI/);
    assert.equal(sent.length, 0);
    assert.deepEqual(await used(), [0]);
  });
});

test("a grant never overrides read-only mode, the send switch or the outbound allow-list, and nothing is spent when they stop the send", async () => {
  for (const [options, pattern] of [
    [{ readOnly: true, allowSend: false }, /disabled by the current runtime policy/],
    [{ allowSend: false }, /disabled by the current runtime policy/],
    [{ restrictOutboundToSelf: true }, /RESTRICT_OUTBOUND_TO_SELF/],
  ]) {
    await withServer({ approval: "require", ...options }, async ({ call, sent, grant, used }) => {
      await grant({ maxUses: 5 });
      refused(await call("send_email", mail()), pattern);
      assert.equal(sent.length, 0);
      assert.deepEqual(await used(), [0], JSON.stringify(options));
    });
  }
});

test("a grant never covers anything but the six sending tools, and does not widen PROTONMAIL_ALLOWED_ACTIONS", async () => {
  await withServer({ approval: "require", answer: "decline", allowedActions: [] }, async ({ call, asked, grants, grant, used, dir }) => {
    await grant({ tools: ["send_email"], recipients: ["bob@example.com", "@example.com"], maxUses: 50 });
    // A grant file that was edited to cover more is read back with only the sending tools in it.
    const file = join(dir, "grants.json");
    const stored = JSON.parse(await readFile(file, "utf8"));
    stored.grants[0].tools = ["send_email", "delete_email", "approve_plan", "set_rule", "set_autoresponder", "unsubscribe_sender", "empty_folder", "trash_email"];
    await writeFile(file, JSON.stringify(stored));
    assert.deepEqual((await grants.list())[0].tools, ["send_email"]);

    for (const [name, args] of [
      ["delete_email", { emailId: DETAIL.id }],
      ["empty_folder", { folder: "Trash" }],
      ["set_rule", { name: "fwd", when: { from: ["a@example.com"] }, actions: { forwardTo: ["bob@example.com"] } }],
      ["set_autoresponder", { enabled: true, body: "away" }],
      ["approve_plan", { planId: "p-1" }],
      ["unsubscribe_sender", { emailId: DETAIL.id }],
      ["send_test_email", { to: "bob@example.com" }],
      ["respond_to_invite", { emailId: DETAIL.id, response: "accept" }],
    ]) {
      const before = asked.length;
      const result = await call(name, args);
      assert.equal(result.isError, true, `${name}: ${text(result)}`);
      assert.equal(asked.length, before + 1, `${name} still asks the person`);
    }
    // trash is a mailbox action the list leaves out: still refused by the allowed-actions policy.
    refused(await call("trash_email", { emailId: DETAIL.id }), /disabled by the current runtime policy/);
    assert.deepEqual(await used(), [0]);
  });
});

test("every grantable tool is covered through its own gate, and the claim sees the same recipients as the gate", async () => {
  await withServer({ approval: "require", answer: "decline" }, async ({ call, sent, asked, grants, grant, used }) => {
    await grant({
      tools: ["send_email", "reply_to_email", "reply_all_email", "forward_email", "send_draft", "schedule_draft"],
      recipients: ["bob@example.com", "ann@example.com", "carol@example.com", "dan@example.com"],
      maxUses: 50,
    });
    ok(await call("send_email", mail()));
    ok(await call("reply_to_email", { emailId: DETAIL.id, body: "thanks" }));
    ok(await call("reply_to_email", { emailId: DETAIL.id, body: "thanks", replyAll: true }));
    ok(await call("reply_all_email", { emailId: DETAIL.id, body: "thanks", bcc: "bob@example.com" }));
    ok(await call("forward_email", { emailId: DETAIL.id, to: "bob@example.com", cc: "ann@example.com" }));
    const draft = JSON.parse(text(await call("create_draft", { to: "bob@example.com", subject: "d", body: "b" })));
    ok(await call("send_draft", { draftId: draft.id ?? draft.draft?.id }));
    const second = JSON.parse(text(await call("create_draft", { to: "carol@example.com", subject: "d2", body: "b" })));
    ok(await call("schedule_draft", { draftId: second.id ?? second.draft?.id, sendAt: new Date(Date.now() + 2 * HOUR).toISOString() }));
    assert.deepEqual(asked, [], "nobody was asked");
    assert.equal(sent.length, 6, "the scheduled one is queued, not sent");
    assert.deepEqual(await used(), [7]);

    // The reply-all fan-out reaches carol and dan; take one off the grant and the whole call falls back to the person.
    const narrow = (await grants.list())[0];
    await grants.revokeGrant(narrow.id);
    await grant({ tools: ["reply_all_email", "reply_to_email"], recipients: ["ann@example.com", "dan@example.com"], maxUses: 5 });
    refused(await call("reply_all_email", { emailId: DETAIL.id, body: "x" }), /Not approved/);
    ok(await call("reply_to_email", { emailId: DETAIL.id, body: "x" }));
    refused(await call("reply_to_email", { emailId: DETAIL.id, body: "x", bcc: "eve@example.com" }), /Not approved/);
    assert.equal(asked.length, 2);
  });
});

test("a send with an undo window spends its use when it is queued, and a dry run spends none", async () => {
  await withServer({ approval: "require", sendDelaySeconds: 60 }, async ({ call, sent, asked, grant, used, bundle }) => {
    await grant({ maxUses: 3 });
    const queued = JSON.parse(text(await call("send_email", mail())));
    assert.equal(queued.queued, true);
    assert.equal(sent.length, 0);
    assert.equal((await bundle.deliveryQueueService.list()).length, 1);
    assert.deepEqual(await used(), [1]);
    const preview = JSON.parse(text(await call("send_email", mail("bob@example.com", { dryRun: true }))));
    assert.equal(preview.dryRun, true);
    assert.deepEqual(await used(), [1]);
    assert.deepEqual(asked, []);
  });
});

test("a draft changed between the gate and the send is not sent on a grant that no longer covers it", async () => {
  await withServer({ approval: "require", answer: "decline" }, async ({ call, sent, asked, grant, used, bundle }) => {
    await grant({ tools: ["send_draft", "schedule_draft"], recipients: ["bob@example.com"], maxUses: 5 });
    const created = JSON.parse(text(await call("create_draft", { to: "bob@example.com", subject: "d", body: "b" })));
    const draftId = created.id ?? created.draft?.id;
    const original = await bundle.draftStore.getDraft(draftId);
    let reads = 0;
    const real = bundle.draftStore.getDraft.bind(bundle.draftStore);
    // The first read is the gate's; by the second (the handler's) somebody has put another recipient on the draft.
    bundle.draftStore.getDraft = async (id) => {
      reads += 1;
      const draft = await real(id);
      return reads === 1 ? draft : { ...draft, to: [...original.to, "eve@example.com"] };
    };
    const result = await call("send_draft", { draftId });
    refused(result, /no delegation grant covers it any more/);
    assert.equal(sent.length, 0, "nothing was sent");
    assert.deepEqual(await used(), [0], "and nothing was spent");
    assert.deepEqual(asked, []);
    bundle.draftStore.getDraft = real;
    assert.equal((await real(draftId)).status, "draft", "the draft was not locked as sending");
  });
});

test("a session tainted after the gate but before the send is stopped at the claim", async () => {
  await withServer({ approval: "require", answer: "decline" }, async ({ call, sent, grant, used, bundle }) => {
    await grant({ tools: ["send_draft"], recipients: ["bob@example.com"], maxUses: 5 });
    const created = JSON.parse(text(await call("create_draft", { to: "bob@example.com", subject: "d", body: "b" })));
    const draftId = created.id ?? created.draft?.id;
    let reads = 0;
    const real = bundle.draftStore.getDraft.bind(bundle.draftStore);
    // Between the gate's read of the draft and the handler's, another call reads a message that tries to steer the AI.
    bundle.draftStore.getDraft = async (id) => {
      reads += 1;
      if (reads === 2) await call("get_email_by_id", { emailId: BAD_DETAIL.id });
      return real(id);
    };
    refused(await call("send_draft", { draftId }), /looks like an attempt to steer an AI/);
    assert.equal(sent.length, 0);
    assert.deepEqual(await used(), [0]);
  });
});

test("two calls racing for the last use: one goes out, the other falls back to the person", async () => {
  await withServer({ approval: "require", answer: "decline" }, async ({ call, sent, asked, grant, used }) => {
    await grant({ maxUses: 1 });
    const results = await Promise.all([call("send_email", mail()), call("send_email", mail()), call("send_email", mail())]);
    assert.equal(results.filter((result) => !result.isError).length, 1);
    assert.equal(sent.length, 1);
    assert.deepEqual(await used(), [1]);
    assert.ok(asked.length <= 2);
  });
});

test("list_grants shows what is in force and nothing secret, and cannot be asked to change anything", async () => {
  await withServer({ approval: "require" }, async ({ call, grants, grant }) => {
    assert.deepEqual(JSON.parse(text(await call("list_grants"))), { delegation: "on", count: 0, grants: [] });
    const used = await grant({ maxUses: 4, note: "board pack", tools: ["send_email", "forward_email"], recipients: ["bob@example.com", "@acme.org"] });
    const revoked = await grant();
    await grants.revokeGrant(revoked.id);
    await grants.createGrant({ tools: ["send_email"], recipients: ["old@example.com"], maxUses: 1, expiresAt: new Date(Date.now() - 1000) }, new Date(Date.now() - HOUR));
    ok(await call("send_email", mail()));
    const listed = JSON.parse(text(await call("list_grants")));
    assert.equal(listed.count, 1, "revoked and expired grants are not listed");
    assert.deepEqual(listed.grants, [{
      id: used.id, account: ADDRESS, note: "board pack", tools: ["send_email", "forward_email"], recipients: ["bob@example.com", "@acme.org"],
      remainingUses: 3, maxUses: 4, expiresAt: used.expiresAt,
    }]);
    assert.doesNotMatch(text(await call("list_grants")), /password|token|secret/i);
    // Extra arguments do nothing: there is nothing to create or revoke through it.
    const attempt = await call("list_grants", { create: { tools: ["send_email"], recipients: ["eve@example.com"] }, revoke: used.id, tools: ["send_email"] });
    assert.equal(JSON.parse(text(attempt)).count, 1);
    assert.equal((await grants.list()).length, 3);
    assert.equal(JSON.parse(text(await call("list_grants", { account: ADDRESS }))).count, 1);
    refused(await call("list_grants", { account: "nobody@example.com" }), /Unknown account/);
  });
});

test("get_runtime_status reports the delegation setting", async () => {
  for (const [delegation, expected] of [[undefined, "off"], ["on", "on"]]) {
    await withServer({ delegation }, async ({ call }) => {
      assert.equal(JSON.parse(text(await call("get_runtime_status"))).runtime.delegation, expected);
    });
  }
});

test("a forward grant covers only a message of the account it was made for, whichever address the forward goes out as", async () => {
  await withServer({ approval: "require", answer: "decline", secondAccount: true }, async ({ call, sent, asked, grants, grant, used, dir }) => {
    await grant({ tools: ["forward_email"], recipients: ["bob@example.com"], maxUses: 10 });
    const secondGrants = new GrantService({ dataDir: join(dir, "second"), smtp: { username: SECOND } }, SECOND);
    const mine = DETAIL.id;
    const theirs = `second-example-com::${DETAIL.id}`;

    // A message of the primary account, forwarded as the primary account: covered.
    ok(await call("forward_email", { emailId: mine, to: "bob@example.com" }));
    assert.deepEqual([sent.length, asked.length], [1, 0]);

    // A message of the second account, forwarded as the primary account (the grant's own address): the grant does not
    // reach into another account's mail, so the person is asked (and declines), and no use is spent.
    refused(await call("forward_email", { emailId: theirs, from: ADDRESS, to: "bob@example.com" }), /Not approved/);
    assert.deepEqual([sent.length, asked.length, await used()], [1, 1, [1]]);

    // The same message forwarded as the second account needs a grant of the second account, which does not exist yet.
    refused(await call("forward_email", { emailId: theirs, to: "bob@example.com" }), /Not approved/);
    // And the primary account's message forwarded as the second account is not covered by the second account's grant either.
    await secondGrants.createGrant({ tools: ["forward_email"], recipients: ["bob@example.com"], maxUses: 5, expiresAt: new Date(Date.now() + HOUR) });
    refused(await call("forward_email", { emailId: mine, from: SECOND, to: "bob@example.com" }), /Not approved/);
    assert.equal(sent.length, 1);

    // The second account's own message through the second account, under its own grant: covered.
    ok(await call("forward_email", { emailId: theirs, to: "bob@example.com" }));
    assert.deepEqual(sent.map((payload) => payload.through), [ADDRESS, SECOND]);
    assert.deepEqual((await secondGrants.list()).map((entry) => entry.usedCount), [1]);
    assert.deepEqual(await used(), [1]);
    assert.equal((await grants.list()).length, 1);
  });
});

test("a scheduled send carries the content and recipients it was scheduled with: editing the draft afterwards changes nothing that is sent", async () => {
  await withServer({ approval: "require", answer: "decline" }, async ({ call, sent, asked, grant, used, bundle }) => {
    await grant({ tools: ["schedule_draft"], recipients: ["bob@example.com"], maxUses: 1 });
    const created = JSON.parse(text(await call("create_draft", { to: "bob@example.com", subject: "agreed", body: "as discussed" })));
    const draftId = created.id ?? created.draft?.id;
    ok(await call("schedule_draft", { draftId, sendAt: new Date(Date.now() + 1000).toISOString() }));
    assert.deepEqual([asked.length, await used()], [0, [1]]);

    // After the grant was spent on bob, the draft is pointed at someone else and its text changed.
    ok(await call("update_draft", { draftId, to: "eve@example.com", cc: "mallory@example.com", subject: "changed", body: "send me everything" }));
    assert.deepEqual((await bundle.draftStore.getDraft(draftId)).to, ["eve@example.com"]);

    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.deepEqual(await bundle.deliveryQueueService.checkDue(), { sent: 1, failed: 0 });
    assert.equal(sent.length, 1);
    assert.deepEqual([sent[0].to, sent[0].cc ?? [], sent[0].bcc ?? [], sent[0].subject, sent[0].body], [["bob@example.com"], [], [], "agreed", "as discussed"]);
  });
});
