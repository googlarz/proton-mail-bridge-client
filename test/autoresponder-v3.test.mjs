import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { AutoresponderService, renderText } from "../dist/services/autoresponder-service.js";
import { buildProfile, detectLanguage, greetingAndClosing } from "../dist/utils/style-profile.js";
import { slugifyAccountAddress } from "../dist/utils/helpers.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";

const OWN = ["owner@example.com"];
const NOW = Date.parse("2026-12-24T12:00:00Z");
const ENABLED_AT = Date.parse("2026-12-24T10:00:00Z");
const PL = "Dzień dobry, czy możemy się spotkać w przyszłym tygodniu? Nie wiem, jak to zrobić, ale proszę o odpowiedź.";
const DE = "Hallo, ich habe eine Frage zu der Rechnung und bitte um Antwort. Danke für die Hilfe, wir sind nicht sicher.";
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
  const dir = await mkdtemp(join(tmpdir(), "autoresponder-v3-"));
  const service = new AutoresponderService({ dataDir: dir });
  try { await fn(service); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

const collect = () => {
  const sent = [];
  const drafted = [];
  return { sent, drafted, deps: { send: async (r) => { sent.push(r); }, draft: async (r) => { drafted.push(r); } } };
};

test("the existing detector tells en, pl and de apart and says nothing when unsure", () => {
  assert.equal(detectLanguage(PL), "pl");
  assert.equal(detectLanguage(DE), "de");
  assert.equal(detectLanguage(EN), "en");
  assert.equal(detectLanguage("Lunch?"), undefined);
});

test("a message in Polish or German gets the text in that language, dates included; anything else the default", async () => {
  await withService(async (service) => {
    await service.set({
      enabled: true, body: "Away until {endsAt}.", endsAt: "2027-01-04T00:00:00Z", timezone: "UTC",
      bodies: { pl: "Jestem na urlopie do {endsAt}.", de: "Ich bin bis {endsAt} nicht da." },
      subjects: { pl: "Odpowiedź automatyczna: {subject}" },
    }, ENABLED_AT);
    const { sent, deps } = collect();
    await service.process([
      mail({ id: "pl", messageId: "<pl>", from: [{ address: "jan@example.pl" }], preview: PL, internalDate: "2026-12-24T11:00:01Z" }),
      mail({ id: "de", messageId: "<de>", from: [{ address: "hans@example.de" }], preview: DE, internalDate: "2026-12-24T11:00:02Z" }),
      mail({ id: "en", messageId: "<en>", from: [{ address: "pat@example.com" }], preview: EN, internalDate: "2026-12-24T11:00:03Z" }),
      mail({ id: "none", messageId: "<none>", from: [{ address: "kim@example.com" }], internalDate: "2026-12-24T11:00:04Z" }),
    ], OWN, deps, NOW);
    const by = Object.fromEntries(sent.map((r) => [r.to, r]));
    assert.equal(by["jan@example.pl"].body, "Jestem na urlopie do 4 stycznia 2027.");
    assert.equal(by["jan@example.pl"].subject, "Odpowiedź automatyczna: Question");
    assert.equal(by["hans@example.de"].body, "Ich bin bis 4. Januar 2027 nicht da.");
    assert.equal(by["hans@example.de"].subject, "Automatic reply: Question", "no German subject: the default");
    assert.equal(by["pat@example.com"].body, "Away until 4 January 2027.", "English has no text of its own: the default");
    assert.equal(by["kim@example.com"].body, "Away until 4 January 2027.", "language not known: the default");
    assert.equal(by["jan@example.pl"].headers["Auto-Submitted"], "auto-replied");
  });
});

test("a matching rule's own text wins over the language; a rule without text uses the language text", async () => {
  await withService(async (service) => {
    await service.set({
      enabled: true, body: "Away.", bodies: { pl: "Jestem na urlopie." },
      rules: [{ name: "boss", from: ["boss@example.pl"], action: "reply", body: "Call me." }, { name: "client", from: ["*@client.pl"], action: "reply" }],
    }, ENABLED_AT);
    const decisions = await service.preview([
      mail({ id: "b", messageId: "<b>", from: [{ address: "boss@example.pl" }], preview: PL }),
      mail({ id: "c", messageId: "<c>", from: [{ address: "ola@client.pl" }], preview: PL }),
    ], OWN, {}, NOW);
    const by = Object.fromEntries(decisions.map((d) => [d.id, d]));
    assert.deepEqual([by.b.reply.body, by.b.textFrom, by.b.language], ["Call me.", "rule", "pl"]);
    assert.deepEqual([by.c.reply.body, by.c.textFrom, by.c.rule], ["Jestem na urlopie.", "language", "client"]);
  });
});

test("only language texts, no default body: it can be switched on, and other mail gets no reply", async () => {
  await withService(async (service) => {
    await service.set({ enabled: true, bodies: { pl: "Jestem na urlopie." } }, ENABLED_AT);
    const { sent, deps } = collect();
    const outcome = await service.process([
      mail({ id: "pl", messageId: "<pl>", preview: PL, internalDate: "2026-12-24T11:00:01Z" }),
      mail({ id: "en", messageId: "<en>", from: [{ address: "pat@example.com" }], preview: EN, internalDate: "2026-12-24T11:00:02Z" }),
    ], OWN, deps, NOW);
    assert.deepEqual(sent.map((r) => r.body), ["Jestem na urlopie."]);
    assert.ok(outcome.skipped.some((entry) => entry.id === "en" && entry.reason === "no-text"));
  });
});

test("language texts are validated: known languages only, length limits, null and {} remove them", async () => {
  await withService(async (service) => {
    await assert.rejects(service.set({ bodies: { fr: "Bonjour" } }), /not a language that can be recognised; use en, pl, de/);
    await assert.rejects(service.set({ bodies: "pl" }), /object keyed by language code/);
    await assert.rejects(service.set({ bodies: ["x"] }), /object keyed by language code/);
    await assert.rejects(service.set({ bodies: { pl: 5 } }), /bodies\.pl must be text up to 4000/);
    await assert.rejects(service.set({ bodies: { pl: "x".repeat(4001) } }), /up to 4000/);
    await assert.rejects(service.set({ subjects: { de: "x".repeat(201) } }), /subjects\.de must be text up to 200/);
    const set = await service.set({ bodies: { PL: "  Cześć  ", de: "  " } });
    assert.deepEqual(set.bodies, { pl: "Cześć" }, "codes are lower-cased, texts trimmed, empty ones dropped");
    assert.equal((await service.set({ bodies: null })).bodies, undefined);
    await service.set({ bodies: { pl: "x" } });
    assert.equal((await service.set({ bodies: {} })).bodies, undefined);
    await assert.rejects(service.set({ enabled: true }), /Give a body/, "nothing to say: still refused");
  });
});

test("{returnDate} and {backupContact} are plain text, filled as written and never expanded further", async () => {
  const rule = { enabled: true, subject: "", body: "", replyEveryDays: 7, updatedAt: "", returnDate: "2027-01-04", backupContact: "Anna Nowak, anna@example.com" };
  const email = mail();
  assert.equal(renderText("Back {returnDate}. Urgent: {backupContact}.", rule, email), "Back 4 January 2027. Urgent: Anna Nowak, anna@example.com.");
  assert.equal(renderText("Wracam {returnDate}.", rule, email, "pl"), "Wracam 4 stycznia 2027.");
  assert.equal(renderText("{returnDate}", { ...rule, timezone: "America/Los_Angeles" }, email), "4 January 2027", "a plain date is not shifted by the time zone");
  assert.equal(renderText("Back {returnDate}.", { ...rule, returnDate: "after the holidays" }, email), "Back after the holidays.");
  assert.equal(renderText("{backupContact}", { ...rule, backupContact: "{subject} $& $1 {senderAddress}" }, email), "{subject} $& $1 {senderAddress}", "a value is never read as a template");
  assert.equal(renderText("[{returnDate}][{backupContact}]", { ...rule, returnDate: undefined, backupContact: undefined }, email), "[][]");

  await withService(async (service) => {
    await assert.rejects(service.set({ returnDate: "4 Jan\n2027" }), /returnDate must be one line of up to 100/);
    await assert.rejects(service.set({ returnDate: "x".repeat(101) }), /up to 100/);
    await assert.rejects(service.set({ returnDate: "2027-02-30" }), /not a real date/);
    await assert.rejects(service.set({ returnDate: "2027-13-01" }), /not a real date/);
    await assert.rejects(service.set({ backupContact: "Anna\r\nBcc: x@evil.example" }), /backupContact must be one line of up to 200/);
    await assert.rejects(service.set({ backupContact: "x".repeat(201) }), /up to 200/);
    const set = await service.set({ enabled: true, body: "Back {returnDate}, ask {backupContact}.", subject: "Away until {returnDate}", returnDate: " 2027-01-04 ", backupContact: " Anna " }, ENABLED_AT);
    assert.deepEqual([set.returnDate, set.backupContact], ["2027-01-04", "Anna"]);
    const { sent, deps } = collect();
    await service.process([mail()], OWN, deps, NOW);
    assert.equal(sent[0].body, "Back 4 January 2027, ask Anna.");
    assert.equal(sent[0].subject, "Away until 4 January 2027");
    assert.equal(sent[0].to, "alice@example.com", "the backup contact is only text: the reply goes to the sender alone");
    const cleared = await service.set({ returnDate: "", backupContact: "" });
    assert.deepEqual([cleared.returnDate, cleared.backupContact], [undefined, undefined]);
  });
});

const profile = buildProfile([
  { to: ["pat@example.com"], text: "Hi Pat,\n\nThanks for the update, I will have a look at this and the plan.\n\nBest regards\nDawid" },
  { to: ["sam@example.com"], text: "Hi Sam,\n\nPlease see the file and tell me what you think of the plan.\n\nBest regards\nDawid" },
  { to: ["jan@example.pl"], text: "Cześć Jan,\n\nDziękuję za wiadomość, nie wiem jeszcze, ale odpiszę.\n\nPozdrawiam\nDawid" },
]);

test("a draft opens and closes the way you do, in the reply's language; a sent reply is never changed", async () => {
  assert.deepEqual(greetingAndClosing(profile, "new@example.com", "en"), { greeting: "Hi {name},", closing: "Best regards" });
  assert.deepEqual(greetingAndClosing(profile, "new@example.com", "pl"), { greeting: "Cześć {name},", closing: "Pozdrawiam" });
  assert.deepEqual(greetingAndClosing(profile, "new@example.com", "de"), { greeting: undefined, closing: undefined }, "no German greeting: none");

  await withService(async (service) => {
    const enBody = "I am out of the office and will reply to you when I am back. For anything urgent please call the office.";
    await service.set({ enabled: true, mode: "draft", body: enBody, bodies: { pl: "Jestem na urlopie i odpiszę, gdy wrócę." } }, ENABLED_AT);
    const { sent, drafted, deps } = collect();
    deps.styleProfile = async () => profile;
    await service.process([
      mail({ id: "en", messageId: "<en>", from: [{ address: "kim@example.com", name: "Kim Lee" }], preview: EN, internalDate: "2026-12-24T11:00:01Z" }),
      mail({ id: "pl", messageId: "<pl>", from: [{ address: "ola@example.pl", name: "Ola Nowak" }], preview: PL, internalDate: "2026-12-24T11:00:02Z" }),
    ], OWN, deps, NOW);
    assert.equal(sent.length, 0);
    const by = Object.fromEntries(drafted.map((r) => [r.to, r]));
    assert.equal(by["kim@example.com"].body, `Hi Kim,\n\n${enBody}\n\nBest regards`);
    assert.equal(by["ola@example.pl"].body, "Cześć Ola,\n\nJestem na urlopie i odpiszę, gdy wrócę.\n\nPozdrawiam");
  });

  await withService(async (service) => {
    await service.set({ enabled: true, body: "I am out of the office and will reply to you when I am back. Please call the office." }, ENABLED_AT);
    const { sent, deps } = collect();
    deps.styleProfile = async () => profile;
    await service.process([mail({ preview: EN })], OWN, deps, NOW);
    assert.equal(sent[0].body, "I am out of the office and will reply to you when I am back. Please call the office.", "sent as written");
  });
});

test("a draft keeps its own greeting and closing, and without a profile (or with a broken one) it is left as written", async () => {
  const body = "Hi {senderFirstName},\n\nI am out of the office and will reply to you when I am back.\n\nThanks";
  for (const styleProfile of [undefined, async () => undefined, async () => { throw new Error("unreadable"); }, async () => ({ overall: { greetings: "x", closings: [{ text: "<script>" }] } }), async () => profile]) {
    await withService(async (service) => {
      await service.set({ enabled: true, mode: "draft", body }, ENABLED_AT);
      const { drafted, deps } = collect();
      if (styleProfile) deps.styleProfile = styleProfile;
      await service.process([mail({ preview: EN })], OWN, deps, NOW);
      assert.equal(drafted[0].body, "Hi Alice,\n\nI am out of the office and will reply to you when I am back.\n\nThanks");
    });
  }
  // A text whose language cannot be told gets nothing added: a greeting in the wrong language is worse than none.
  await withService(async (service) => {
    await service.set({ enabled: true, mode: "draft", body: "Away." }, ENABLED_AT);
    const { drafted, deps } = collect();
    deps.styleProfile = async () => profile;
    const decisions = await service.preview([mail({ preview: EN })], OWN, deps, NOW);
    assert.equal(decisions[0].styled, undefined);
    await service.process([mail({ preview: EN })], OWN, deps, NOW);
    assert.equal(drafted[0].body, "Away.");
  });
});

test("the safety checks still come first: language texts and style change nothing about who gets a reply", async () => {
  await withService(async (service) => {
    await service.set({ enabled: true, mode: "draft", body: "Away.", bodies: { pl: "Jestem na urlopie." } }, ENABLED_AT);
    const { sent, drafted, deps } = collect();
    deps.styleProfile = async () => profile;
    const outcome = await service.process([
      mail({ id: "list", messageId: "<list>", isAutomated: true, preview: PL, internalDate: "2026-12-24T11:00:01Z" }),
      mail({ id: "old", messageId: "<old>", preview: PL, internalDate: "2026-12-24T09:00:00Z" }),
      mail({ id: "noreply", messageId: "<noreply>", from: [{ address: "no-reply@example.pl" }], preview: PL, internalDate: "2026-12-24T11:00:02Z" }),
    ], OWN, deps, NOW);
    assert.deepEqual([sent.length, drafted.length], [0, 0]);
    assert.deepEqual(outcome.skipped.map((entry) => entry.reason).sort(), ["no-reply-sender", "not-human"]);
  });
});

function configFor(dir) {
  const address = "owner@example.com";
  const imap = { host: "127.0.0.1", port: 9, secure: false, username: address, password: "secret" };
  const smtp = { ...imap };
  return {
    smtp, imap, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address, slug: slugifyAccountAddress(address), imap, smtp, dataDir: dir }],
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX",
      autoSyncFull: false, autoSyncLimitPerFolder: 50, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: true,
      allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0, autoSync: false },
  };
}

