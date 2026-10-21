import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { AccountManager } from "../dist/services/account-manager.js";
import { createToolContext } from "../dist/tools/context.js";
import { handleRuleTool } from "../dist/tools/rules.js";
import { slugifyAccountAddress } from "../dist/utils/helpers.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";
import { createMessage, makeCertificate, startFakeBridge } from "./helpers/fake-bridge.mjs";

const certificate = makeCertificate();
const needsOpenssl = certificate ? {} : { skip: "openssl is not available to make a test certificate" };
const ADDRESS = "owner@example.com";

function configFor(dir, port, runtimeOverrides = {}) {
  const imap = { host: "127.0.0.1", port, secure: false, username: ADDRESS, password: "secret" };
  const smtp = { host: "127.0.0.1", port: 9, secure: false, username: ADDRESS, password: "secret" };
  return {
    smtp, imap, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: true, syncInterval: 5,
    accounts: [{ address: ADDRESS, slug: slugifyAccountAddress(ADDRESS), imap, smtp, dataDir: dir }],
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: ["mark_read", "archive", "move", "trash", "delete"], startupSync: false, autoSyncFolder: "INBOX",
      autoSyncFull: false, autoSyncLimitPerFolder: 50, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: true,
      allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0, ...runtimeOverrides },
  };
}

const soon = (offset = 0) => new Date(Date.now() + 60_000 + offset);

