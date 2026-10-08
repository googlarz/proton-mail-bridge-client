import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { slugifyAccountAddress } from "../dist/utils/helpers.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";

// respond_to_invite reads the invitation in a message and sends the organizer a calendar reply.

const ics = (attendee, method = "REQUEST") => [
  "BEGIN:VCALENDAR", "VERSION:2.0", `METHOD:${method}`, "BEGIN:VEVENT", "UID:evt-1@example.com", "SEQUENCE:1",
  "DTSTART:20261015T090000Z", "DTEND:20261015T100000Z", "SUMMARY:Quarterly planning",
  "ORGANIZER;CN=Anna:mailto:anna@corp.example", `ATTENDEE;PARTSTAT=NEEDS-ACTION;CN=Me:mailto:${attendee}`, "END:VEVENT", "END:VCALENDAR", "",
].join("\r\n");

function accountConfig(dataDir, address) {
  return { address, slug: slugifyAccountAddress(address),
    imap: { host: "127.0.0.1", port: 9, secure: false, username: address, password: "x" },
    smtp: { host: "127.0.0.1", port: 9, secure: false, username: address, password: "x" }, dataDir };
}

async function withServer({ addresses = ["owner@example.com"], runtime = {} } = {}, fn) {
  const dirs = await Promise.all(addresses.map(() => mkdtemp(join(tmpdir(), "invite-"))));
  const accounts = addresses.map((address, i) => accountConfig(dirs[i], address));
  const config = {
    smtp: accounts[0].smtp, imap: accounts[0].imap, dataDir: dirs[0], debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false,
      autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false,
      maxInlineBytes: 40960, opDelayMs: 0, sendDelaySeconds: 0, ...runtime },
    accounts,
  };
  const { server, accountManager } = createServer(config, { startBackgroundSync: false });
  const sent = [];
  const bundles = accountManager.all();
  bundles.forEach((bundle, index) => {
    bundle.smtpService.sendEmail = async (payload) => { sent.push({ via: bundle.account.address, payload }); return { messageId: "<sent@example.com>", accepted: payload.to, rejected: [], response: "250 OK" }; };
    bundle.imapService.getFolderStats = async () => { throw new Error("no bridge"); };
    // The sent-copy check after a send looks in Sent; there is no Bridge here.
    bundle.imapService.searchEmails = async () => ({ emails: [], total: 0 });
  });
  const mailbox = { attachments: [{ id: "a1", filename: "invite.ics", contentType: "text/calendar", isCalendarInvite: true, kind: "calendar" }], ics: ics("owner@example.com") };
  bundles.forEach((bundle) => {
    bundle.imapService.getEmailById = async (id) => ({ id, folder: "INBOX", uid: 1, seq: 1, messageId: "<invite@corp.example>", subject: "Invitation: Quarterly planning", from: [{ address: "anna@corp.example" }], to: [{ address: bundle.account.address }], cc: [], bcc: [], replyTo: [], isRead: false, isStarred: false, flags: [], hasAttachments: true, labels: [], attachments: mailbox.attachments });
    bundle.imapService.getAttachmentContent = async () => ({ base64: Buffer.from(mailbox.ics, "utf8").toString("base64") });
  });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (name, args) => {
    try {
      const r = await client.callTool({ name, arguments: args });
      const text = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      let json; try { json = JSON.parse(r.content.find((c) => c.type === "text" && !c.text.startsWith("Note:"))?.text ?? ""); } catch { /* not JSON */ }
      return { error: r.isError === true, text, json };
    } catch (error) { return { error: true, text: String(error?.message ?? error) }; }
  };
  try { await fn({ call, sent, mailbox, bundles }); } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
  }
}

test("accepting sends the organizer a METHOD:REPLY from the invited address, threaded to the invitation", async () => {
  await withServer({}, async ({ call, sent }) => {
    const result = await call("respond_to_invite", { emailId: "INBOX::1", response: "accept", comment: "Looking forward" });
    assert.equal(result.error, false, result.text);
    assert.equal(sent.length, 1);
    const { payload } = sent[0];
    assert.deepEqual(payload.to, ["anna@corp.example"]);
    assert.equal(payload.subject, "Accepted: Quarterly planning");
    assert.equal(payload.icalEvent.method, "REPLY");
    assert.match(payload.icalEvent.content, /ATTENDEE;PARTSTAT=ACCEPTED;CN="Me":mailto:owner@example\.com/);
    assert.match(payload.icalEvent.content, /COMMENT:Looking forward/);
    assert.equal(payload.inReplyTo, "<invite@corp.example>");
    assert.equal(payload.appendSignature, false);
    assert.equal(result.json.response, "accept");
    assert.equal(result.json.previousStatus, "NEEDS-ACTION");
  });
});

test("decline and tentative map to their own status", async () => {
  await withServer({}, async ({ call, sent }) => {
    await call("respond_to_invite", { emailId: "INBOX::1", response: "decline" });
    await call("respond_to_invite", { emailId: "INBOX::1", response: "tentative" });
    assert.match(sent[0].payload.icalEvent.content, /PARTSTAT=DECLINED/);
    assert.match(sent[1].payload.icalEvent.content, /PARTSTAT=TENTATIVE/);
    assert.equal(sent[0].payload.subject, "Declined: Quarterly planning");
  });
});

