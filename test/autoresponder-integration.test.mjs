import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { AccountManager } from "../dist/services/account-manager.js";
import { SMTPService } from "../dist/services/smtp-service.js";
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
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX",
      autoSyncFull: false, autoSyncLimitPerFolder: 50, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: true,
      allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0, ...runtimeOverrides },
  };
}

test("a sync that indexes new mail from a person sends one automatic reply, and none to lists", needsOpenssl, async () => {
  const dir = await mkdtemp(join(tmpdir(), "autoresponder-sync-"));
  const soon = (offset) => new Date(Date.now() + 60_000 + offset);
  const bridge = await startFakeBridge({
    mode: "starttls", certificate,
    folders: { INBOX: { uidValidity: 1, messages: [
      createMessage(1, { subject: "Lunch?", from: "alice@example.com", date: soon(0) }),
      createMessage(2, { subject: "Sale", from: "shop@example.com", headers: { "List-Unsubscribe": "<mailto:u@shop.example>" }, date: soon(1) }),
      createMessage(3, { subject: "Old", from: "bob@example.com", date: new Date(Date.UTC(2020, 0, 1)) }),
    ] } },
  });
  const manager = new AccountManager(configFor(dir, bridge.port));
  const bundle = manager.primary();
  const sent = [];
  bundle.smtpService.sendEmail = async (input) => { sent.push(input); return { messageId: "<r@x>", accepted: input.to, rejected: [], response: "250" }; };
  try {
    await bundle.autoresponderService.set({ enabled: true, body: "I am away until 4 January.", subject: "Away: {subject}" });
    await bundle.backgroundSyncService.runNow("manual");
    assert.equal(sent.length, 1, JSON.stringify(sent.map((m) => m.to)));
    assert.deepEqual(sent[0].to, ["alice@example.com"]);
    assert.equal(sent[0].subject, "Away: Lunch?");
    assert.equal(sent[0].headers["Auto-Submitted"], "auto-replied");
    assert.equal(sent[0].appendSignature, false);

    await bundle.backgroundSyncService.runNow("manual");
    assert.equal(sent.length, 1, "a second sync does not answer the same message again");
  } finally {
    bundle.backgroundSyncService.stop();
    await bundle.imapService.disconnect().catch(() => {});
    await bundle.localIndexService.close();
    await bridge.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("nothing is sent while the runtime does not allow sending or confines mail to the user", needsOpenssl, async () => {
  for (const runtime of [{ allowSend: false }, { restrictOutboundToSelf: true }]) {
    const dir = await mkdtemp(join(tmpdir(), "autoresponder-policy-"));
    const bridge = await startFakeBridge({
      mode: "starttls", certificate,
      folders: { INBOX: { uidValidity: 1, messages: [createMessage(1, { from: "alice@example.com", date: new Date(Date.now() + 60_000) })] } },
    });
    const manager = new AccountManager(configFor(dir, bridge.port, runtime));
    const bundle = manager.primary();
    let sent = 0;
    bundle.smtpService.sendEmail = async () => { sent += 1; return { messageId: "<r@x>", accepted: [], rejected: [], response: "250" }; };
    try {
      await bundle.autoresponderService.set({ enabled: true, body: "Away" });
      await bundle.backgroundSyncService.runNow("manual");
      assert.equal(sent, 0, JSON.stringify(runtime));
    } finally {
      bundle.backgroundSyncService.stop();
      await bundle.imapService.disconnect().catch(() => {});
      await bundle.localIndexService.close();
      await bridge.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
});

test("a mail sent while the rule is active carries the outgoing note, and one sent with appendSignature false does not", async () => {
  const conn = { host: "127.0.0.1", port: 9, secure: false, username: ADDRESS, password: "x" };
  const smtp = new SMTPService({ smtp: conn, imap: conn, dataDir: "/tmp/x", debug: false, runtime: {} });
  smtp.setOutgoingNoteProvider(() => "I am away until 4 January.");
  const withNote = (await smtp.buildRawMessage({ to: ["a@example.com"], subject: "Hi", body: "Hello" })).toString();
  assert.match(withNote, /I am away until 4 January\./);
  const without = (await smtp.buildRawMessage({ to: ["a@example.com"], subject: "Hi", body: "Hello", appendSignature: false })).toString();
  assert.doesNotMatch(without, /away until/);
  smtp.setOutgoingNoteProvider(undefined);
  assert.doesNotMatch((await smtp.buildRawMessage({ to: ["a@example.com"], subject: "Hi", body: "Hello" })).toString(), /away until/);
});

async function withServer(runtimeOverrides, fn) {
  const dir = await mkdtemp(join(tmpdir(), "autoresponder-tool-"));
  const { server, accountManager } = createServer(configFor(dir, 9, { autoSync: false, ...runtimeOverrides }), { startBackgroundSync: false });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try { await fn(client, accountManager.primary()); } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
const text = (r) => r.content[0].text;

test("switching the autoresponder on is gated like a send; switching it off never is", async () => {
  await withServer({}, async (client) => {
    const unconfirmed = await client.callTool({ name: "set_autoresponder", arguments: { enabled: true, body: "Away" } });
    assert.equal(unconfirmed.isError, true);
    assert.match(text(unconfirmed), /Confirmation required/);

    const on = await client.callTool({ name: "set_autoresponder", arguments: { enabled: true, body: "Away", confirmed: true } });
    assert.ok(!on.isError, text(on));
    assert.equal(JSON.parse(text(on)).rule.enabled, true);
    const shown = JSON.parse(text(await client.callTool({ name: "get_autoresponder", arguments: {} })));
    assert.equal(shown.active, true);
    assert.equal(shown.serverCanSend, true);

    const off = await client.callTool({ name: "set_autoresponder", arguments: { enabled: false } });
    assert.ok(!off.isError, text(off));
    assert.equal(JSON.parse(text(await client.callTool({ name: "get_autoresponder", arguments: {} }))).active, false);
  });
  await withServer({ allowSend: false }, async (client) => {
    const result = await client.callTool({ name: "set_autoresponder", arguments: { enabled: true, body: "Away", confirmed: true } });
    assert.equal(result.isError, true);
    assert.match(text(result), /disabled by the current runtime policy/);
    const off = await client.callTool({ name: "set_autoresponder", arguments: { enabled: false } });
    assert.ok(!off.isError, "switching off works in a read-only setup");
  });
  await withServer({ restrictOutboundToSelf: true }, async (client) => {
    const result = await client.callTool({ name: "set_autoresponder", arguments: { enabled: true, body: "Away", confirmed: true } });
    assert.equal(result.isError, true);
    assert.match(text(result), /confined to your own addresses/);
  });
});
