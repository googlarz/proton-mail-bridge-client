import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { briefLines } from "../dist/services/brief-service.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";
import { createMessage, makeCertificate, startFakeBridge } from "./helpers/fake-bridge.mjs";
import { INJECTION } from "./helpers/injection-samples.mjs";

test("the brief reads as a few lines and leaves empty sections out", () => {
  const empty = { since: "2026-10-22T08:00:00Z", needsReply: [], waitingOnOthers: [], newMail: { total: 0, fromPeople: 0, automated: 0, topSenders: [] }, flagged: [] };
  assert.deepEqual(briefLines(empty), ["Nothing new needs you."]);
  const lines = briefLines({
    ...empty,
    newMail: { total: 12, fromPeople: 4, automated: 8, topSenders: ["pat@client.example"] },
    flagged: [{ from: "x@evil.example", subject: "Invoice", level: "high" }],
    needsReply: [{ from: "pat@client.example", subject: "Contract" }],
    commitments: [{ text: "send the offer", direction: "mine", overdue: true }],
  });
  assert.equal(lines.length, 4);
  assert.match(lines[0], /12 new since 2026-10-22 08:00 \(4 from people, 8 automatic\)/);
  assert.match(lines[1], /1 suspicious/);
  assert.match(lines[3], /you: send the offer/);
});

const certificate = makeCertificate();
const needsOpenssl = certificate ? {} : { skip: "openssl is not available to make a test certificate" };

test("get_brief counts new mail, flags suspicious mail and moves its since mark only when asked", needsOpenssl, async () => {
  const dir = await mkdtemp(join(tmpdir(), "brief-"));
  const bridge = await startFakeBridge({
    mode: "starttls", certificate,
    folders: { INBOX: { uidValidity: 1, messages: [
      createMessage(1, { subject: "Lunch?", from: "pat@client.example" }),
      createMessage(2, { subject: "Invoice", body: `${INJECTION}\r\n` }),
      createMessage(3, { subject: "Weekly news", headers: { "List-Unsubscribe": "<mailto:u@x.example>" } }),
    ] } },
  });
  const conn = { imap: { host: "127.0.0.1", port: bridge.port, secure: false, username: "owner@example.com", password: "secret" }, smtp: { host: "127.0.0.1", port: 9, secure: false, username: "owner@example.com", password: "secret" } };
  const config = {
    ...conn, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: "owner@example.com", slug: "owner-example-com", ...conn, dataDir: dir }],
    runtime: { readOnly: true, allowSend: false, allowRemoteDraftSync: false, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 50, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: true, allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0 },
  };
  const { server } = createServer(config, { startBackgroundSync: false });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const brief = async (args) => {
    const result = await client.callTool({ name: "get_brief", arguments: args });
    assert.ok(!result.isError, result.content?.[0]?.text);
    return JSON.parse(result.content.find((c) => c.type === "text").text);
  };
  try {
    const first = await brief({ since: "2026-01-01T00:00:00Z", syncBefore: true });
    assert.equal(first.newMail.total, 3);
    assert.equal(first.newMail.automated, 1);
    assert.equal(first.newMail.fromPeople, 2);
    assert.equal(first.flagged.length, 1);
    assert.equal(first.flagged[0].subject, "Invoice");
    assert.ok(first.text.some((line) => /3 new since/.test(line)));

    const untouched = await brief({});
    assert.equal(untouched.newMail.total, 0, "the default window is the last 24 hours, and these messages are older");
    await brief({ since: "2026-01-01T00:00:00Z", markSeen: true });
    const afterSeen = await brief({ since: undefined });
    assert.equal(afterSeen.newMail.total, 0);
    assert.ok(Date.parse(afterSeen.since) > Date.parse("2026-10-01"), "since is now the moment it was marked seen");
  } finally {
    await client.close(); await server.close(); await closeTrackedIndexes(); await bridge.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a brief marked seen for one account does not move the mark of the others", async () => {
  const { BriefStore } = await import("../dist/services/brief-service.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "brief-marks-"));
  try {
    const store = new BriefStore(dir);
    await store.markSeen("2026-10-20T08:00:00Z");
    await store.markSeen("2026-10-22T08:00:00Z", ["work"]);
    const state = await store.read();
    assert.equal(store.sinceFor(state, "work"), "2026-10-22T08:00:00Z");
    assert.equal(store.sinceFor(state, "private"), "2026-10-20T08:00:00Z", "the other account still starts at the last full brief");
    await store.markSeen("2026-10-25T08:00:00Z");
    assert.equal(store.sinceFor(await store.read(), "work"), "2026-10-25T08:00:00Z", "a full brief resets every account");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