async function withBridge(messages, fn, runtimeOverrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "rules-int-"));
  const bridge = await startFakeBridge({
    mode: "starttls", certificate,
    folders: {
      INBOX: { uidValidity: 1, messages },
      "Folders/Geek": { uidValidity: 2, messages: [] },
      Archive: { uidValidity: 3, specialUse: "\\Archive", messages: [] },
      Trash: { uidValidity: 4, specialUse: "\\Trash", messages: [] },
    },
  });
  const config = configFor(dir, bridge.port, runtimeOverrides);
  const manager = new AccountManager(config);
  const bundle = manager.primary();
  const sent = [];
  bundle.smtpService.sendEmail = async (input) => { sent.push(input); return { messageId: "<r@x>", accepted: input.to, rejected: [], response: "250" }; };
  try {
    await fn({ bundle, bridge, sent, ctx: createToolContext(config, manager) });
  } finally {
    bundle.backgroundSyncService.stop();
    await bundle.imapService.disconnect().catch(() => {});
    await bundle.localIndexService.close();
    await bridge.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const parse = (result) => JSON.parse(result.content[0].text);

test("a rule marks and files new mail by itself after a sync, forwards a person's mail once, and leaves list mail alone", needsOpenssl, async () => {
  const messages = [
    createMessage(1, { subject: "Lunch?", from: "alice@example.com", date: soon(0) }),
    createMessage(2, { subject: "Urgent", from: "boss@example.com", date: soon(1) }),
    createMessage(3, { subject: "Sale", from: "boss@example.com", headers: { "List-Unsubscribe": "<mailto:u@x.example>" }, date: soon(2) }),
    createMessage(4, { subject: "Old", from: "alice@example.com", date: new Date(Date.UTC(2020, 0, 1)) }),
  ];
  await withBridge(messages, async ({ bundle, bridge, sent }) => {
    await bundle.rulesService.set({ name: "alice to Geek", when: { from: ["alice@example.com"] }, actions: { markRead: true, moveTo: "Folders/Geek" } });
    await bundle.rulesService.set({ name: "boss to phone", when: { from: ["boss@example.com"] }, actions: { forwardTo: ["me@elsewhere.example"], forwardNote: "FYI" } });
    await bundle.backgroundSyncService.runNow("manual");

    const geek = bridge.folders["Folders/Geek"].messages;
    assert.deepEqual(geek.map((m) => m.subject), ["Lunch?"], "only mail after the rule was switched on is filed");
    assert.ok(geek[0].flags.has("\\Seen"), "and marked read");
    assert.ok(bridge.folders.INBOX.messages.some((m) => m.subject === "Old"), "mail from before stays");

    assert.equal(sent.length, 1, JSON.stringify(sent.map((m) => m.subject)));
    assert.deepEqual(sent[0].to, ["me@elsewhere.example"]);
    assert.equal(sent[0].subject, "Fwd: Urgent");
    assert.equal(sent[0].headers["X-Forwarded-By"], "proton-mail-bridge-client");
    assert.match(sent[0].body, /FYI/);

    await bundle.backgroundSyncService.runNow("manual");
    assert.equal(sent.length, 1, "a second sync does not forward it again");
    const state = await bundle.rulesService.get();
    assert.ok(state.recent.some((entry) => entry.ruleName === "boss to phone" && entry.did.some((d) => d.startsWith("forwarded"))));
  });
});

test("a rule that trashes never runs by itself; apply_rules previews, then does it", needsOpenssl, async () => {
  const messages = [createMessage(1, { subject: "Promo", from: "promo@shop.example", headers: { "List-Unsubscribe": "<mailto:u@shop.example>" }, date: soon(0) })];
  await withBridge(messages, async ({ bundle, bridge, ctx }) => {
    await bundle.rulesService.set({ name: "promo to trash", when: { from: ["promo@shop.example"], automated: true }, actions: { trash: true } });
    await bundle.backgroundSyncService.runNow("manual");
    assert.equal(bridge.folders.INBOX.messages.length, 1, "left alone by the sync");

    const preview = parse(await handleRuleTool("apply_rules", {}, ctx));
    assert.equal(preview.dryRun, true, "a preview unless told otherwise");
    assert.equal(preview.matched, 1);
    assert.deepEqual(preview.results[0].actions, ["move to Trash"]);
    assert.equal(bridge.folders.INBOX.messages.length, 1, "the preview changed nothing");

    const done = parse(await handleRuleTool("apply_rules", { dryRun: false }, ctx));
    assert.equal(done.changed, 1);
    assert.equal(bridge.folders.INBOX.messages.length, 0);
    assert.equal(bridge.folders.Trash.messages.length, 1);
  });
});

test("apply_rules obeys the policy: deleting needs confirmation, and a disallowed action is refused before anything is touched", needsOpenssl, async () => {
  const messages = [createMessage(1, { subject: "Old stuff", from: "old@x.example", headers: { "List-Unsubscribe": "<mailto:u@x.example>" }, date: soon(0) })];
  await withBridge(messages, async ({ bundle, bridge, ctx }) => {
    await bundle.rulesService.set({ name: "wipe", when: { from: ["old@x.example"], automated: true }, actions: { delete: true } });
    await bundle.backgroundSyncService.runNow("manual");
    await assert.rejects(handleRuleTool("apply_rules", { dryRun: false }, ctx), /Confirmation required/);
    assert.equal(bridge.folders.INBOX.messages.length, 1);
    const done = parse(await handleRuleTool("apply_rules", { dryRun: false, confirmed: true }, ctx));
    assert.equal(done.changed, 1);
    assert.equal(bridge.folders.INBOX.messages.length, 0);
  });
  await withBridge(messages, async ({ bundle, bridge, ctx }) => {
    await bundle.rulesService.set({ name: "wipe", when: { from: ["old@x.example"], automated: true }, actions: { delete: true } });
    await bundle.backgroundSyncService.runNow("manual");
    await assert.rejects(handleRuleTool("apply_rules", { dryRun: false, confirmed: true }, ctx), /disabled by the current runtime policy/);
    assert.equal(bridge.folders.INBOX.messages.length, 1, "nothing was touched");
  }, { allowedActions: ["mark_read"] });
});

test("suggest_rules proposes from the index, nothing changes, and a proposal can be accepted or dismissed", needsOpenssl, async () => {
  const newsletter = Array.from({ length: 6 }, (_, i) =>
    createMessage(i + 1, { subject: `Issue ${i}`, from: "weekly@news.example", headers: { "List-Unsubscribe": "<mailto:u@news.example>" }, date: new Date(Date.now() - (i + 1) * 3 * 24 * 60 * 60 * 1000) }),
  );
  await withBridge(newsletter, async ({ bundle, bridge, ctx }) => {
    await bundle.backgroundSyncService.runNow("manual");
    const found = parse(await handleRuleTool("suggest_rules", {}, ctx));
    assert.equal(found.proposals.length, 1, JSON.stringify(found));
    assert.equal(found.proposals[0].risk, "low");
    assert.deepEqual(found.proposals[0].rule.actions, { markRead: true, archive: true });
    assert.equal(bridge.folders.INBOX.messages.length, 6, "the scan changed nothing");

    const accepted = parse(await handleRuleTool("set_rule", { proposalId: found.proposals[0].id }, ctx));
    assert.equal(accepted.rule.source, found.proposals[0].id);
    const rules = parse(await handleRuleTool("get_rules", {}, ctx));
    assert.equal(rules.rules.length, 1);
    assert.equal(rules.proposals.length, 0, "an accepted proposal is gone");
    await assert.rejects(handleRuleTool("set_rule", { proposalId: "p-unknown" }, ctx), /No pending proposal/);
    const removed = parse(await handleRuleTool("delete_rule", { id: rules.rules[0].id }, ctx));
    assert.equal(removed.removed, "rule");
  });
});

async function withServer(runtimeOverrides, fn) {
  const dir = await mkdtemp(join(tmpdir(), "rules-tool-"));
  const { server } = createServer(configFor(dir, 9, { autoSync: false, ...runtimeOverrides }), { startBackgroundSync: false });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try { await fn(client); } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
const text = (r) => r.content[0].text;

test("a forwarding rule is gated like a send and needs a narrowing condition; switching it off and deleting are always allowed", async () => {
  const forward = { name: "fwd", when: { from: ["pat@client.example"] }, actions: { forwardTo: ["me@elsewhere.example"] } };
  await withServer({}, async (client) => {
    const unconfirmed = await client.callTool({ name: "set_rule", arguments: forward });
    assert.equal(unconfirmed.isError, true);
    assert.match(text(unconfirmed), /Confirmation required/);
    const ok = await client.callTool({ name: "set_rule", arguments: { ...forward, confirmed: true } });
    assert.ok(!ok.isError, text(ok));
    const rule = JSON.parse(text(ok)).rule;
    assert.match(JSON.parse(text(ok)).warnings.join(" "), /only mail that arrives from now on/);
    const broad = await client.callTool({ name: "set_rule", arguments: { name: "all", when: { unread: true }, actions: { forwardTo: ["me@elsewhere.example"] }, confirmed: true } });
    assert.equal(broad.isError, true);
    assert.match(text(broad), /condition on the sender, the subject or an attachment/);
    const off = await client.callTool({ name: "set_rule", arguments: { id: rule.id, enabled: false } });
    assert.ok(!off.isError, text(off));
    const del = await client.callTool({ name: "delete_rule", arguments: { id: rule.id } });
    assert.ok(!del.isError, text(del));
  });
  await withServer({ allowSend: false }, async (client) => {
    const refused = await client.callTool({ name: "set_rule", arguments: { ...forward, confirmed: true } });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /disabled by the current runtime policy/);
  });
  await withServer({ restrictOutboundToSelf: true }, async (client) => {
    const refused = await client.callTool({ name: "set_rule", arguments: { ...forward, confirmed: true } });
    assert.equal(refused.isError, true, "an outside address is not allowed when mail is confined to the user");
  });
  await withServer({ readOnly: true, allowSend: false }, async (client) => {
    const refused = await client.callTool({ name: "set_rule", arguments: { name: "x", when: { from: ["a@b.c"] }, actions: { markRead: true } } });
    assert.equal(refused.isError, true, "no rule can be added in a read-only setup");
    const none = await client.callTool({ name: "get_rules", arguments: {} });
    assert.ok(!none.isError);
  });
});
