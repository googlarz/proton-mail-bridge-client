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

// Found live: create_reply_draft with isHtml:true appended a PLAIN-TEXT "> ..." quote
// to the HTML body, so the recipient saw the quote as one collapsed blob with literal
// "&gt;" runs. reply_to_email already built an HTML blockquote; the draft tools did not.
const original = {
  id: "INBOX::5", folder: "INBOX", uid: 5, messageId: "<orig@example.com>", subject: "Offer",
  from: [{ name: "Dita", address: "dita@example.com" }], to: [{ address: "owner@example.com" }], cc: [], replyTo: [],
  date: "2026-09-30T11:08:56.000Z", text: "Line one\n\nLine two", html: undefined, preview: "Line one",
  attachments: [], flags: [], headers: {},
};

async function withServer(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), "html-quote-"));
  const smtp = { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "x" };
  const imap = { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "x" };
  const config = {
    smtp, imap, dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: "owner@example.com", slug: "owner-example-com", imap, smtp, dataDir }],
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false,
      autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30,
      confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0 },
  };
  const { server, imapService } = createServer(config, { startBackgroundSync: false });
  imapService.getEmailById = async () => ({ ...original });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try { await fn(client); } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
const body = async (client, name, args) => {
  const r = await client.callTool({ name, arguments: { syncToRemote: false, ...args } });
  assert.ok(!r.isError, JSON.stringify(r.content));
  const draft = JSON.parse(r.content.find((c) => c.text?.trim().startsWith("{")).text);
  return draft.body;
};

test("create_reply_draft with isHtml quotes the original as an HTML blockquote, not a plain-text blob", async () => {
  await withServer(async (client) => {
    const html = await body(client, "create_reply_draft", { emailId: "INBOX::5", body: "<p>Thanks</p>", isHtml: true });
    assert.match(html, /<blockquote>/, "the quote must be a blockquote");
    assert.ok(!/(^|\n)(&gt;|>) /.test(html), "no plain-text '> ' quote lines in an HTML body");
    assert.match(html, /Line one/);
  });
});

test("create_reply_draft without isHtml keeps the plain-text quote", async () => {
  await withServer(async (client) => {
    const text = await body(client, "create_reply_draft", { emailId: "INBOX::5", body: "Thanks" });
    assert.match(text, /\n> Line one/);
    assert.ok(!/<blockquote>/.test(text));
  });
});

test("create_forward_draft with isHtml forwards as HTML, not a plain-text block", async () => {
  await withServer(async (client) => {
    const html = await body(client, "create_forward_draft", { emailId: "INBOX::5", to: "x@example.com", body: "<p>FYI</p>", isHtml: true });
    assert.match(html, /<p>---------- Forwarded message ---------<\/p>/);
  });
});

// Found in a real test to Gmail: the quoted original's signature logo (a data: image) showed as a
// broken-image box and copied ~40 KB of base64 into the reply; the header date was raw ISO.
import { buildReplyHtml, buildForwardHtml, formatQuoteDate, stripUnshippableImages } from "../dist/index.js";

test("stripUnshippableImages replaces data: and cid: images with their alt text and keeps real images", () => {
  const html = `<p>x</p><img src="data:image/png;base64,AAAA" alt="Logo"><img src='cid:abc'><img src="https://e.x/a.png" alt="Remote">`;
  const out = stripUnshippableImages(html);
  assert.ok(!/data:image|cid:/.test(out));
  assert.match(out, /\[Logo\]/);
  assert.match(out, /https:\/\/e\.x\/a\.png/, "ordinary http(s) images are left for the sanitizer to judge");
});

test("a reply quoting an HTML original with an inline logo carries no base64 and a readable date", () => {
  const big = "A".repeat(50_000);
  const detail = { ...original, html: `<p>Hi</p><img src="data:image/png;base64,${big}" alt="Logo" width="10">` };
  const html = buildReplyHtml(detail, "<p>Thanks</p>");
  assert.ok(!html.includes("base64"), "the quote must not copy the original's inline image");
  assert.ok(html.length < 1000);
  assert.ok(!/T\d\d:\d\d:\d\d/.test(html), "no raw ISO timestamp in the attribution line");
  assert.match(html, /Wed 30 Sep\w* 2026, \d\d:\d\d/);
  assert.ok(!buildForwardHtml(detail, "<p>FYI</p>").includes("base64"));
});

test("formatQuoteDate formats a real date and passes anything else through", () => {
  assert.match(formatQuoteDate("2026-09-30T12:00:00.000Z"), /^Wed 30 Sep\w* 2026, \d\d:\d\d$/);
  assert.equal(formatQuoteDate("an unknown date"), "an unknown date");
});
