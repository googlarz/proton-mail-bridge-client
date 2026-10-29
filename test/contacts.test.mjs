import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { ContactService } from "../dist/services/contact-service.js";
import { cleanContactText, normalizeContactAddress } from "../dist/utils/contact-text.js";
import { TAINT_GATED_TOOLS } from "../dist/utils/mail-security.js";
import { parseVcf } from "../dist/utils/vcard.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";
import { IGNORE_EN } from "./helpers/injection-samples.mjs";

const ENABLED_AT = Date.parse("2026-12-24T10:00:00Z");
const NOW = Date.parse("2026-12-24T12:00:00Z");

function runtime(overrides = {}) {
  return {
    readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false,
    autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30,
    confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false, allowFileDownloadDir: undefined,
    maxInlineBytes: 40960, opDelayMs: 0, sendDelaySeconds: 0, ...overrides,
  };
}

function account(address, dataDir, slug) {
  return {
    address, slug, dataDir,
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: address, password: "x" },
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: address, password: "x" },
  };
}

function email(id, folder, from, to, subject, date) {
  return {
    id: `${folder}::${id}`, folder, uid: id, seq: id, messageId: `<${folder}-${id}@example.com>`, subject,
    from: [from], to: [to], cc: [], bcc: [], replyTo: [], date, internalDate: date, isRead: true, isStarred: false,
    flags: [], preview: subject, hasAttachments: false, attachments: [], labels: [], isAutomated: false,
  };
}

async function seed(bundle, emails) {
  const folder = (path, specialUse) => ({ path, name: path, delimiter: "/", specialUse, listed: true, subscribed: true, flags: [], messages: 0, unseen: 0 });
  await bundle.localIndexService.recordSnapshot({
    syncedAt: new Date().toISOString(),
    folders: [folder("INBOX", "\\Inbox"), folder("Sent", "\\Sent")],
    folderListComplete: true,
    folderStats: [{ folder: "INBOX", fetched: 1, total: 1 }, { folder: "Sent", fetched: 1, total: 1 }],
    emails,
  });
}

