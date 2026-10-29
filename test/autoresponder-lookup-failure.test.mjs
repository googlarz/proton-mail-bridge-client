import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoresponderService, replySubject } from "../dist/services/autoresponder-service.js";
import { buildProfile } from "../dist/utils/style-profile.js";

const OWN = ["owner@example.com"];
const NOW = Date.parse("2026-12-24T12:00:00Z");
const ENABLED_AT = Date.parse("2026-12-24T10:00:00Z");
const EN = "Hello, could you please have a look at the attached file and tell me what you think of the plan for this week?";

function mail(overrides = {}) {
  return {
    id: "INBOX::1", folder: "INBOX", uid: 1, seq: 1, messageId: "<m1@x>", subject: "Question", references: [],
    from: [{ address: "alice@example.com", name: "Alice Kowalska" }], to: [{ address: "owner@example.com" }], cc: [], bcc: [], replyTo: [],
    date: "2026-12-24T11:00:00Z", internalDate: "2026-12-24T11:00:00Z", isRead: false, isStarred: false, flags: [],
    hasAttachments: false, attachments: [], labels: [], isAutomated: false, ...overrides,
  };
}

async function withService(fn) {
  const dir = await mkdtemp(join(tmpdir(), "autoresponder-lookup-"));
  const service = new AutoresponderService({ dataDir: dir });
  try { await fn(service); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

const collect = () => {
  const sent = [];
  const drafted = [];
  return { sent, drafted, deps: { send: async (r) => { sent.push(r); }, draft: async (r) => { drafted.push(r); } } };
};
const boom = async () => { throw new Error("contacts unavailable"); };

test("a failing tag lookup does not turn a skip rule into the default reply; the message is retried later", async () => {
  await withService(async (service) => {
    await service.set({ enabled: true, body: "Away.", rules: [{ name: "vip", from: ["tag:vip"], action: "skip" }] }, ENABLED_AT);
    const first = collect();
    first.deps.contactTags = boom;
    const outcome = await service.process([mail()], OWN, first.deps, NOW);
    assert.deepEqual([first.sent.length, first.drafted.length], [0, 0]);
    assert.deepEqual(outcome.skipped, [{ id: "INBOX::1", reason: "lookup-failed" }]);

    // Not marked as dealt with: the next sync, with the lookup working, decides it properly.
    const second = collect();
    second.deps.contactTags = async () => ["vip"];
    const again = await service.process([mail()], OWN, second.deps, NOW);
    assert.deepEqual(again.skipped, [{ id: "INBOX::1", reason: "rule-skip" }]);
    assert.equal(second.sent.length, 0);
  });
  await withService(async (service) => {
    await service.set({ enabled: true, body: "Away.", rules: [{ name: "vip", from: ["tag:vip"], action: "skip" }] }, ENABLED_AT);
    const ok = collect();
    ok.deps.contactTags = async () => [];
    await service.process([mail()], OWN, ok.deps, NOW);
    assert.equal(ok.sent.length, 1, "a working lookup that finds no tag still gets the default reply");
  });
});

test("a failing known-contact lookup fails closed for rules that ask about it", async () => {
  for (const known of ["yes", "no"]) {
    await withService(async (service) => {
      await service.set({ enabled: true, body: "Away.", rules: [{ name: "k", known, action: "skip" }] }, ENABLED_AT);
      const { sent, drafted, deps } = collect();
      deps.isKnownContact = boom;
      const outcome = await service.process([mail()], OWN, deps, NOW);
      assert.deepEqual([sent.length, drafted.length], [0, 0], known);
      assert.deepEqual(outcome.skipped, [{ id: "INBOX::1", reason: "lookup-failed" }], known);
    });
  }
});

test("a failed lookup changes nothing for rules that do not depend on it", async () => {
  await withService(async (service) => {
    await service.set({
      enabled: true, body: "Away.",
      rules: [
        { name: "other subject", from: ["tag:vip"], subjectContains: ["invoice"], action: "skip" },
        { name: "alice", from: ["tag:vip", "alice@example.com"], action: "reply", body: "Hi from rule." },
        { name: "late", known: "no", action: "skip" },
      ],
    }, ENABLED_AT);
    const { sent, deps } = collect();
    deps.contactTags = boom;
    deps.isKnownContact = boom;
    await service.process([mail()], OWN, deps, NOW);
    // The first cannot match whatever the lookup says, the second matches for certain (by address) and decides before the last.
    assert.deepEqual(sent.map((r) => [r.rule, r.body]), [["alice", "Hi from rule."]]);
  });
  await withService(async (service) => {
    await service.set({ enabled: true, body: "Away.", rules: [{ name: "vip", from: ["tag:vip"], action: "skip" }] }, ENABLED_AT);
    const { sent, deps } = collect();
    // No lookup wired up at all (not a failure): as before, the rule does not match.
    await service.process([mail()], OWN, deps, NOW);
    assert.equal(sent.length, 1);
  });
});

test("a sender's display name cannot rewrite the greeting through $ replacement patterns", async () => {
  const profile = buildProfile([
    { to: ["pat@example.com"], text: "Hi Pat,\n\nThanks for the update, I will have a look at this and the plan.\n\nBest regards\nDawid" },
    { to: ["sam@example.com"], text: "Hi Sam,\n\nPlease see the file and tell me what you think of the plan.\n\nBest regards\nDawid" },
  ]);
  for (const name of ["$` Bob", "$& Bob", "$' Bob", "$$ Bob"]) {
    await withService(async (service) => {
      await service.set({ enabled: true, mode: "draft", body: "I am out of the office and will reply to you when I am back. Please call the office." }, ENABLED_AT);
      const { drafted, deps } = collect();
      deps.styleProfile = async () => profile;
      await service.process([mail({ from: [{ address: "bob@example.com", name }], preview: EN })], OWN, deps, NOW);
      assert.ok(drafted[0].body.startsWith(`Hi ${name.split(" ")[0]},\n\n`), `${name}: ${JSON.stringify(drafted[0].body.slice(0, 20))}`);
    });
  }
});

test("a failing 'already answered' lookup fails closed, and the message is retried when it works", async () => {
  await withService(async (service) => {
    await service.set({ enabled: true, body: "Away." }, ENABLED_AT);
    const first = collect();
    first.deps.hasAnsweredSince = boom;
    const outcome = await service.process([mail()], OWN, first.deps, NOW);
    assert.deepEqual([first.sent.length, first.drafted.length], [0, 0]);
    assert.deepEqual(outcome.skipped, [{ id: "INBOX::1", reason: "lookup-failed" }]);

    const second = collect();
    second.deps.hasAnsweredSince = async () => false;
    await service.process([mail()], OWN, second.deps, NOW);
    assert.equal(second.sent.length, 1, "not marked as dealt with, so the next sync answers it");
  });
  await withService(async (service) => {
    await service.set({ enabled: true, body: "Away.", skipIfAnswered: false }, ENABLED_AT);
    const { sent, deps } = collect();
    deps.hasAnsweredSince = boom;
    await service.process([mail()], OWN, deps, NOW);
    assert.equal(sent.length, 1, "a rule that does not ask is not affected");
  });
});

test("a subject taken from a message is never read as a replacement pattern", () => {
  for (const hostile of ["cost $& $1 $$ $` $'", "$&"]) {
    assert.equal(replySubject({ subject: "Re: {subject}" }, hostile), `Re: ${hostile}`);
    assert.equal(replySubject({ subject: "Re: {subject}" }, hostile, mail(), "en"), `Re: ${hostile}`);
  }
});
