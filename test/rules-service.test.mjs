import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RulesService, planChanges, proposalId, ruleMatches, runsAutomatically, suggestRules } from "../dist/services/rules-service.js";

const NOW = Date.parse("2026-12-24T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
let counter = 0;

function mail(overrides = {}) {
  counter += 1;
  const at = new Date(NOW - 2 * DAY).toISOString();
  return {
    id: `INBOX::${counter}`, folder: "INBOX", uid: counter, seq: counter, messageId: `<m${counter}@x>`, subject: "Hello", references: [],
    from: [{ address: "alice@example.com", name: "Alice" }], to: [{ address: "owner@example.com" }], cc: [], bcc: [], replyTo: [],
    date: at, internalDate: at, isRead: false, isStarred: false, flags: [], hasAttachments: false, attachments: [], labels: [], isAutomated: false, ...overrides,
  };
}
const ago = (days) => new Date(NOW - days * DAY).toISOString();

async function withService(fn) {
  const dir = await mkdtemp(join(tmpdir(), "rules-"));
  const service = new RulesService({ dataDir: dir });
  try { await fn(service); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

test("conditions: sender, domain, subject, age, attachment, automated, unread, folder", () => {
  const m = mail({ subject: "Invoice March", hasAttachments: true, from: [{ address: "billing@shop.example" }] });
  assert.equal(ruleMatches({ from: ["billing@shop.example"] }, m, NOW), true);
  assert.equal(ruleMatches({ from: ["*@shop.example"] }, m, NOW), true);
  assert.equal(ruleMatches({ from: ["@other.example"] }, m, NOW), false);
  assert.equal(ruleMatches({ subjectContains: ["invoice"] }, m, NOW), true);
  assert.equal(ruleMatches({ subjectContains: ["receipt"] }, m, NOW), false);
  assert.equal(ruleMatches({ subjectContains: ["x"], olderThanDays: 1 }, m, NOW), false);
  assert.equal(ruleMatches({ olderThanDays: 1 }, m, NOW), true);
  assert.equal(ruleMatches({ olderThanDays: 10 }, m, NOW), false, "arrived 2 days ago");
  assert.equal(ruleMatches({ hasAttachment: true }, m, NOW), true);
  assert.equal(ruleMatches({ automated: true }, m, NOW), false);
  assert.equal(ruleMatches({ automated: false }, m, NOW), true);
  assert.equal(ruleMatches({ automated: false }, mail({ isAutomated: undefined }), NOW), false, "unknown matches neither side");
  assert.equal(ruleMatches({ unread: true }, mail({ isRead: true }), NOW), false);
  assert.equal(ruleMatches({ from: ["alice@example.com"], folder: "Archive" }, m, NOW), false, "default folder is INBOX");
  assert.equal(ruleMatches({ from: ["billing@shop.example"], folder: "inbox" }, m, NOW), true, "folder names compare without case");
});

test("a rule needs a condition and an action, one disposition, and a forward needs a narrowing condition", async () => {
  await withService(async (service) => {
    await assert.rejects(service.set({ name: "x", when: { folder: "INBOX" }, actions: { markRead: true } }), /at least one condition/);
    await assert.rejects(service.set({ name: "x", when: { from: ["a@b.c"] }, actions: {} }), /needs an action/);
    await assert.rejects(service.set({ name: "x", when: { from: ["a@b.c"] }, actions: { archive: true, trash: true } }), /only one of/);
    await assert.rejects(service.set({ name: "x", when: { from: ["a@b.c"] }, actions: { bogus: true } }), /Unknown action/);
    await assert.rejects(service.set({ name: "x", when: { bogus: 1 } , actions: { markRead: true } }), /Unknown condition/);
    await assert.rejects(service.set({ name: "x", when: { unread: true }, actions: { forwardTo: ["me@example.com"] } }), /condition on the sender, the subject or an attachment/);
    await assert.rejects(service.set({ name: "x", when: { from: ["a@b.c"] }, actions: { forwardTo: ["not an address"] } }), /invalid address/);
    await assert.rejects(service.set({ name: "x", when: { from: ["a@b.c"] }, actions: { forwardTo: ["1@b.c", "2@b.c", "3@b.c", "4@b.c"] } }), /1 to 3/);
    await assert.rejects(service.set({ when: { from: ["a@b.c"] }, actions: { markRead: true } }), /needs a name/);
    const rule = await service.set({ name: "boss to phone", when: { from: ["boss@example.com"] }, actions: { forwardTo: ["me@elsewhere.example"], markRead: false } }, NOW);
    assert.equal(rule.enabled, true);
    assert.equal(rule.activatedAt, new Date(NOW).toISOString());
    const off = await service.set({ id: rule.id, enabled: false }, NOW + 1000);
    assert.equal(off.activatedAt, rule.activatedAt);
    const on = await service.set({ id: rule.id, enabled: true }, NOW + 5000);
    assert.equal(on.activatedAt, new Date(NOW + 5000).toISOString(), "switching on restarts 'only mail from now on'");
    await assert.rejects(service.set({ id: "nope", enabled: true }), /No rule with id/);
  });
});

test("planning merges rules per message; the first one that moves or removes a message decides", () => {
  const rules = [
    { id: "r1", name: "label", enabled: true, when: { from: ["a@b.c"] }, actions: { label: "Clients", markRead: true }, createdAt: "", activatedAt: ago(10) },
    { id: "r2", name: "archive", enabled: true, when: { from: ["a@b.c"] }, actions: { archive: true }, createdAt: "", activatedAt: ago(10) },
    { id: "r3", name: "trash", enabled: true, when: { from: ["a@b.c"] }, actions: { trash: true }, createdAt: "", activatedAt: ago(10) },
    { id: "r4", name: "off", enabled: false, when: { from: ["a@b.c"] }, actions: { moveTo: "Elsewhere" }, createdAt: "" },
  ];
  const m = mail({ from: [{ address: "a@b.c" }] });
  const [change] = planChanges(rules, [m], NOW);
  assert.deepEqual(change.rules.map((r) => r.id), ["r1", "r2", "r3"]);
  assert.equal(change.markRead, true);
  assert.deepEqual(change.label, ["Clients"]);
  assert.equal(change.disposition.kind, "archive", "the first disposition wins");
  // Automatically: rules that trash never run by themselves.
  const [auto] = planChanges(rules, [m], NOW, { automatic: true });
  assert.deepEqual(auto.rules.map((r) => r.id), ["r1", "r2"]);
  assert.equal(runsAutomatically({ trash: true }), false);
  assert.equal(runsAutomatically({ delete: true }), false);
  assert.equal(runsAutomatically({ archive: true, markRead: true }), true);
  // Automatically: only mail that arrived after the rule was switched on, and not twice.
  assert.equal(planChanges(rules, [mail({ from: [{ address: "a@b.c" }], internalDate: ago(30) })], NOW, { automatic: true }).length, 0);
  assert.equal(planChanges(rules, [m], NOW, { automatic: true, handled: { r1: [m.messageId], r2: [m.messageId] } }).length, 0);
  // Your own address is never touched.
  assert.equal(planChanges(rules, [m], NOW, { ownAddresses: ["A@B.C"] }).length, 0);
});

test("forwarding goes only to mail from people (or when the rule asks for automated mail), and only mail after switching on", () => {
  const rule = { id: "f", name: "fwd", enabled: true, when: { from: ["*@client.example"] }, actions: { forwardTo: ["me@elsewhere.example"], forwardNote: "FYI" }, createdAt: "", activatedAt: ago(1) };
  const person = mail({ from: [{ address: "pat@client.example" }], internalDate: ago(0.5) });
  const list = mail({ from: [{ address: "news@client.example" }], isAutomated: true, internalDate: ago(0.5) });
  const old = mail({ from: [{ address: "pat@client.example" }], internalDate: ago(5) });
  const plan = planChanges([rule], [person, list, old], NOW);
  const forwarded = plan.filter((change) => change.forwardTo.length).map((change) => change.email.id);
  assert.deepEqual(forwarded, [person.id]);
  assert.equal(plan.find((change) => change.email.id === person.id).forwardTo[0].note, "FYI");
  const withAutomated = planChanges([{ ...rule, when: { ...rule.when, automated: true } }], [list], NOW);
  assert.equal(withAutomated[0].forwardTo.length, 1, "the rule says it wants automated mail");
});

test("the scan proposes archiving unopened newsletters, filing habits and cleaning old Trash, and nothing for too little evidence", () => {
  const newsletter = Array.from({ length: 8 }, (_, i) => mail({ from: [{ address: "weekly@news.example" }], subject: `Issue ${i}`, isAutomated: true, isRead: false, internalDate: ago(10 + i * 8) }));
  const habit = Array.from({ length: 6 }, () => mail({ from: [{ address: "carol@work.example" }], folder: "Projects", isRead: true }));
  const few = Array.from({ length: 2 }, () => mail({ from: [{ address: "rare@x.example" }], isAutomated: true }));
  const trash = Array.from({ length: 25 }, () => mail({ folder: "Trash", internalDate: ago(60), from: [{ address: "x@y.z" }] }));
  const proposals = suggestRules([...newsletter, ...habit, ...few, ...trash], [], [], { now: NOW });
  const kinds = proposals.map((p) => p.kind).sort();
  assert.deepEqual(kinds, ["newsletter-archive", "newsletter-cleanup", "sender-folder", "trash-cleanup"]);
  const archive = proposals.find((p) => p.kind === "newsletter-archive");
  assert.deepEqual(archive.rule.actions, { markRead: true, archive: true });
  assert.equal(archive.risk, "low");
  assert.equal(archive.evidence.messages, 8);
  assert.equal(archive.evidence.unreadPercent, 100);
  assert.ok(archive.evidence.examples.length > 0);
  assert.equal(proposals.find((p) => p.kind === "newsletter-cleanup").risk, "recoverable");
  assert.equal(proposals.find((p) => p.kind === "trash-cleanup").risk, "permanent");
  assert.deepEqual(proposals.find((p) => p.kind === "sender-folder").rule, { name: "carol@work.example to Projects", when: { from: ["carol@work.example"], automated: false }, actions: { moveTo: "Projects" } });
  assert.ok(!proposals.some((p) => p.rule.when.from?.includes("rare@x.example")), "two messages are not a pattern");
  // Not proposed again once dismissed, nor when the rule already exists.
  const dismissed = suggestRules([...newsletter], [], [archive.id], { now: NOW });
  assert.ok(!dismissed.some((p) => p.id === archive.id));
  const existing = suggestRules([...newsletter], [{ ...archive.rule, id: "r", enabled: true, createdAt: "" }], [], { now: NOW });
  assert.ok(!existing.some((p) => p.id === archive.id));
  assert.equal(proposalId(archive.rule), archive.id, "the id follows the rule, so it is stable between scans");
});

test("accepting a proposal makes a rule and clears it; dismissing remembers it; the day's forwards are capped", async () => {
  await withService(async (service) => {
    const newsletter = Array.from({ length: 6 }, () => mail({ from: [{ address: "weekly@news.example" }], isAutomated: true, internalDate: ago(5) }));
    const found = await service.suggest(newsletter, { now: NOW });
    assert.equal(found.length, 1);
    assert.equal((await service.get()).proposals.length, 1, "kept for later");
    const rule = await service.set({ ...found[0].rule, source: found[0].id }, NOW);
    assert.equal(rule.source, found[0].id);
    assert.equal((await service.get()).proposals.length, 0);
    assert.deepEqual(await service.suggest(newsletter, { now: NOW }), [], "already a rule");
    assert.deepEqual(await service.remove(rule.id), { removed: "rule" });
    const again = await service.suggest(newsletter, { now: NOW });
    assert.deepEqual(await service.remove(again[0].id), { removed: "proposal" });
    assert.deepEqual(await service.suggest(newsletter, { now: NOW }), [], "dismissed for good");
    assert.deepEqual(await service.remove("nothing"), { removed: "none" });
    assert.equal(await service.reserveForwards(30, NOW), 30);
    assert.equal(await service.reserveForwards(30, NOW), 20, "50 a day");
    assert.equal(await service.reserveForwards(5, NOW), 0);
    assert.equal(await service.reserveForwards(5, NOW + DAY), 5, "a new day");
  });
});

test("a forward is claimed once per rule and message, even when two services ask at the same time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rules-claim-"));
  try {
    const a = new RulesService({ dataDir: dir });
    const b = new RulesService({ dataDir: dir });
    const results = await Promise.all([a.claimForward("r1", "<m@x>"), b.claimForward("r1", "<m@x>"), a.claimForward("r1", "<m@x>"), b.claimForward("r1", "<m@x>")]);
    assert.equal(results.filter((r) => r === "claimed").length, 1, JSON.stringify(results));
    assert.equal(results.filter((r) => r === "duplicate").length, 3);
    assert.equal(await a.claimForward("r2", "<m@x>"), "claimed", "another rule may forward the same message");
    assert.equal(await a.forwardsToday(), 2, "each claim counts against the day");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
