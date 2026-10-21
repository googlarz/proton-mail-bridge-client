import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoresponderService, isActive, replySubject, skipReason } from "../dist/services/autoresponder-service.js";

const OWN = ["owner@example.com"];
const NOW = Date.parse("2026-12-24T12:00:00Z");

function mail(overrides = {}) {
  return {
    id: "INBOX::1", folder: "INBOX", uid: 1, seq: 1, messageId: "<m1@x>", subject: "Question", references: [],
    from: [{ address: "alice@example.com" }], to: [{ address: "owner@example.com" }], cc: [], bcc: [], replyTo: [],
    date: "2026-12-24T11:00:00Z", internalDate: "2026-12-24T11:00:00Z", isRead: false, isStarred: false, flags: [],
    hasAttachments: false, attachments: [], labels: [], isAutomated: false, ...overrides,
  };
}

async function withService(fn) {
  const dir = await mkdtemp(join(tmpdir(), "autoresponder-"));
  const service = new AutoresponderService({ dataDir: dir });
  try { await fn(service, dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

const ENABLED_AT = Date.parse("2026-12-24T10:00:00Z");

test("a rule is off until switched on, needs text, and validates its dates", async () => {
  await withService(async (service) => {
    assert.equal((await service.get()).active, false);
    await assert.rejects(service.set({ enabled: true }), /body|outgoingNote/);
    await assert.rejects(service.set({ enabled: true, body: "Away", startsAt: "2026-12-30", endsAt: "2026-12-24" }), /endsAt must be after/);
    await assert.rejects(service.set({ body: "x", replyEveryDays: 0 }), /1 to 90/);
    await assert.rejects(service.set({ startsAt: "not a date" }), /must be a date/);
    const rule = await service.set({ enabled: true, body: "Away until 4 January", replyEveryDays: 3 }, ENABLED_AT);
    assert.equal(rule.enabled, true);
    assert.equal(rule.activatedAt, new Date(ENABLED_AT).toISOString());
    assert.equal(rule.replyEveryDays, 3);
  });
});

test("a message is answered once, to a person who wrote to this address, after the rule was switched on", async () => {
  await withService(async (service) => {
    await service.set({ enabled: true, body: "I am away.", subject: "Away: {subject}" }, ENABLED_AT);
    const sent = [];
    const send = async (reply) => { sent.push(reply); };

    const outcome = await service.process([mail()], OWN, send, NOW);
    assert.deepEqual(outcome.replied, ["INBOX::1"]);
    assert.equal(sent[0].to, "alice@example.com");
    assert.equal(sent[0].subject, "Away: Question");
    assert.equal(sent[0].body, "I am away.");
    assert.equal(sent[0].inReplyTo, "<m1@x>");
    assert.equal(sent[0].headers["Auto-Submitted"], "auto-replied");

    // The same message again (it is in the next sync's window), and a second one from the same sender.
    await service.process([mail()], OWN, send, NOW + 1000);
    await service.process([mail({ id: "INBOX::2", messageId: "<m2@x>" })], OWN, send, NOW + 2000);
    assert.equal(sent.length, 1, "once per sender");
    // After the interval it may answer again.
    const later = NOW + 8 * 24 * 60 * 60 * 1000;
    await service.process([mail({ id: "INBOX::3", messageId: "<m3@x>", internalDate: new Date(later - 1000).toISOString() })], OWN, send, later);
    assert.equal(sent.length, 2);
  });
});

test("it never answers lists, automatic mail, no-reply senders, itself, mail not addressed to it, or old mail", async () => {
  await withService(async (service) => {
    await service.set({ enabled: true, body: "Away" }, ENABLED_AT);
    const sent = [];
    const send = async (reply) => { sent.push(reply); };
    const cases = {
      "list or automatic mail": mail({ id: "a", messageId: "<a>", isAutomated: true }),
      "headers not read": mail({ id: "b", messageId: "<b>", isAutomated: undefined }),
      "no-reply sender": mail({ id: "c", messageId: "<c>", from: [{ address: "no-reply@shop.example" }] }),
      "mailer-daemon": mail({ id: "d", messageId: "<d>", from: [{ address: "MAILER-DAEMON@example.com" }] }),
      "own address": mail({ id: "e", messageId: "<e>", from: [{ address: "Owner@Example.com" }] }),
      "only bcc'd": mail({ id: "f", messageId: "<f>", to: [{ address: "someone@else.example" }] }),
      "before it was switched on": mail({ id: "g", messageId: "<g>", internalDate: "2026-12-24T09:00:00Z" }),
      "another folder": mail({ id: "h", messageId: "<h>", folder: "Archive" }),
    };
    for (const [label, email] of Object.entries(cases)) {
      await service.process([email], OWN, send, NOW);
      assert.equal(sent.length, 0, `${label} must not get a reply`);
    }
    const state = await service.get();
    assert.equal(state.sentTotal, 0);
  });
});

test("the window limits both the reply and the outgoing note", async () => {
  await withService(async (service) => {
    await service.set({ enabled: true, body: "Away", outgoingNote: "Away until 4 January.", startsAt: "2026-12-24T00:00:00Z", endsAt: "2026-12-31T00:00:00Z" }, ENABLED_AT);
    assert.equal(await service.outgoingNote(NOW), "Away until 4 January.");
    assert.equal(await service.outgoingNote(Date.parse("2027-01-02T00:00:00Z")), undefined, "after the window");
    assert.equal(await service.outgoingNote(Date.parse("2026-12-20T00:00:00Z")), undefined, "before the window");
    assert.equal(service.outgoingNoteNow(NOW), "Away until 4 January.", "the synchronous read used while a mail is built");
    await service.set({ enabled: false });
    assert.equal(await service.outgoingNote(NOW), undefined, "off");
    assert.equal(service.outgoingNoteNow(NOW), undefined);
  });
});

test("a day's replies are capped, and a failed send is reported and not retried", async () => {
  await withService(async (service) => {
    await service.set({ enabled: true, body: "Away" }, ENABLED_AT);
    let sent = 0;
    const emails = Array.from({ length: 60 }, (_, i) => mail({ id: `m${i}`, messageId: `<m${i}>`, from: [{ address: `p${i}@example.com` }], internalDate: new Date(NOW - 60_000 + i).toISOString() }));
    const outcome = await service.process(emails, OWN, async () => { sent += 1; }, NOW);
    assert.equal(sent, 50);
    assert.equal(outcome.skipped.filter((entry) => entry.reason === "daily-limit").length, 10);

    await withService(async (other) => {
      await other.set({ enabled: true, body: "Away" }, ENABLED_AT);
      const failing = await other.process([mail()], OWN, async () => { throw new Error("SMTP down"); }, NOW);
      assert.deepEqual(failing.failed, [{ id: "INBOX::1", error: "SMTP down" }]);
      let again = 0;
      await other.process([mail()], OWN, async () => { again += 1; }, NOW + 1000);
      assert.equal(again, 0, "recorded before sending, so a failure does not turn into a second attempt");
    });
  });
});

test("helpers: activity, subject template", () => {
  assert.equal(isActive(undefined, NOW), false);
  assert.equal(isActive({ enabled: true, subject: "", body: "x", replyEveryDays: 7, updatedAt: "" }, NOW), true);
  assert.equal(replySubject({ subject: "Away: {subject}", body: "", enabled: true, replyEveryDays: 7, updatedAt: "" }, "Re: Hello\r\nBcc: x"), "Away: Hello Bcc: x");
  assert.ok(skipReason(mail(), { replies: {}, handled: [], daily: { date: "", count: 0 }, sentTotal: 0, version: 1 }, OWN, NOW) === "not-active");
});
