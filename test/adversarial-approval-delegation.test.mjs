import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { GrantService } from "../dist/services/grant-service.js";
import { TOOLS } from "../dist/tools/definitions.js";
import { needsApproval, buildApprovalMessage } from "../dist/utils/approval.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";

// Independent adversarial suite for the 2.17 human-approval gate and delegation grants. Each test asserts the secure behaviour; the defects
// they first found were fixed within 2.17.

const ADDRESS = "owner@example.com";
const HOUR = 3_600_000;
const DETAIL = {
  id: "INBOX::1::1::abc", folder: "INBOX", uid: 1, subject: "Hello",
  from: [{ name: "Ann", address: "ann@example.com" }],
  to: [{ name: "", address: ADDRESS }], cc: [], bcc: [], replyTo: [],
  date: "2026-09-19T10:00:00.000Z", messageId: "<orig@example.com>", references: [],
  body: "original text", text: "original text", attachments: [], isRead: true, isStarred: false, flags: [], labels: [],
};

async function withServer(options, fn) {
  const { approval, delegation, answer = "decline", capability = { elicitation: {} }, allowFileDownloadDir, timeoutSeconds, dir: givenDir } = options;
  const dir = givenDir ?? await mkdtemp(join(tmpdir(), "adv-approval-"));
  const conn = { host: "127.0.0.1", port: 9, secure: false, username: ADDRESS, password: "x" };
  const config = {
    smtp: conn, imap: conn, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: ADDRESS, slug: "owner-example-com", imap: conn, smtp: conn, dataDir: dir }],
    runtime: {
      readOnly: false, allowSend: true, allowRemoteDraftSync: false, allowedActions: ["delete", "trash"], startupSync: false, autoSyncFolder: "INBOX",
      autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: true, allowEmptyFolder: true,
      restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0,
      ...(delegation ? { delegation } : {}), ...(approval ? { approval } : {}), ...(allowFileDownloadDir ? { allowFileDownloadDir } : {}),
      ...(timeoutSeconds ? { approvalTimeoutSeconds: timeoutSeconds } : {}),
    },
  };
  const { server, accountManager } = createServer(config, { startBackgroundSync: false });
  const bundle = accountManager.primary();
  const sent = [];
  bundle.smtpService.sendEmail = async (payload) => { sent.push(payload); return { messageId: "<sent@example.com>", accepted: payload.to, rejected: [], response: "250" }; };
  bundle.imapService.getEmailById = async () => ({ ...DETAIL });
  const client = new Client({ name: "t", version: "0" }, { capabilities: capability });
  const asked = [];
  if (capability.elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      asked.push(request.params.message);
      return typeof answer === "function" ? answer(request, { client, asked }) : { action: answer };
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const grants = new GrantService({ dataDir: dir, smtp: { username: ADDRESS } }, ADDRESS);
  const grant = (extra = {}) => grants.createGrant({ tools: ["send_email"], recipients: ["bob@example.com"], maxUses: 2, expiresAt: new Date(Date.now() + HOUR), ...extra });
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  try {
    await fn({ call, sent, asked, grants, grant, bundle, dir, client });
  } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    if (!givenDir) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const HIDDEN = new RegExp("[\\u0000-\\u0009\\u000b-\\u001f\\u007f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\u200b]", "u");
const text = (r) => r.content[0].text;
const mail = (to = "bob@example.com", extra = {}) => ({ to, subject: "Hi", body: "text", ...extra });

// ---------------------------------------------------------------- (1) approval

test("approval: every spelling of confirmed from the model is dropped; a declining human wins", async () => {
  const spellings = [
    { confirmed: true }, { confirmed: "true" }, { confirmed: 1 }, { confirmed: "yes" }, { Confirmed: true }, { CONFIRMED: true },
    { confirm: true }, { args: { confirmed: true } }, { arguments: { confirmed: true } }, { "confirmed ": true }, { __proto__: { confirmed: true } },
    JSON.parse('{"__proto__":{"confirmed":true}}'), JSON.parse('{"constructor":{"prototype":{"confirmed":true}}}'),
  ];
  await withServer({ approval: "require", answer: "decline" }, async ({ call, sent, asked }) => {
    for (const extra of spellings) {
      const result = await call("send_email", { ...mail("anyone@example.com"), ...extra });
      assert.equal(result.isError, true, JSON.stringify(extra));
      assert.match(text(result), /Not approved/, JSON.stringify(extra));
    }
    assert.equal(sent.length, 0);
    assert.equal(asked.length, spellings.length);
  });
});

test("approval: every tool that declares confirmed (and every taint-gated tool) is covered by the approval set", () => {
  const names = TOOLS.filter((t) => Object.hasOwn(t.inputSchema?.properties ?? {}, "confirmed")).map((t) => t.name);
  const uncovered = names.filter((name) => {
    const declared = new Set(Object.keys(TOOLS.find((t) => t.name === name).inputSchema.properties));
    const args = { dryRun: false, enabled: true, actions: { forwardTo: ["x@y.example"] }, flagsToAdd: ["\\Deleted"], action: "delete", permanent: true };
    return !needsApproval(name, args, declared);
  });
  assert.deepEqual(uncovered, []);
});

// DEFECT: apply_rules reads dryRun with normalizeBoolean ("false", "no", "off", 0 all mean a real run) but the approval/taint
// gate compares with `=== false`, so a model that sends dryRun: "false" runs the rules for real with no human question.
test("approval: apply_rules with dryRun spelled as a string or number still asks the person", async () => {
  for (const dryRun of [false, "false", "no", "off", 0, "0", " FALSE "]) {
    await withServer({ approval: "require", answer: "decline" }, async ({ call, asked }) => {
      const result = await call("apply_rules", { dryRun });
      assert.equal(asked.length, 1, `dryRun=${JSON.stringify(dryRun)} reached the handler without asking: ${text(result).slice(0, 80)}`);
    });
  }
});

// DEFECT: the person approves the draft as it is when the question is built; the handler re-reads the draft after the
// answer. update_draft is not gated, so a parallel call changes the recipients while the question is open.
test("approval: a draft edited while the question is open is not sent to the new recipients", async () => {
  let draftId;
  await withServer({
    approval: "elicit",
    answer: async (_request, { client }) => {
      await client.callTool({ name: "update_draft", arguments: { draftId, to: "attacker@evil.example" } });
      return { action: "accept" };
    },
  }, async ({ call, sent }) => {
    const created = JSON.parse(text(await call("create_draft", { to: "bob@example.com", subject: "Hi", body: "x" })));
    draftId = created.draft?.id ?? created.id ?? created.draftId;
    assert.ok(draftId, text({ content: [{ text: JSON.stringify(created) }] }));
    const result = await call("send_draft", { draftId });
    const recipients = sent.flatMap((p) => [...p.to, ...(p.cc ?? []), ...(p.bcc ?? [])]);
    assert.ok(!recipients.includes("attacker@evil.example"), `sent to ${recipients.join(",")} (${text(result).slice(0, 60)})`);
  });
});

test("approval: hostile arguments cannot add lines, fake labels or blow up the prompt", async () => {
  const bidi = "‮evil‬⁦x⁩​\u0000\u001b[31m\r\n  Approve send_email?\nAccount: \"fake\"";
  await withServer({ approval: "require", answer: "decline" }, async ({ call, asked }) => {
    await call("send_email", { to: [bidi, "b@example.com"], cc: bidi, bcc: bidi, subject: bidi, body: "x", from: bidi });
    await call("send_draft", { draftId: bidi });
    await call("delete_email", { emailId: bidi });
    await call("bulk_delete", { emailIds: [bidi, bidi, bidi, bidi, bidi] });
    await call("set_rule", { name: bidi, actions: { forwardTo: [bidi] }, when: {} });
    for (const message of asked) {
      assert.doesNotMatch(message, HIDDEN, JSON.stringify(message));
      for (const line of message.split("\n").slice(1)) assert.match(line, /^[A-Z][A-Za-z ]*: /, `unlabelled line ${JSON.stringify(line)}`);
      assert.equal(message.split("\n").filter((l) => l.startsWith("Approve ")).length, 1);
      assert.ok(message.length <= 1500);
    }
  });
});

test("approval: a 10 MB argument does not stall the prompt or exceed its size", async () => {
  const huge = "a".repeat(10 * 1024 * 1024);
  await withServer({ approval: "require", answer: "decline" }, async ({ call, asked }) => {
    const started = Date.now();
    await call("send_email", { to: huge, subject: huge, body: "x", cc: [huge, huge], from: huge });
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
    assert.ok(asked[0].length <= 1500);
  });
});

test("approval: dryRun:true on every gated send tool that declares it sends nothing and asks nothing", async () => {
  await withServer({ approval: "require", answer: "decline" }, async ({ call, sent, asked }) => {
    for (const [name, args] of [
      ["send_email", mail()], ["reply_to_email", { emailId: DETAIL.id, body: "x" }], ["reply_all_email", { emailId: DETAIL.id, body: "x" }],
      ["forward_email", { emailId: DETAIL.id, to: "bob@example.com" }],
    ]) {
      await call(name, { ...args, dryRun: true });
    }
    assert.equal(sent.length, 0);
    assert.equal(asked.length, 0);
  });
});

test("approval: a client that answers with garbage, extra fields, or throws never lets the call through", async () => {
  const answers = [undefined, null, 5, "accept", {}, { action: "ACCEPT" }, { action: ["accept"] }, { action: "accept ", content: {} }, { content: { confirmed: true } }];
  for (const garbage of answers) {
    await withServer({ approval: "require", answer: () => garbage }, async ({ call, sent }) => {
      const result = await call("send_email", mail());
      assert.equal(result.isError, true, JSON.stringify(garbage));
      assert.equal(sent.length, 0, JSON.stringify(garbage));
    });
  }
  await withServer({ approval: "require", answer: () => { throw new Error("boom"); } }, async ({ call, sent }) => {
    assert.equal((await call("send_email", mail())).isError, true);
    assert.equal(sent.length, 0);
  });
  // accept with extra fields is an accept
  await withServer({ approval: "require", answer: () => ({ action: "accept", content: { anything: 1 }, _meta: {} }) }, async ({ call, sent }) => {
    assert.ok(!(await call("send_email", mail())).isError);
    assert.equal(sent.length, 1);
  });
});

test("approval: a client that never answers is a refusal, not a hang or a pass", async () => {
  await withServer({ approval: "require", timeoutSeconds: 0.3, answer: () => new Promise(() => {}) }, async ({ call, sent }) => {
    const result = await call("send_email", mail());
    assert.equal(result.isError, true);
    assert.match(text(result), /did not answer/);
    assert.equal(sent.length, 0);
  });
});

test("approval: two gated calls at once are each decided by their own answer", async () => {
  await withServer({
    approval: "require",
    answer: async (request) => {
      const msg = request.params.message;
      await new Promise((r) => setTimeout(r, msg.includes("first@") ? 150 : 10));
      return { action: msg.includes("first@") ? "decline" : "accept" };
    },
  }, async ({ call, sent }) => {
    const [first, second] = await Promise.all([call("send_email", mail("first@example.com")), call("send_email", mail("second@example.com"))]);
    assert.equal(first.isError, true);
    assert.ok(!second.isError, text(second));
    assert.deepEqual(sent.map((p) => p.to), [["second@example.com"]]);
  });
});

test("approval: mode elicit on a client that cannot ask falls back to the model's confirmed (documented), require refuses", async () => {
  await withServer({ approval: "require", capability: {} }, async ({ call, sent }) => {
    assert.equal((await call("send_email", { ...mail(), confirmed: true })).isError, true);
    assert.equal(sent.length, 0);
  });
});

// ---------------------------------------------------------------- (2) delegation

test("delegation: 30 parallel sends against a 2-use grant, over two servers sharing one data directory, send exactly 2", async () => {
  const dir = await mkdtemp(join(tmpdir(), "adv-deleg-"));
  try {
    await withServer({ dir, approval: "require", delegation: "on", answer: "decline" }, async (one) => {
      await one.grant({ maxUses: 2 });
      await withServer({ dir, approval: "require", delegation: "on", answer: "decline" }, async (two) => {
        const results = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? one : two).call("send_email", mail("bob@example.com", { subject: `n${i}` }))));
        const ok = results.filter((r) => !r.isError).length;
        assert.equal(ok, 2);
        assert.equal(one.sent.length + two.sent.length, 2);
        assert.equal((await one.grants.list())[0].usedCount, 2);
      });
    });
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("delegation: recipients that try to dodge matching are refused and spend nothing", async () => {
  await withServer({ approval: "require", delegation: "on", answer: "decline" }, async ({ call, sent, grant, grants }) => {
    await grant({ recipients: ["bob@example.com", "@corp.example"], maxUses: 50 });
    const tricky = [
      "bob@example.com.", "bob@example.com\u0000", "bob@example.com‮", "bob@example.com evil@x.example", "evil@x.example,bob@example.com",
      "bob@sub.corp.example", "bob@corp.example.evil.example", "bob@xn--corp-example", "BOB@EXAMPLE.COM, evil@x.example", "bob+x@example.com",
      "bob@example.com(evil@x.example)", "\"evil@x.example\"@corp.example", "bob@Korp.example", "bob@example.com​", "bob@examрle.com",
      "<bob@example.com>, <evil@x.example>", "evil@x.example <bob@example.com>, evil2@x.example",
    ];
    for (const to of tricky) {
      const before = sent.length;
      const result = await call("send_email", mail(to));
      assert.ok(result.isError || sent.length === before || sent.at(-1).to.every((a) => /^(bob@example\.com|[^@]+@corp\.example)$/i.test(a.replace(/^.*<|>$/g, ""))), `${JSON.stringify(to)} went out as ${JSON.stringify(sent.at(-1))}`);
      assert.equal(result.isError, true, `${JSON.stringify(to)}: ${text(result).slice(0, 80)}`);
    }
    for (const [cc, bcc] of [["evil@x.example", undefined], [undefined, "evil@x.example"], [["evil@x.example"], ["bob@example.com"]]]) {
      assert.equal((await call("send_email", { ...mail(), cc, bcc })).isError, true);
    }
    assert.equal(sent.length, 0);
    assert.equal((await grants.list())[0].usedCount, 0);
  });
});

test("delegation: a hand-edited grants.json cannot widen what the CLI would have allowed", async () => {
  await withServer({ approval: "require", delegation: "on", answer: "decline" }, async ({ call, sent, dir, grants }) => {
    const future = new Date(Date.now() + HOUR).toISOString();
    const base = { id: "g-aaaaaaaa", note: "", account: ADDRESS, tools: ["send_email"], recipients: ["bob@example.com"], maxUses: 2, expiresAt: future, usedCount: 0, createdAt: future, revoked: false };
    const bad = [
      { ...base, maxUses: 1e308 }, { ...base, maxUses: "5" }, { ...base, maxUses: 51 }, { ...base, usedCount: -5 }, { ...base, usedCount: "0" },
      { ...base, usedCount: null }, { ...base, revoked: undefined }, { ...base, revoked: "false" }, { ...base, expiresAt: "garbage" },
      { ...base, tools: "send_email" }, { ...base, tools: ["send_email", "delete_email"], recipients: ["*"] }, { ...base, recipients: ["*@example.com"] },
      { ...base, recipients: ["@"] }, { ...base, recipients: ["@com"] }, { ...base, account: "other@example.com" }, { ...base, id: "g-AAAAAAAA" },
      JSON.parse('{"id":"g-bbbbbbbb","__proto__":{"revoked":false}}'),
    ];
    for (const grant of bad) {
      await writeFile(join(dir, "grants.json"), JSON.stringify({ version: 1, grants: [grant] }));
      const result = await call("send_email", mail("bob@example.com"));
      if (!result.isError) assert.fail(`accepted hand-edited grant ${JSON.stringify(grant)}`);
    }
    assert.equal(sent.length, 0);
  });
});

test("delegation: a stale-clock expiry (expired a millisecond ago, or exactly now) is never honoured", async () => {
  await withServer({ approval: "require", delegation: "on", answer: "decline" }, async ({ call, sent, grants, dir }) => {
    const base = { id: "g-aaaaaaaa", note: "", account: ADDRESS, tools: ["send_email"], recipients: ["bob@example.com"], maxUses: 2, usedCount: 0, createdAt: new Date().toISOString(), revoked: false };
    for (const expiresAt of [new Date(Date.now() - 1), new Date(), new Date(0)]) {
      await writeFile(join(dir, "grants.json"), JSON.stringify({ version: 1, grants: [{ ...base, expiresAt: expiresAt.toISOString() }] }));
      assert.equal((await call("send_email", mail())).isError, true);
    }
    assert.equal(sent.length, 0);
    assert.equal((await grants.list())[0].usedCount, 0);
  });
});

test("delegation: no tool or resource creates, changes or revokes a grant, and nothing but list_grants mentions grants", async () => {
  const mentioning = TOOLS.filter((t) => /grant/i.test(t.name)).map((t) => t.name);
  assert.deepEqual(mentioning, ["list_grants"]);
  await withServer({ approval: "require", delegation: "on", answer: "decline" }, async ({ client, grant, grants }) => {
    await grant();
    const before = JSON.stringify(await grants.list());
    for (const name of ["list_grants"]) {
      await client.callTool({ name, arguments: { create: true, revoke: "g-aaaaaaaa", grant: { tools: ["send_email"] }, maxUses: 50, recipients: ["@evil.example"] } });
    }
    assert.equal(JSON.stringify(await grants.list()), before);
    const resources = await client.listResources();
    assert.ok(!resources.resources.some((r) => /grant/i.test(r.uri)), "a grants resource exists");
    for (const r of resources.resources) {
      const content = await client.readResource({ uri: r.uri }).catch(() => undefined);
      if (content) assert.doesNotMatch(JSON.stringify(content), /g-[0-9a-f]{8}/);
    }
  });
});

test("delegation: a grant covers a draft only as it is when sent; a draft edited after approval but before the claim is stopped", async () => {
  await withServer({ approval: "require", delegation: "on", answer: "decline" }, async ({ call, sent, grant, grants }) => {
    await grant({ tools: ["send_draft", "schedule_draft"] });
    const created = JSON.parse(text(await call("create_draft", { to: "bob@example.com", subject: "s", body: "b" })));
    const draftId = created.draft?.id ?? created.id ?? created.draftId;
    await call("update_draft", { draftId, to: "bob@example.com", bcc: "evil@x.example" });
    assert.equal((await call("send_draft", { draftId })).isError, true);
    assert.equal((await call("schedule_draft", { draftId, sendAt: new Date(Date.now() + HOUR).toISOString() })).isError, true);
    assert.equal(sent.length, 0);
    assert.equal((await grants.list())[0].usedCount, 0);
  });
});

// DEFECT (conditional): save_attachment's outputPath is model controlled; when PROTONMAIL_ALLOW_FILE_DOWNLOAD_DIR is an
// ancestor of the data directory (e.g. $HOME) a mail attachment can be written over grants.json, minting a grant.
test("delegation: an attachment cannot be written over grants.json (download dir that contains the data dir)", async () => {
  const root = await mkdtemp(join(tmpdir(), "adv-dl-"));
  const dir = join(root, "data");
  await mkdir(dir, { recursive: true });
  try {
    await withServer({ dir, approval: "require", delegation: "on", answer: "decline", allowFileDownloadDir: root }, async ({ call, bundle, sent }) => {
      const forged = JSON.stringify({ version: 1, grants: [{ id: "g-deadbeef", note: "x", account: ADDRESS, tools: ["send_email"], recipients: ["@evil.example"], maxUses: 50, expiresAt: new Date(Date.now() + HOUR).toISOString(), usedCount: 0, createdAt: new Date().toISOString(), revoked: false }] });
      bundle.imapService.getParsedAttachment = async () => ({ id: "a1", filename: "grants.json", content: Buffer.from(forged), contentType: "application/json", size: forged.length });
      await call("save_attachment", { emailId: DETAIL.id, attachmentId: "a1", outputPath: join(dir, "grants.json") });
      const result = await call("send_email", mail("anyone@evil.example"));
      assert.equal(sent.length, 0, "a forged grant spent: mail went out without a human");
      assert.equal(result.isError, true);
    });
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

// DEFECT: the question for a reply names the message but not who the reply will go to. The sender of that message controls
// Reply-To, so "Replying to <subject>" can send the answer (and the quoted original) to an address the person never saw.
test("approval: the question for a reply shows the address the reply will really go to", async () => {
  await withServer({ approval: "require", answer: "decline" }, async ({ call, bundle, asked }) => {
    bundle.imapService.getEmailById = async () => ({ ...DETAIL, replyTo: [{ name: "", address: "collector@evil.example" }] });
    await call("reply_to_email", { emailId: DETAIL.id, body: "x" });
    await call("reply_all_email", { emailId: DETAIL.id, body: "x" });
    for (const message of asked) assert.match(message, /collector@evil\.example/, message);
  });
});

// DEFECT (low): set_contact / import_contacts need approval but fall into the "flags" branch of the prompt, which names
// neither the contact nor what changes (a vip tag changes the autoresponder text for that sender).
test("approval: the question for set_contact / import_contacts says what is being changed", async () => {
  await withServer({ approval: "require", answer: "decline" }, async ({ call, asked }) => {
    await call("set_contact", { address: "victim@example.com", addTags: ["vip"] });
    await call("import_contacts", { vcard: "BEGIN:VCARD\nFN:A\nEMAIL:a@example.com\nEND:VCARD" });
    assert.equal(asked.length, 2);
    for (const message of asked) assert.match(message, /victim@example\.com|a@example\.com|vcard|contact/i, message);
  });
});

// DEFECT (low): readStoredGrant does not apply MAX_GRANT_DAYS, so a hand-edited (or forged) expiresAt of year 9999 is honoured.
test("delegation: a stored grant that outlasts the 30-day limit is not honoured", async () => {
  await withServer({ approval: "require", delegation: "on", answer: "decline" }, async ({ call, sent, dir }) => {
    const base = { id: "g-aaaaaaaa", note: "", account: ADDRESS, tools: ["send_email"], recipients: ["bob@example.com"], maxUses: 2, usedCount: 0, createdAt: new Date().toISOString(), revoked: false };
    await writeFile(join(dir, "grants.json"), JSON.stringify({ version: 1, grants: [{ ...base, expiresAt: "9999-12-31T00:00:00.000Z" }] }));
    assert.equal((await call("send_email", mail())).isError, true);
    assert.equal(sent.length, 0);
  });
});
