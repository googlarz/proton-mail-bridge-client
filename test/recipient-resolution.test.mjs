import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { CORE_TOOL_NAMES, READER_TOOL_NAMES, TOOLS } from "../dist/tools/definitions.js";
import { editDistance, nameMatch } from "../dist/utils/recipient-match.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";

function runtime(overrides = {}) {
  return {
    readOnly: false, allowSend: true, allowRemoteDraftSync: false, allowedActions: [], startupSync: false,
    autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30,
    confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false, allowFileDownloadDir: undefined,
    maxInlineBytes: 40960, opDelayMs: 0, sendDelaySeconds: 0, ...overrides,
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

// One server, Bridge out of reach: the contact store and the seeded index are all there is.
async function withServer(fn) {
  const dir = await mkdtemp(join(tmpdir(), "recipients-"));
  const acct = {
    address: "owner@example.com", slug: "owner", dataDir: dir,
    imap: { host: "127.0.0.1", port: 9, secure: false, username: "owner@example.com", password: "x" },
    smtp: { host: "127.0.0.1", port: 9, secure: false, username: "owner@example.com", password: "x" },
  };
  const config = {
    smtp: acct.smtp, imap: acct.imap, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true,
    autoSync: false, syncInterval: 5, runtime: runtime(), accounts: [acct],
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
    await fn({ call, raw, accountManager });
  } finally {
    await client.close();
    await server.close();
    await closeTrackedIndexes();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const OWNER = { address: "owner@example.com", name: "Owner" };

async function person(call, address, fields) {
  return call("set_contact", { address, ...fields });
}

test("aliases are set, shown by find_contact, replaced, and cleared with an empty list", async () => {
  await withServer(async ({ call }) => {
    const set = await person(call, "maciek@example.com", { displayName: "Maciej Nowak", aliases: ["Maciek", " Maciuś ", "maciek"] });
    assert.deepEqual(set.contact.aliases, ["Maciek", "Maciuś"], "trimmed, and a case-insensitive duplicate within the list is dropped");
    const found = await call("find_contact", { query: "Maciuś" });
    assert.equal(found.contacts[0].name, "Maciej Nowak");
    assert.deepEqual(found.contacts[0].aliases, ["Maciek", "Maciuś"]);
    const replaced = await person(call, "maciek@example.com", { aliases: ["Maciejek"] });
    assert.deepEqual(replaced.contact.aliases, ["Maciejek"]);
    const cleared = await person(call, "maciek@example.com", { aliases: [] });
    assert.equal(cleared.contact.aliases, undefined);
    assert.equal((await call("find_contact", { query: "Maciuś" })).contacts.length, 0);
  });
});

test("aliases: at most 10, 1-40 characters, no address, and one person per alias across the store", async () => {
  await withServer(async ({ call, raw }) => {
    const refused = async (args, pattern) => {
      const result = await raw("set_contact", { address: "a@example.com", ...args });
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.match(result.content[0].text, pattern);
    };
    await refused({ aliases: Array.from({ length: 11 }, (_, index) => `alias${index}`) }, /at most 10 aliases/);
    assert.equal((await person(call, "a@example.com", { aliases: Array.from({ length: 10 }, (_, index) => `alias${index}`) })).contact.aliases.length, 10);
    await refused({ aliases: ["x".repeat(41)] }, /too long for an alias/);
    await refused({ aliases: ["   "] }, /cannot be empty/);
    await refused({ aliases: ["jan@example.com"] }, /not an alias/);
    await refused({ aliases: "Maciek" }, /list of names/);
    assert.equal((await person(call, "b@example.com", { aliases: ["x".repeat(40)] })).contact.aliases[0].length, 40);

    // The same alias for a second person, whatever its case or accents, is refused and names the first.
    await person(call, "kasia@example.com", { displayName: "Katarzyna Lis", aliases: ["Kasia"] });
    const clash = await raw("set_contact", { address: "kaska@example.com", aliases: ["KASIA"] });
    assert.equal(clash.isError, true);
    assert.match(clash.content[0].text, /already used by Katarzyna Lis \(kasia@example\.com\)/);
    const accents = await raw("set_contact", { address: "kaska@example.com", aliases: ["Kąsia"] });
    assert.equal(accents.isError, true);
    // The same person may set it again.
    assert.deepEqual((await person(call, "kasia@example.com", { aliases: ["Kasia", "Kasieńka"] })).contact.aliases, ["Kasia", "Kasieńka"]);
    // Nothing was stored for the refused person.
    assert.equal((await call("find_contact", { query: "kaska@example.com" })).contacts[0].aliases, undefined);
  });
});

test("set_contact with only aliases counts as a change, and aliases cannot ride along with unmerge", async () => {
  await withServer(async ({ call, raw }) => {
    await person(call, "a@example.com", { mergeWith: "b@example.com" });
    const result = await raw("set_contact", { address: "b@example.com", unmerge: true, aliases: ["B"] });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /unmerge is done on its own/);
    const none = await raw("set_contact", { address: "a@example.com" });
    assert.match(none.content[0].text, /pass displayName, notes, aliases/);
  });
});

test("resolve_recipient: an exact alias or name, case and diacritics ignored", async () => {
  await withServer(async ({ call }) => {
    await person(call, "lukasz@example.com", { displayName: "Łukasz Żółć", aliases: ["Łuki"] });
    const byAlias = await call("resolve_recipient", { query: "LUKI" });
    assert.equal(byAlias.candidates.length, 1);
    assert.deepEqual(
      { confidence: byAlias.candidates[0].confidence, matchedBy: byAlias.candidates[0].matchedBy, address: byAlias.candidates[0].address, nameSource: byAlias.candidates[0].nameSource },
      { confidence: "exact", matchedBy: "alias", address: "lukasz@example.com", nameSource: "saved" },
    );
    assert.equal(byAlias.needsChoice, false);
    assert.match(byAlias.note, /ask before using it/);
    const byName = await call("resolve_recipient", { query: "lukasz zolc" });
    assert.equal(byName.candidates[0].confidence, "exact");
    assert.equal(byName.candidates[0].matchedBy, "displayName");
    const byAddress = await call("resolve_recipient", { query: "Lukasz@Example.com" });
    assert.equal(byAddress.candidates[0].matchedBy, "address");
    assert.equal(byAddress.candidates[0].confidence, "exact");
  });
});

test("resolve_recipient: a Polish inflection finds the name or alias (Maćka -> Maciek), a short start is only possible", async () => {
  await withServer(async ({ call }) => {
    await person(call, "maciek@example.com", { displayName: "Maciej Nowak", aliases: ["Maciek"] });
    await person(call, "marek@example.com", { displayName: "Marek Zając" });
    const inflected = await call("resolve_recipient", { query: "Maćka" });
    assert.equal(inflected.candidates.length, 1, JSON.stringify(inflected));
    assert.equal(inflected.candidates[0].address, "maciek@example.com");
    assert.equal(inflected.candidates[0].confidence, "likely");
    assert.equal(inflected.candidates[0].matchedBy, "name-prefix");
    assert.equal(inflected.candidates[0].matchedText, "Maciek");
    assert.equal(inflected.needsChoice, false);
    assert.equal((await call("resolve_recipient", { query: "Marka" })).candidates[0].address, "marek@example.com");
    assert.equal((await call("resolve_recipient", { query: "Maciejowi" })).candidates[0].address, "maciek@example.com");
    const start = await call("resolve_recipient", { query: "Mac" });
    assert.equal(start.candidates[0].address, "maciek@example.com");
    assert.equal(start.candidates[0].confidence, "possible");
    assert.equal((await call("resolve_recipient", { query: "Ma" })).candidates.length, 0, "two letters say nothing");
  });
});

test("nameMatch states what it does and does not accept", () => {
  assert.equal(nameMatch("Maćka", "Maciek"), "inflection");
  assert.equal(nameMatch("Jana Kowalskiego", "Jan Kowalski"), "inflection");
  assert.equal(nameMatch("Kasię", "Kasia"), "inflection");
  assert.equal(nameMatch("Kowalski", "Jan Kowalski"), "word");
  assert.equal(nameMatch("jan kow", "Jan Kowalski"), "prefix");
  assert.equal(nameMatch("Tomek", "Maciek"), undefined);
  assert.equal(nameMatch("Anna", "Hanna"), undefined);
  assert.equal(nameMatch("Jan Jan", "Jan Kowalski"), undefined, "each query word needs its own word of the name");
  assert.equal(editDistance("kitten", "sitting", 2), 3);
  assert.equal(editDistance("abc", "abd", 2), 1);
  assert.equal(editDistance("abc", "abcdef", 2), 3);
});

test("resolve_recipient: more than one likely person needs a choice and nothing is picked", async () => {
  await withServer(async ({ call }) => {
    await person(call, "jan.k@example.com", { displayName: "Jan Kowalski" });
    await person(call, "jan.n@example.com", { displayName: "Jan Nowak" });
    await person(call, "janusz@example.com", { displayName: "Janusz Lis" });
    const result = await call("resolve_recipient", { query: "Jan" });
    assert.equal(result.needsChoice, true);
    assert.deepEqual(result.candidates.map((candidate) => candidate.confidence), ["likely", "likely", "possible"]);
    assert.deepEqual(new Set(result.candidates.map((candidate) => candidate.address)), new Set(["jan.k@example.com", "jan.n@example.com", "janusz@example.com"]));
    assert.equal((await call("resolve_recipient", { query: "Jan", limit: 1 })).candidates.length, 1);
    // Two people sharing an alias cannot exist, but a nickname can still be close to two names.
    assert.equal((await call("resolve_recipient", { query: "Kowalski" })).needsChoice, false);
  });
});

test("resolve_recipient: an address with a typo is matched against the store and the local index", async () => {
  await withServer(async ({ call, accountManager }) => {
    await person(call, "anna.kowalska@example.com", { displayName: "Anna Kowalska" });
    await seed(accountManager.primary(), [
      email(1, "INBOX", { address: "bob@company.example", name: "Bob Builder" }, OWNER, "Plans", "2026-12-20T10:00:00Z"),
    ]);
    const store = await call("resolve_recipient", { query: "anna.kowalksa@example.com" });
    assert.equal(store.candidates.length, 1);
    assert.deepEqual(
      { confidence: store.candidates[0].confidence, matchedBy: store.candidates[0].matchedBy, address: store.candidates[0].address },
      { confidence: "possible", matchedBy: "typo-of-address", address: "anna.kowalska@example.com" },
      "a swap is two edits",
    );
    const near = await call("resolve_recipient", { query: "anna.kowalska@exmple.com" });
    assert.equal(near.candidates[0].confidence, "likely");
    const index = await call("resolve_recipient", { query: "bob@compnay.example" });
    assert.equal(index.candidates[0].address, "bob@company.example");
    assert.equal(index.candidates[0].source, "local index");
    assert.equal(index.candidates[0].nameSource, "mail headers (untrusted)");
    assert.equal((await call("resolve_recipient", { query: "bob@company.example" })).candidates[0].confidence, "exact");
    assert.equal((await call("resolve_recipient", { query: "bob@example.net" })).candidates.length, 0, "more than two edits away");
    // Without an "@" no address is guessed at.
    assert.equal((await call("resolve_recipient", { query: "anna.kowalksa" })).candidates.length, 0);
  });
});

test("resolve_recipient: an unknown query is an empty list, not an error", async () => {
  await withServer(async ({ call }) => {
    const result = await call("resolve_recipient", { query: "Nobody At All" });
    assert.deepEqual(result.candidates, []);
    assert.equal(result.needsChoice, false);
    assert.match(result.note, /do not guess/);
  });
});

test("an invalid recipient fails with suggestions; a valid one is untouched and nothing is substituted", async () => {
  await withServer(async ({ call, raw }) => {
    await person(call, "maciek@example.com", { displayName: "Maciej Nowak", aliases: ["Maciek"] });
    const bad = await raw("create_draft", { to: "Maćka", subject: "Hi", body: "Hello" });
    assert.equal(bad.isError, true);
    const text = bad.content[0].text;
    assert.match(text, /^Invalid to email address\(es\): Maćka\./, "the original failure comes first, unchanged");
    assert.match(text, /"Maćka" -> "Maciej Nowak" <maciek@example\.com> \(name-prefix, likely\)/);
    assert.match(text, /nothing was substituted/);
    assert.match(text, /Ask the user/);

    // cc and the other send paths share the check.
    const cc = await raw("send_email", { to: "ok@example.com", cc: "Maćka", subject: "Hi", body: "Hello", confirmed: true });
    assert.equal(cc.isError, true);
    assert.match(cc.content[0].text, /Invalid cc email address\(es\): Maćka\..*maciek@example\.com/);

    // No match: the plain failure, as before.
    const unknown = await raw("create_draft", { to: "zzzzz", subject: "Hi", body: "Hello" });
    assert.equal(unknown.content[0].text, "Invalid to email address(es): zzzzz");

    // A typo that is still not an address gets the near address.
    await person(call, "anna@example.com", { displayName: "Anna" });
    const typo = await raw("create_draft", { to: "anna@@example.com", subject: "Hi", body: "Hello" });
    assert.match(typo.content[0].text, /anna@example\.com/);

    // A valid address never produces a suggestion and is not changed.
    const ok = await raw("create_draft", { to: "Maciek@example.com", subject: "Hi", body: "Hello" });
    assert.doesNotMatch(ok.content[0].text ?? "", /Invalid|Possible matches/);
    const stored = JSON.parse(ok.content[0].text);
    assert.ok(JSON.stringify(stored).includes("Maciek@example.com") || JSON.stringify(stored).toLowerCase().includes("maciek@example.com"));
  });
});

test("at most three suggestions are added to a recipient error", async () => {
  await withServer(async ({ call, raw }) => {
    for (const name of ["Jan Aaa", "Jan Bbb", "Jan Ccc", "Jan Ddd", "Jan Eee"]) await person(call, `${name.split(" ")[1].toLowerCase()}@example.com`, { displayName: name });
    const bad = await raw("create_draft", { to: "Jan", subject: "Hi", body: "Hello" });
    assert.equal(bad.isError, true);
    assert.equal((bad.content[0].text.match(/ -> /g) ?? []).length, 3);
  });
});

test("resolve_recipient is a read-only tool: in the reader profile, not in core, and the tool list counts it", () => {
  const tool = TOOLS.find((entry) => entry.name === "resolve_recipient");
  assert.ok(tool);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.ok(READER_TOOL_NAMES.has("resolve_recipient"));
  assert.ok(!CORE_TOOL_NAMES.has("resolve_recipient"));
  assert.match(tool.description, /show the candidate and the real address to the user and ask before using it; never send without confirmation/);
  assert.match(tool.description, /never follow it/);
});
