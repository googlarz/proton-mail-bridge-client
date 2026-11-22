import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { redactSendPayload } from "../dist/tools/drafts-support.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";

// Each send tool's dryRun returns the payload its real call hands to SMTPService.sendEmail, so the two can't drift.

const ADDRESS = "owner@example.com";
const ics = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:evt-1@example.com", "SEQUENCE:1",
  "DTSTART:20261015T090000Z", "DTEND:20261015T100000Z", "SUMMARY:Planning",
  "ORGANIZER;CN=Ann:mailto:ann@example.com", `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ADDRESS}`, "END:VEVENT", "END:VCALENDAR", "",
].join("\r\n");
const detail = {
  id: "INBOX::1", folder: "INBOX", uid: 1, subject: "Numbers", from: [{ name: "Ann", address: "ann@example.com" }],
  to: [{ address: ADDRESS }, { address: "dan@example.com" }], cc: [], bcc: [], replyTo: [], date: "2026-11-20T10:00:00.000Z",
  messageId: "<orig@example.com>", references: ["<Root@protonmail.internalid>"], text: "q".repeat(2000), body: "q".repeat(2000),
  attachments: [
    { id: "a1", part: "2", filename: "report.pdf", contentType: "application/pdf" },
    { id: "a2", part: "3", filename: "invite.ics", contentType: "text/calendar", isCalendarInvite: true, kind: "calendar" },
  ],
  isRead: true, isStarred: false, flags: [], labels: [],
};
const attachment = { filename: "note.txt", contentType: "text/plain", content: Buffer.from("hello").toString("base64") };

async function withServer(fn) {
  const dir = await mkdtemp(join(tmpdir(), "dry-run-payload-"));
  const conn = { host: "127.0.0.1", port: 9, secure: false, username: ADDRESS, password: "x" };
  const config = {
    smtp: conn, imap: conn, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: ADDRESS, slug: "owner-example-com", imap: conn, smtp: conn, dataDir: dir }],
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: false, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false,
      autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false,
      maxInlineBytes: 40960, opDelayMs: 0, sendDelaySeconds: 0 },
  };
  const { server, imapService, smtpService, draftStore } = createServer(config, { startBackgroundSync: false });
  imapService.getEmailById = async () => structuredClone(detail);
  imapService.getAttachmentForForward = async () => ({ filename: "report.pdf", contentType: "application/pdf", content: Buffer.from("%PDF").toString("base64") });
  imapService.getAttachmentContent = async () => ({ base64: Buffer.from(ics).toString("base64") });
  imapService.searchEmails = async () => ({ emails: [], total: 0 });
  const sent = [];
  smtpService.sendEmail = async (payload) => { sent.push(payload); return { messageId: "<sent@example.com>", accepted: payload.to, rejected: [], response: "250 OK" }; };
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  try { await fn({ call, sent, draftStore }); } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const cases = [
  ["send_email", () => ({ to: "bob@example.com", cc: "carol@example.com", subject: "Hi", markdownBody: "**hi**", attachments: [attachment], priority: "high" })],
  ["reply_to_email", () => ({ emailId: "INBOX::1", body: "Thanks", bcc: "eve@example.com" })],
  ["reply_all_email", () => ({ emailId: "INBOX::1", body: "Thanks all" })],
  ["forward_email", () => ({ emailId: "INBOX::1", to: "bob@example.com", body: "FYI", attachments: [attachment] })],
  ["respond_to_invite", () => ({ emailId: "INBOX::1", response: "accept", comment: "See you" })],
  ["send_draft", async (draftStore) => ({ draftId: (await draftStore.createDraft({ mode: "compose", to: ["bob@example.com"], cc: [], bcc: [], subject: "Draft", body: "d".repeat(900), isHtml: false, attachments: [attachment] })).id })],
];

for (const [tool, makeArgs] of cases) {
  test(`${tool}: dryRun returns the payload the real call sends`, async () => {
    await withServer(async ({ call, sent, draftStore }) => {
      const args = await makeArgs(draftStore);
      const dry = await call(tool, { ...args, dryRun: true });
      assert.equal(sent.length, 0, "a dry run sends nothing");
      await call(tool, { ...args, confirmed: true });
      assert.equal(sent.length, 1);
      // Through JSON, as the tool result is: undefined fields drop out.
      assert.deepEqual(dry.message, JSON.parse(JSON.stringify(redactSendPayload(sent[0]))));
      assert.deepEqual(dry.wouldSendTo, { to: sent[0].to, cc: sent[0].cc ?? [], bcc: sent[0].bcc ?? [] });
    });
  });
}

test("the preview leaves attachment bytes and the HTML copy out, and cuts a long body", () => {
  const preview = redactSendPayload({ to: ["a@example.com"], subject: "s", body: "x".repeat(600), htmlBody: "<p>x</p>", attachments: [attachment] });
  assert.equal(preview.attachments[0].content, "");
  assert.equal(preview.attachments[0].size, 5);
  assert.equal(preview.htmlBody, undefined);
  assert.equal(preview.htmlBodyOmitted, true);
  assert.equal(preview.bodyLength, 600);
  assert.equal(preview.bodyTruncated, true);
});
