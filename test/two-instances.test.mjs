import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountManager } from "../dist/services/account-manager.js";
import { slugifyAccountAddress } from "../dist/utils/helpers.js";
import { createMessage, makeCertificate, startFakeBridge } from "./helpers/fake-bridge.mjs";

// Some desktop clients start the same stdio server twice (anthropics/claude-ai-mcp#1156). Both processes share a data
// directory, so what the server does on its own (automatic replies, rules) must still happen once.

const certificate = makeCertificate();
const needsOpenssl = certificate ? {} : { skip: "openssl is not available to make a test certificate" };
const ADDRESS = "owner@example.com";

function configFor(dir, port) {
  const imap = { host: "127.0.0.1", port, secure: false, username: ADDRESS, password: "secret" };
  const smtp = { host: "127.0.0.1", port: 9, secure: false, username: ADDRESS, password: "secret" };
  return {
    smtp, imap, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: true, syncInterval: 5,
    accounts: [{ address: ADDRESS, slug: slugifyAccountAddress(ADDRESS), imap, smtp, dataDir: dir }],
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: ["archive", "mark_read"], startupSync: false, autoSyncFolder: "INBOX",
      autoSyncFull: false, autoSyncLimitPerFolder: 50, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: true,
      allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0 },
  };
}

test("two server instances on one data directory answer a message once and forward it once", needsOpenssl, async () => {
  const dir = await mkdtemp(join(tmpdir(), "two-instances-"));
  const bridge = await startFakeBridge({
    mode: "starttls", certificate,
    folders: { INBOX: { uidValidity: 1, messages: [createMessage(1, { subject: "Lunch?", from: "alice@example.com", date: new Date(Date.now() + 60_000) })] } },
  });
  const config = configFor(dir, bridge.port);
  const first = new AccountManager(config).primary();
  const second = new AccountManager(config).primary();
  const sent = [];
  for (const bundle of [first, second]) bundle.smtpService.sendEmail = async (input) => { sent.push(input.to); return { messageId: "<r@x>", accepted: input.to, rejected: [], response: "250" }; };
  try {
    await first.autoresponderService.set({ enabled: true, body: "Away" });
    await first.rulesService.set({ name: "fwd", enabled: true, when: { from: ["alice@example.com"] }, actions: { forwardTo: ["me@elsewhere.example"] } });
    await Promise.all([first.backgroundSyncService.runNow("manual"), second.backgroundSyncService.runNow("manual")]);
    await Promise.all([first.backgroundSyncService.runNow("manual"), second.backgroundSyncService.runNow("manual")]);
    const replies = sent.filter((to) => to.includes("alice@example.com"));
    const forwards = sent.filter((to) => to.includes("me@elsewhere.example"));
    assert.equal(replies.length, 1, `replied ${replies.length} times: ${JSON.stringify(sent)}`);
    assert.equal(forwards.length, 1, `forwarded ${forwards.length} times: ${JSON.stringify(sent)}`);
  } finally {
    for (const bundle of [first, second]) {
      bundle.backgroundSyncService.stop();
      await bundle.imapService.disconnect().catch(() => {});
      await bundle.localIndexService.close();
    }
    await bridge.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