test("dryRun shows who would be answered and what the reply says, and sends nothing", async () => {
  await withServer({}, async ({ call, sent }) => {
    const result = await call("respond_to_invite", { emailId: "INBOX::1", response: "accept", dryRun: true });
    assert.equal(result.error, false, result.text);
    assert.deepEqual(sent, []);
    assert.equal(result.json.dryRun, true);
    assert.deepEqual(result.json.wouldSendTo, ["anna@corp.example"]);
    assert.ok(result.json.replyCalendar.includes("METHOD:REPLY"));
  });
});

test("things that cannot be answered are refused with the reason, and nothing is sent", async () => {
  await withServer({}, async ({ call, sent, mailbox }) => {
    mailbox.ics = ics("owner@example.com", "CANCEL");
    let result = await call("respond_to_invite", { emailId: "INBOX::1", response: "accept" });
    assert.equal(result.error, true);
    assert.match(result.text, /cancelled/);
    mailbox.attachments = [{ id: "p1", filename: "report.pdf", contentType: "application/pdf" }];
    result = await call("respond_to_invite", { emailId: "INBOX::1", response: "accept" });
    assert.match(result.text, /no calendar invitation attachment/);
    result = await call("respond_to_invite", { emailId: "INBOX::1", response: "maybe" });
    assert.match(result.text, /response must be accept, decline or tentative/);
    assert.deepEqual(sent, []);
  });
});

test("the send settings apply: sending off, outbound limited to yourself, confirmation required", async () => {
  await withServer({ runtime: { allowSend: false } }, async ({ call, sent }) => {
    const result = await call("respond_to_invite", { emailId: "INBOX::1", response: "accept" });
    assert.equal(result.error, true);
    assert.match(result.text, /Send operations are disabled/);
    assert.deepEqual(sent, []);
  });
  await withServer({ runtime: { restrictOutboundToSelf: true } }, async ({ call, sent }) => {
    const result = await call("respond_to_invite", { emailId: "INBOX::1", response: "accept" });
    assert.equal(result.error, true);
    assert.match(result.text, /RESTRICT_OUTBOUND_TO_SELF/);
    assert.deepEqual(sent, []);
  });
  await withServer({ runtime: { confirmDestructive: true } }, async ({ call, sent }) => {
    assert.equal((await call("respond_to_invite", { emailId: "INBOX::1", response: "accept" })).error, true);
    assert.deepEqual(sent, []);
    assert.equal((await call("respond_to_invite", { emailId: "INBOX::1", response: "accept", confirmed: true })).error, false);
    assert.equal(sent.length, 1);
  });
});

test("an invitation naming another of your accounts is still answered from the account that holds it", async () => {
  await withServer({ addresses: ["owner@example.com", "work@example.com"] }, async ({ call, sent, mailbox }) => {
    mailbox.ics = ics("work@example.com");
    const result = await call("respond_to_invite", { emailId: "INBOX::1", response: "accept" });
    assert.equal(result.error, false, result.text);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].via, "owner@example.com", "never sent through a mailbox the invitation merely names");
    assert.doesNotMatch(sent[0].payload.icalEvent.content, /work@example\.com/);
  });
});

test("the send delay queues the answer instead of sending it", async () => {
  await withServer({}, async ({ call, sent }) => {
    const result = await call("respond_to_invite", { emailId: "INBOX::1", response: "accept", undoWindowSeconds: 30 });
    assert.equal(result.error, false, result.text);
    assert.deepEqual(sent, [], "nothing goes out before the window ends");
    assert.match(result.text, /queued|scheduled|cancel/i);
  });
});

import { SMTPService } from "../dist/services/smtp-service.js";
import { buildInviteReply, parseInvite } from "../dist/utils/ical-reply.js";

test("the real message carries the calendar reply as a text/calendar; method=REPLY part and an .ics attachment", async () => {
  const svc = new SMTPService({
    smtp: { host: "127.0.0.1", port: 9, secure: false, username: "owner@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 9, secure: false, username: "owner@example.com", password: "x" },
    dataDir: "/tmp/respond-to-invite-mime", debug: false, runtime: { allowSend: true, readOnly: false },
  });
  const reply = buildInviteReply(parseInvite(ics("owner@example.com")), { attendeeAddress: "owner@example.com", response: "accept", now: new Date("2026-10-08T10:00:00Z") });
  const raw = (await svc.buildRawMessage({ to: ["anna@corp.example"], subject: reply.subject, body: reply.body, appendSignature: false, icalEvent: { method: "REPLY", content: reply.ics } })).toString();
  assert.match(raw, /^Subject: Accepted: Quarterly planning$/m);
  assert.match(raw, /Content-Type: multipart\/alternative;/);
  assert.match(raw, /Content-Type: text\/calendar; charset=utf-8; method=REPLY/);
  assert.match(raw, /Content-Type: application\/ics; name=invite\.ics/);
  assert.match(raw, /METHOD:REPLY/);
});
