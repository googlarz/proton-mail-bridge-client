import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventLogService } from "../dist/services/event-log-service.js";
import { annotateEvents } from "../dist/tools/events.js";
import { MailTaint } from "../dist/utils/mail-security.js";
import { INJECTION } from "./helpers/injection-samples.mjs";

const withDir = async (fn) => {
  const dir = await mkdtemp(join(tmpdir(), "event-flood-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
};
const newLog = (dir) => new EventLogService({ dataDir: dir, smtp: { username: "owner@example.com" } });
const mail = (n, from = "spam@evil.example") => ({ type: "mail.new", emailId: `INBOX::${n}`, from, subject: `s${n}`, key: `mail.new:${n}` });

test("a burst of mail.new events does not push a real send.failed out of the log", async () => {
  await withDir(async (dir) => {
    const log = newLog(dir);
    await log.append([{ type: "send.failed", refId: "send.REAL", detail: "refused" }]);
    for (let i = 0; i < 21; i++) await log.append(Array.from({ length: 100 }, (_, j) => mail(i * 100 + j, `spam${j}@evil.example`)));
    const all = await log.readAll();
    assert.ok(all.some((event) => event.type === "send.failed"));
    assert.ok(all.filter((event) => event.type === "mail.new").length <= 200, "at most 200 mail.new in the hour");
    assert.ok(all.some((event) => event.type === "mail.new_overflow"), "the excess is counted in one event");
  });
});

test("mail.new is limited per sender and per hour; the excess is folded into one overflow event", async () => {
  await withDir(async (dir) => {
    const log = newLog(dir);
    await log.append(Array.from({ length: 80 }, (_, i) => mail(i)));
    const all = await log.readAll();
    assert.equal(all.filter((event) => event.type === "mail.new").length, 50);
    const overflow = all.filter((event) => event.type === "mail.new_overflow");
    assert.equal(overflow.length, 1);
    assert.match(overflow[0].detail, /30/);
    // Another sender is not affected, and an hour later the sender may be heard again.
    const other = await log.append([mail(1000, "friend@example.com")]);
    assert.equal(other.length, 1);
    const later = await log.append([mail(2000)], new Date(Date.now() + 61 * 60 * 1000));
    assert.equal(later.filter((event) => event.type === "mail.new").length, 1);
  });
});

test("the newest events of the important types survive any amount of other events through rotation", async () => {
  await withDir(async (dir) => {
    const log = newLog(dir);
    await log.append([{ type: "send.failed", refId: "send.REAL", detail: "refused" }, { type: "delegation.used", refId: "d1" }]);
    for (let i = 0; i < 25; i++) await log.append(Array.from({ length: 100 }, (_, j) => ({ type: "autoresponder.replied", emailId: `INBOX::${i}-${j}` })));
    const all = await log.readAll();
    assert.ok(all.some((event) => event.type === "send.failed"));
    assert.ok(all.some((event) => event.type === "delegation.used"));
    // Numbers still only go up, and what was kept is in order.
    for (let i = 1; i < all.length; i++) assert.ok(all[i].seq > all[i - 1].seq);
    // The floor is per type and bounded: 300 send.failed leave only the newest 200 behind.
    for (let i = 0; i < 3; i++) await log.append(Array.from({ length: 100 }, (_, j) => ({ type: "send.failed", refId: `f${i}-${j}` })));
    for (let i = 0; i < 25; i++) await log.append(Array.from({ length: 100 }, (_, j) => ({ type: "autoresponder.replied", emailId: `INBOX::x${i}-${j}` })));
    const failed = (await log.readAll()).filter((event) => event.type === "send.failed");
    assert.equal(failed.length, 200);
    assert.equal(failed.at(-1).refId, "f2-99");
  });
});

test("detail is cleaned like a subject, capped and marked untrusted", async () => {
  await withDir(async (dir) => {
    const log = newLog(dir);
    const [stored] = await log.append([{ type: "send.failed", refId: "send.1", detail: `554 rejected\n‮${"x".repeat(400)}​` }]);
    assert.doesNotMatch(stored.detail, /[\n‮​]/);
    assert.ok(Array.from(stored.detail).length <= 300);
    assert.equal(stored.untrusted, true);
    const text = await readFile(join(dir, "events.jsonl"), "utf8");
    assert.equal(text.split("\n").filter(Boolean).length, 1);
    const [overflow] = await log.append([{ type: "mail.new_overflow", detail: "3 more new messages not listed" }]);
    assert.equal(overflow.untrusted, undefined, "text of our own making");
  });
});

test("an instruction phrase in detail is flagged and taints the session", () => {
  const taint = new MailTaint();
  const events = [{ type: "send.failed", refId: "send.1", detail: `550 5.1.1 ${INJECTION}`, untrusted: true }, { type: "send.failed", refId: "send.2", detail: "554 mailbox full" }];
  annotateEvents(events, taint);
  assert.equal(events[0].risk?.level, "high");
  assert.equal(events[1].risk, undefined);
  assert.ok(taint.current());
});
