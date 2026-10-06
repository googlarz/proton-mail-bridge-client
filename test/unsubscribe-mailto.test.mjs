import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, extractUnsubscribeInfo } from "../dist/index.js";
import { createEmailId } from "../dist/utils/helpers.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";

net.Socket.prototype.connect = () => { throw new Error("Network disabled in this test file"); };

// A List-Unsubscribe mailto is very often "mailto:unsub@list.example?subject=unsubscribe". mailparser hands
// that over as "unsub@list.example?subject=unsubscribe", which isValidEmail rejects, so the header was reported
// as missing (or "only an https link") and the sender's requested subject was never used.

const detailWith = (mail, url) => ({ headers: { list: { unsubscribe: { mail, url } } } });

test("a plain mailto address is read as before", () => {
  assert.deepEqual(extractUnsubscribeInfo(detailWith("unsub@list.example")), { mailto: "unsub@list.example", url: undefined });
});

test("a mailto with ?subject= and &body= yields the address and the requested subject and body", () => {
  const info = extractUnsubscribeInfo(detailWith("unsub@list.example?subject=Remove%20me&body=Please%20remove%20me"));
  assert.equal(info.mailto, "unsub@list.example");
  assert.equal(info.mailtoSubject, "Remove me");
  assert.equal(info.mailtoBody, "Please remove me");
});

test("the https link is still reported next to a mailto with parameters", () => {
  const info = extractUnsubscribeInfo(detailWith("unsub@list.example?subject=unsubscribe", "https://list.example/u/123"));
  assert.equal(info.mailto, "unsub@list.example");
  assert.equal(info.url, "https://list.example/u/123");
});

test("several recipients, or an address that is not an address, are refused", () => {
  for (const bad of ["a@x.example,b@y.example", "a@x.example;b@y.example", "%0d%0aBcc:evil@z.example", "not an address", "a@x.example b@y.example", "?subject=x"]) {
    assert.equal(extractUnsubscribeInfo(detailWith(bad)).mailto, undefined, bad);
  }
});

test("a header-injection attempt in the subject or body cannot add a line to the generated mail", () => {
  const info = extractUnsubscribeInfo(detailWith("unsub@list.example?subject=hi%0d%0aBcc:%20evil@z.example&body=a%0d%0aBcc:%20evil@z.example"));
  assert.doesNotMatch(info.mailtoSubject ?? "", /[\r\n]/);
  assert.match(info.mailtoSubject ?? "", /^hi/);
  assert.doesNotMatch(info.mailtoBody ?? "", /\r/);
});

test("an absurdly long requested subject or body is cut", () => {
  const info = extractUnsubscribeInfo(detailWith(`u@x.example?subject=${"a".repeat(5000)}&body=${"b".repeat(50_000)}`));
  assert.ok(info.mailtoSubject.length <= 200);
  assert.ok(info.mailtoBody.length <= 2000);
});

test("unsubscribe_sender sends the subject and body the sender asked for", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "unsubscribe-mailto-"));
  const smtp = { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "x" };
  const imap = { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "x" };
  const { server, imapService, accountManager } = createServer({
    smtp, imap, dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: "owner@example.com", slug: "owner-example-com", imap, smtp, dataDir }],
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false,
      autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false,
      maxInlineBytes: 40960, opDelayMs: 0, sendDelaySeconds: 0 },
  }, { startBackgroundSync: false });
  imapService.getEmailById = async () => ({ id: "x", subject: "Newsletter", headers: { list: { unsubscribe: { mail: "unsub@list.example?subject=Remove%20me&body=Please" } } } });
  const sent = [];
  accountManager.primary().smtpService.sendEmail = async (payload) => { sent.push(payload); return { messageId: "<s@x>", accepted: payload.to, rejected: [] }; };
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    await client.callTool({ name: "unsubscribe_sender", arguments: { emailId: createEmailId("INBOX", 5, "100") } });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, ["unsub@list.example"]);
    assert.equal(sent[0].subject, "Remove me");
    assert.equal(sent[0].body, "Please");
  } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