// One server with one or two accounts, Bridge out of reach: everything comes from the seeded index.
async function withServer({ accounts: count = 1, readOnly = false } = {}, fn) {
  const dirs = [];
  for (let index = 0; index < count; index += 1) dirs.push(await mkdtemp(join(tmpdir(), `contacts-${index}-`)));
  const accounts = [account("owner@example.com", dirs[0], "owner")];
  if (count > 1) accounts.push(account("work@example.org", dirs[1], "work"));
  const config = {
    smtp: accounts[0].smtp, imap: accounts[0].imap, dataDir: dirs[0], debug: false, cacheEnabled: true, analyticsEnabled: true,
    autoSync: false, syncInterval: 5, runtime: runtime({ readOnly }), accounts,
  };
  const { server, accountManager } = createServer(config, { startBackgroundSync: false });
  for (const bundle of accountManager.all()) {
    bundle.imapService.getFolderStats = async () => { throw new Error("offline"); };
    bundle.imapService.collectEmailsForIndex = async () => { throw new Error("offline"); };
  }
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const raw = (name, args) => client.callTool({ name, arguments: args });
  const call = async (name, args) => {
    const result = await raw(name, args);
    assert.ok(!result.isError, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  try {
    await fn({ call, raw, accountManager, dirs });
  } finally {
    await client.close();
    await server.close();
    await closeTrackedIndexes();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const OWNER = { address: "owner@example.com", name: "Owner" };
const ANN_WORK = { address: "ann@acme.co.uk", name: "Ann Smith" };
const ANN_HOME = { address: "ann.smith@gmail.com", name: "Ann S." };

const annMail = () => [
  email(1, "INBOX", ANN_WORK, OWNER, "Quarterly numbers", "2026-09-01T09:00:00Z"),
  email(2, "INBOX", ANN_WORK, OWNER, "Re: Quarterly numbers", "2026-09-03T09:00:00Z"),
  email(3, "INBOX", ANN_HOME, OWNER, "Weekend", "2026-10-10T09:00:00Z"),
  email(4, "Sent", OWNER, ANN_WORK, "Re: Quarterly numbers", "2026-09-02T09:00:00Z"),
  // A different person whose address contains Ann's: must not be counted as hers.
  email(5, "INBOX", { address: "joann@acme.co.uk", name: "Jo" }, OWNER, "Hello", "2026-10-11T09:00:00Z"),
];

test("find_contact returns one identity, merge joins two addresses and unmerge splits them again", async () => {
  await withServer({}, async ({ call, accountManager }) => {
    await seed(accountManager.primary(), annMail());

    const before = await call("find_contact", { query: "smith" });
    assert.equal(before.contacts.length, 2, "two addresses, not merged yet: two people");

    const work = (await call("find_contact", { query: "ann@acme.co.uk" })).contacts;
    assert.equal(work.length, 1);
    assert.deepEqual(work[0].messages, { fromThem: 2, toThem: 1 }, "joann@ is not ann@");
    assert.equal(work[0].youHaveWritten, true);
    assert.equal(work[0].name, "Ann Smith");
    assert.match(work[0].nameSource, /untrusted/);
    assert.deepEqual(work[0].org, { name: "acme", domain: "acme.co.uk", source: "domain" });
    assert.equal(work[0].firstContactAt, "2026-09-01T09:00:00Z");
    assert.equal(work[0].lastContactAt, "2026-09-03T09:00:00Z");
    assert.equal(work[0].lastSubjects[0].subject, "Re: Quarterly numbers");

    const merged = await call("set_contact", { address: "ann@acme.co.uk", mergeWith: "Ann.Smith@gmail.com", addTags: ["VIP"], displayName: "Ann Smith" });
    assert.deepEqual(merged.contact.addresses, ["ann@acme.co.uk", "ann.smith@gmail.com"]);
    assert.deepEqual(merged.contact.tags, ["vip"]);

    const one = (await call("find_contact", { query: "ann" })).contacts.filter((c) => c.addresses.includes("ann@acme.co.uk"));
    assert.equal(one.length, 1);
    assert.deepEqual(one[0].addresses, ["ann@acme.co.uk", "ann.smith@gmail.com"]);
    assert.deepEqual(one[0].messages, { fromThem: 3, toThem: 1 });
    assert.equal(one[0].lastContactAt, "2026-10-10T09:00:00Z");
    assert.equal(one[0].nameSource, "saved");
    assert.deepEqual(one[0].tags, ["vip"]);
    assert.equal((await call("find_contact", { query: "ann.smith@gmail.com" })).contacts[0].contactId, merged.contact.id, "either address finds the person");

    const split = await call("set_contact", { address: "ann.smith@gmail.com", unmerge: true });
    assert.deepEqual(split.splitFrom.addresses, ["ann@acme.co.uk"]);
    assert.deepEqual(split.splitFrom.tags, ["vip"], "what was set stays with the remaining address");
    const home = (await call("find_contact", { query: "ann.smith@gmail.com" })).contacts[0];
    assert.deepEqual(home.addresses, ["ann.smith@gmail.com"]);
    assert.deepEqual(home.tags, []);
    assert.equal(home.org, null, "a freemail domain is not an organisation");
  });
});

test("the store keeps only what was set, refuses bad input, and survives a corrupt file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "contact-store-"));
  try {
    const store = new ContactService({ dataDir: dir, smtp: { username: "owner@example.com" } });
    await store.update("pat@example.com", { addTags: ["vip"], notes: "Met at the fair" });
    const cleared = await store.update("pat@example.com", { removeTags: ["vip"], notes: null });
    assert.equal(cleared.contact, undefined, "nothing left to say: the record is gone");
    assert.deepEqual(await store.list(), []);
    await assert.rejects(store.update("not an address", { addTags: ["vip"] }), /e-mail address/);
    await assert.rejects(store.update("pat@example.com", { addTags: ["has space"] }), /not a tag/);
    await assert.rejects(store.update("pat@example.com", { unmerge: true }), /not merged/);
    await assert.rejects(store.update("pat@example.com", { unmerge: true, addTags: ["vip"] }), /on its own/);
    await assert.rejects(store.update("pat@example.com", { mergeWith: "PAT@example.com" }), /another address/);
    // Merging two stored people combines their tags and notes and leaves one record.
    await store.update("a@x.example", { addTags: ["vip"], notes: "one" });
    await store.update("b@x.example", { addTags: ["client"], notes: "two" });
    const both = await store.update("a@x.example", { mergeWith: "b@x.example" });
    assert.deepEqual(both.contact.tags, ["vip", "client"]);
    assert.equal(both.contact.notes, "one\n\ntwo");
    assert.equal((await store.list()).length, 1);
    assert.deepEqual(await store.tagsFor("B@x.example"), ["vip", "client"]);

    await writeFile(join(dir, "contacts.json"), "{ not json");
    assert.deepEqual(await new ContactService({ dataDir: dir, smtp: { username: "owner@example.com" } }).list(), []);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("the vip tag reaches the autoresponder's rules; without a tagged contact nothing changes", async () => {
  await withServer({}, async ({ accountManager }) => {
    const bundle = accountManager.primary();
    await bundle.autoresponderService.set({ enabled: true, body: "Away.", rules: [{ name: "vip", from: ["tag:vip"], action: "reply", body: "Hi {senderFirstName}, call my mobile." }] }, ENABLED_AT);
    const mail = (id, from) => ({ ...email(id, "INBOX", from, OWNER, "Question", `2026-12-24T11:00:0${id}Z`), messageId: `<m${id}@x>`, references: [] });
    // preview records nothing, so the same senders can be judged twice; the deps are the bundle's own, with its contact lookup.
    const run = async (mails) => {
      const deps = { ...bundle.autoresponderDeps(), hasAnsweredSince: async () => false };
      const decisions = await bundle.autoresponderService.preview(mails, bundle.ownAddresses, deps, NOW);
      return Object.fromEntries(decisions.map((decision) => [decision.from, decision.reply?.body]));
    };

    assert.deepEqual(await run([mail(1, ANN_WORK), mail(2, { address: "dana@example.org", name: "Dana" })]), {
      "ann@acme.co.uk": "Away.",
      "dana@example.org": "Away.",
    }, "no one tagged: every sender gets the default text, as before");

    await bundle.contactService.update("ann@acme.co.uk", { addTags: ["vip"] });
    assert.deepEqual(await run([mail(3, ANN_WORK), mail(4, { address: "dana@example.org", name: "Dana" })]), {
      "ann@acme.co.uk": "Hi Ann, call my mobile.",
      "dana@example.org": "Away.",
    });
  });
});

const GOOD_VCF = [
  "BEGIN:VCARD", "VERSION:3.0", "FN:Zoë Nowak", "N:Nowak;Zoë;;;", "item1.EMAIL;TYPE=work:zoe@nowak.example", "EMAIL;TYPE=home:Zoe.Nowak@gmail.com",
  "ORG:Nowak\\, Sp. z o.o.;Sales", "NOTE:Prefers calls\\nafter 10", "CATEGORIES:vip,friends", "END:VCARD",
  "BEGIN:VCARD", "VERSION:2.1", "N:Lang;Max", "EMAIL;INTERNET:max@lang.example", "NOTE;ENCODING=QUOTED-PRINTABLE:Gr=C3=BC=C3=9Fe aus=", " M=C3=BCnchen", "END:VCARD",
  "BEGIN:VCARD", "VERSION:4.0", "FN:Folded", "  Name", "EMAIL:folded@example.com", "END:VCARD",
  "BEGIN:VCARD", "FN:No address", "END:VCARD",
  "BEGIN:VCARD", "FN:Me", "EMAIL:work@example.org", "END:VCARD",
].join("\r\n");

test("parseVcf reads names, addresses, org and note across vCard versions", () => {
  const { cards, skipped } = parseVcf(GOOD_VCF);
  assert.equal(skipped, 1);
  assert.deepEqual(cards[0], { name: "Zoë Nowak", emails: ["zoe@nowak.example", "zoe.nowak@gmail.com"], org: "Nowak, Sp. z o.o.", note: "Prefers calls\nafter 10" });
  assert.deepEqual(cards[1], { name: "Max Lang", emails: ["max@lang.example"], note: "Grüße aus München" });
  assert.equal(cards[2].name, "Folded Name");
});

test("import_contacts imports a vCard file, never tags from it, and two accounts do not mix", async () => {
  await withServer({ accounts: 2 }, async ({ call, raw, accountManager, dirs }) => {
    const file = join(dirs[0], "people.vcf");
    await writeFile(file, GOOD_VCF);
    const outcome = await call("import_contacts", { path: file, account: "work" });
    assert.equal(outcome.account, "work@example.org");
    assert.equal(outcome.added, 3, "Zoë, Max, Folded; the account's own address and the card without one are not imported");
    assert.equal(outcome.withoutAddress, 1);

    const zoe = await call("find_contact", { query: "zoe nowak", account: "work" });
    assert.equal(zoe.contacts.length, 1);
    assert.deepEqual(zoe.contacts[0].addresses, ["zoe@nowak.example", "zoe.nowak@gmail.com"]);
    assert.deepEqual(zoe.contacts[0].tags, [], "CATEGORIES:vip is not read as a tag");
    assert.deepEqual(zoe.contacts[0].org, { name: "Nowak, Sp. z o.o.", source: "saved" });

    // The primary account has its own, empty store; a tag set there does not appear on the other account.
    assert.deepEqual((await call("find_contact", { query: "zoe nowak", account: "owner" })).contacts, []);
    await call("set_contact", { address: "zoe@nowak.example", addTags: ["vip"], account: "owner" });
    assert.deepEqual((await call("find_contact", { query: "zoe@nowak.example", account: "work" })).contacts[0].tags, []);
    const [primary, work] = accountManager.all();
    assert.deepEqual(await primary.contactService.tagsFor("zoe@nowak.example"), ["vip"]);
    assert.deepEqual(await work.contactService.tagsFor("zoe@nowak.example"), []);
    assert.equal((await primary.contactService.list()).length, 1);
    assert.equal((await work.contactService.list()).length, 3);
    assert.ok((await readFile(join(dirs[1], "contacts.json"), "utf8")).includes("max@lang.example"));
    assert.ok(!(await readFile(join(dirs[0], "contacts.json"), "utf8")).includes("max@lang.example"));

    // Importing again changes nothing.
    const again = await call("import_contacts", { path: file, account: "work" });
    assert.equal(again.added, 0);
    assert.equal(again.unchanged, 3);
    // Not a .vcf, or a relative path: refused before anything is read.
    for (const path of [join(dirs[0], "contacts.json"), "people.vcf"]) {
      const refused = await raw("import_contacts", { path });
      assert.equal(refused.isError, true, path);
    }
  });
});

test("a hostile vCard file: too large, too many cards, a name that reads as an instruction, a FIFO", async () => {
  await withServer({}, async ({ call, raw, accountManager, dirs }) => {
    const huge = join(dirs[0], "huge.vcf");
    await writeFile(huge, Buffer.alloc(5 * 1024 * 1024 + 1, "A"));
    const tooLarge = await raw("import_contacts", { path: huge });
    assert.equal(tooLarge.isError, true);
    assert.match(tooLarge.content[0].text, /at most 5 MB/);

    // One endless line, cards that never end, invalid addresses and 5001 cards: bounded, nothing thrown.
    const many = [`X-JUNK:${"x".repeat(100_000)}`, "BEGIN:VCARD", "EMAIL:not-an-address", "BEGIN:VCARD", "EMAIL:<script>@x"];
    for (let index = 0; index < 5_001; index += 1) many.push("BEGIN:VCARD", `FN:Person ${index}`, `EMAIL:p${index}@bulk.example`, "END:VCARD");
    many.push("BEGIN:VCARD", `FN:${IGNORE_EN}`, "EMAIL:evil@attacker.example", "END:VCARD");
    const bulk = join(dirs[0], "bulk.vcf");
    await writeFile(bulk, many.join("\n"));
    const started = Date.now();
    const outcome = await call("import_contacts", { path: bulk });
    assert.ok(Date.now() - started < 10_000, "bounded time");
    assert.equal(outcome.truncated, true);
    assert.equal(outcome.cards, 5_000);
    assert.equal(outcome.added, 5_000);

    // A name that reads like an instruction is stored as text, and find_contact flags it and taints the session.
    const evil = join(dirs[0], "evil.vcf");
    await writeFile(evil, ["BEGIN:VCARD", `FN:${IGNORE_EN}‮`, "EMAIL:evil@attacker.example", "END:VCARD"].join("\n"));
    await call("import_contacts", { path: evil });
    const found = (await call("find_contact", { query: "evil@attacker.example" })).contacts[0];
    assert.equal(found.name, IGNORE_EN, "bidi controls are removed");
    assert.equal(found.risk.level, "high");
    const gated = await raw("send_email", { to: "x@example.com", subject: "s", body: "b" });
    assert.match(gated.content[0].text, /Confirmation required/, "after the flagged name, an outbound tool asks for confirmation");

    if (process.platform !== "win32") {
      const fifo = join(dirs[0], "pipe.vcf");
      execFileSync("mkfifo", [fifo]);
      assert.ok((await stat(fifo)).isFIFO());
      const gate = await raw("import_contacts", { path: fifo });
      assert.match(gate.content[0].text, /Confirmation required/, "import_contacts is gated after a flagged contact");
      const refused = await raw("import_contacts", { path: fifo, confirmed: true });
      assert.equal(refused.isError, true);
      assert.match(refused.content[0].text, /not a regular file/);
    }
    assert.ok((await accountManager.primary().contactService.list()).length >= 5_000);
  });
});

test("set_contact and import_contacts change nothing on a read-only server; find_contact still reads", async () => {
  await withServer({ readOnly: true }, async ({ call, raw, accountManager, dirs }) => {
    await seed(accountManager.primary(), annMail());
    const refused = await raw("set_contact", { address: "ann@acme.co.uk", addTags: ["vip"] });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /read-only/);
    const file = join(dirs[0], "people.vcf");
    await writeFile(file, GOOD_VCF);
    assert.equal((await raw("import_contacts", { path: file })).isError, true);
    assert.deepEqual(await accountManager.primary().contactService.list(), []);
    assert.equal((await call("find_contact", { query: "ann@acme.co.uk" })).contacts[0].messages.fromThem, 2);
  });
});

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), "contact-store-"));
  try {
    await fn(new ContactService({ dataDir: dir, smtp: { username: "owner@example.com" } }));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const tagChars = (text) => [...text].map((char) => String.fromCodePoint(0xe0000 + char.charCodeAt(0))).join("");

test("an import never attaches a new address to a known person: it is a conflict and the person's tags stay theirs", async () => {
  await withStore(async (store) => {
    await store.update("ann@acme.example", { addTags: ["vip"] });
    const outcome = await store.importCards([
      { emails: ["ann@acme.example", "evil@attacker.example"], name: "Ann" },
      { emails: ["other@attacker.example"] },
    ]);
    assert.deepEqual(await store.tagsFor("evil@attacker.example"), [], "the attacker's address does not get the vip tag");
    assert.deepEqual((await store.list()).find((record) => record.tags?.includes("vip")).addresses, ["ann@acme.example"]);
    assert.deepEqual(outcome.conflicts, ["evil@attacker.example"]);
    assert.equal(outcome.conflictCount, 1);
    assert.deepEqual(await store.tagsFor("other@attacker.example"), [], "an unknown card still becomes its own person, without tags");
    // Merging stays an explicit set_contact action.
    await store.update("ann@acme.example", { mergeWith: "evil@attacker.example" });
    assert.deepEqual(await store.tagsFor("evil@attacker.example"), ["vip"]);
  });
});

test("import_contacts is confirmation-gated after a high-risk message, and a card cannot set tags", async () => {
  assert.ok(TAINT_GATED_TOOLS.has("import_contacts"));
  assert.ok(TAINT_GATED_TOOLS.has("set_contact"));
  await withStore(async (store) => {
    const { cards } = parseVcf(["BEGIN:VCARD", "FN:Eve", "EMAIL:eve@x.example", "CATEGORIES:vip", "X-TAGS:vip", "TAGS:vip", "END:VCARD"].join("\r\n"));
    await store.importCards(cards);
    assert.deepEqual(await store.tagsFor("eve@x.example"), []);
    assert.equal((await store.list())[0].tags, undefined);
  });
});

test("cleanContactText removes invisible characters that can smuggle text or fill a name", () => {
  assert.equal(cleanContactText(`Ann${tagChars(IGNORE_EN)}`, 100), "Ann", "Unicode tag characters (an ASCII smuggling channel) are dropped");
  assert.equal(cleanContactText("A\u{E0100}n\uFE0Fn\u00ADa\u3164\u2800\u115F\u1160\uFFA0 B", 100), "Anna B");
  assert.equal(cleanContactText("Ann\u200B Lee\u202E", 100), "Ann Lee");
  assert.equal(cleanContactText("Zoë Nowak, Müller", 100), "Zoë Nowak, Müller", "ordinary accents and umlauts stay");
});

test("a hidden instruction in a displayName is not stored", async () => {
  await withStore(async (store) => {
    await store.update("hid@x.example", { displayName: `Hidden${tagChars(IGNORE_EN)}`, addTags: ["client"] });
    assert.equal((await store.list())[0].displayName, "Hidden");
  });
});

test("addresses are lowercased as ASCII only: the Kelvin sign does not become k", async () => {
  assert.equal(normalizeContactAddress("\u212A@x.com"), "\u212A@x.com", "kept as written, not folded into ASCII");
  assert.equal(normalizeContactAddress("K@X.COM"), "k@x.com");
  await withStore(async (store) => {
    await store.update("k@x.com", { addTags: ["vip"] });
    assert.deepEqual(await store.tagsFor("k@x.com"), ["vip"]);
    assert.deepEqual(await store.tagsFor("\u212A@x.com"), [], "the Kelvin-sign address does not receive the tags of k@x.com");
    assert.deepEqual(await store.tagsFor("K@X.com"), ["vip"], "plain ASCII case still folds");
  });
});
