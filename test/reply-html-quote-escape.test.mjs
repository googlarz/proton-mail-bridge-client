import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";

net.Socket.prototype.connect = () => { throw new Error("Network disabled in this test file"); };

// reply_to_email / reply_all_email / forward_email with isHtml:true and a raw HTML body used the PLAIN-TEXT
// quote builders and sent the result as HTML. The quoted original (sender names, subject, text) is
// untrusted: "Bob <b>" opened a bold tag, `a<b and c>d` lost text, and a link in the original became a
// live link in the user's outgoing reply.
const hostile = {
  id: "INBOX::9", folder: "INBOX", uid: 9, messageId: "<orig@example.com>", subject: "Quote <i>please</i>",
  from: [{ name: "Bob <b>", address: "bob@example.com" }], to: [{ address: "owner@example.com" }], cc: [], replyTo: [],
  date: "2026-09-30T11:08:56.000Z",
  text: 'a<b and c>d\n<a href="https://evil.example/x">click</a>\nsecond line',
  html: undefined, preview: "p", attachments: [], flags: [], headers: {},
};

async function withServer(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), "reply-html-escape-"));
  const smtp = { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "x" };
  const imap = { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "x" };
  const config = {
    smtp, imap, dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: "owner@example.com", slug: "owner-example-com", imap, smtp, dataDir }],
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false,
      autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30,
      confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0, sendDelaySeconds: 0 },
  };
  const { server, imapService, accountManager } = createServer(config, { startBackgroundSync: false });
  imapService.getEmailById = async () => ({ ...hostile });
  const sent = [];
  accountManager.primary().smtpService.sendEmail = async (payload) => {
    sent.push(payload);
    return { messageId: "<sent@example.com>", accepted: payload.to, rejected: [], response: "250 ok" };
  };
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try { await fn(client, sent); } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

const send = async (client, name, args) => {
  const r = await client.callTool({ name, arguments: { emailId: "INBOX::9", ...args } });
  assert.ok(!r.isError, JSON.stringify(r.content));
};

function assertQuoteIsEscaped(html) {
  assert.ok(!html.includes('<a href="https://evil.example'), "a link from the original must not become live");
  assert.ok(!html.includes("<b>"), "a tag in the sender name must not become markup");
  assert.ok(!html.includes("<i>please"), "a tag in the subject must not become markup");
  assert.match(html, /a&lt;b and c&gt;d/, "angle brackets in the original text survive as text");
  assert.match(html, /evil\.example/, "the link text is still shown, as text");
}

test("reply_to_email with isHtml escapes the quoted original", async () => {
  await withServer(async (client, sent) => {
    await send(client, "reply_to_email", { body: "<p>Thanks</p>", isHtml: true, appendSignature: false });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].isHtml, true);
    assert.match(sent[0].body, /<p>Thanks<\/p>/, "the user's own HTML is kept");
    assert.match(sent[0].body, /<blockquote>/);
    assertQuoteIsEscaped(sent[0].body);
  });
});

test("reply_all_email with isHtml escapes the quoted original", async () => {
  await withServer(async (client, sent) => {
    await send(client, "reply_all_email", { body: "<p>Thanks</p>", isHtml: true, appendSignature: false });
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /<blockquote>/);
    assertQuoteIsEscaped(sent[0].body);
  });
});

test("forward_email with isHtml escapes the forwarded header and original", async () => {
  await withServer(async (client, sent) => {
    await send(client, "forward_email", { to: "friend@example.com", body: "<p>FYI</p>", isHtml: true, appendSignature: false });
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /<p>FYI<\/p>/);
    assert.match(sent[0].body, /bob@example\.com/, "the sender's address is not swallowed as a tag");
    assertQuoteIsEscaped(sent[0].body);
  });
});

test("plain-text replies and forwards are unchanged: the quote stays text, nothing is HTML-escaped", async () => {
  await withServer(async (client, sent) => {
    await send(client, "reply_to_email", { body: "Thanks", appendSignature: false });
    assert.equal(sent[0].isHtml, false);
    assert.match(sent[0].body, /Bob <b> <bob@example\.com>|Bob <b>/);
    assert.match(sent[0].body, /a<b and c>d/);
  });
});

test("a reply carries the whole References chain, not only the parent's Message-ID", async () => {
  await withServer(async (client, sent) => {
    // The hostile fixture is the original; give it an existing thread behind it.
    await send(client, "reply_to_email", { body: "Thanks", appendSignature: false });
    assert.deepEqual(sent[0].references, ["<orig@example.com>"], "no earlier chain: just the parent");
  });
  const withChain = { ...hostile, references: ["<root@example.com>", "<mid@example.com>"] };
  const dataDir = await mkdtemp(join(tmpdir(), "reply-references-"));
  const smtp = { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "x" };
  const imap = { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "x" };
  const { server, imapService, accountManager } = createServer({
    smtp, imap, dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: "owner@example.com", slug: "owner-example-com", imap, smtp, dataDir }],
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false,
      autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false,
      maxInlineBytes: 40960, opDelayMs: 0, sendDelaySeconds: 0 },
  }, { startBackgroundSync: false });
  imapService.getEmailById = async () => ({ ...withChain });
  const sent = [];
  accountManager.primary().smtpService.sendEmail = async (payload) => { sent.push(payload); return { messageId: "<s@example.com>", accepted: payload.to, rejected: [], response: "250" }; };
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    await send(client, "reply_to_email", { body: "Thanks", appendSignature: false });
    assert.deepEqual(sent[0].references, ["<root@example.com>", "<mid@example.com>", "<orig@example.com>"]);
    assert.equal(sent[0].inReplyTo, "<orig@example.com>");
  } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