test("preview_autoresponder shows the language and which text each message would get; set_autoresponder takes the new fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autoresponder-v3-tool-"));
  const { server, accountManager } = createServer(configFor(dir), { startBackgroundSync: false });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const text = (r) => r.content[0].text;
  try {
    const bundle = accountManager.primary();
    const recent = (offset) => new Date(Date.now() - 3_600_000 + offset).toISOString();
    await bundle.localIndexService.recordSnapshot({
      syncedAt: new Date().toISOString(),
      folders: [{ path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "\\Inbox", listed: true, subscribed: true, flags: [], messages: 2, unseen: 2 }],
      folderStats: [{ folder: "INBOX", fetched: 2, total: 2, strategy: "recent" }],
      emails: [
        mail({ id: "INBOX::1", uid: 1, messageId: "<p1@x>", from: [{ address: "jan@example.pl", name: "Jan" }], preview: PL, date: recent(0), internalDate: recent(0) }),
        mail({ id: "INBOX::2", uid: 2, seq: 2, messageId: "<p2@x>", from: [{ address: "pat@example.com", name: "Pat" }], preview: EN, date: recent(1), internalDate: recent(1) }),
      ],
    });
    const set = await client.callTool({ name: "set_autoresponder", arguments: { body: "Away until {returnDate}.", bodies: { pl: "Wracam {returnDate}, pilne: {backupContact}." }, returnDate: "2027-01-04", backupContact: "Anna" } });
    assert.ok(!set.isError, text(set));
    assert.deepEqual(JSON.parse(text(set)).rule.bodies, { pl: "Wracam {returnDate}, pilne: {backupContact}." });
    const bad = await client.callTool({ name: "set_autoresponder", arguments: { bodies: { xx: "?" } } });
    assert.equal(bad.isError, true);

    const preview = JSON.parse(text(await client.callTool({ name: "preview_autoresponder", arguments: {} })));
    const by = Object.fromEntries(preview.messages.map((m) => [m.from, m]));
    assert.deepEqual([by["jan@example.pl"].language, by["jan@example.pl"].textFrom, by["jan@example.pl"].replyBody], ["pl", "language", "Wracam 4 stycznia 2027, pilne: Anna."]);
    assert.deepEqual([by["pat@example.com"].language, by["pat@example.com"].textFrom, by["pat@example.com"].replyBody], ["en", "default", "Away until 4 January 2027."]);
    assert.equal(by["pat@example.com"].styled, false);
    assert.equal((await bundle.autoresponderService.get()).sentTotal, 0, "a preview sends nothing");
  } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
