import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";

// set_contact and import_contacts are asked about (a vip tag changes the automatic reply), and the question used to carry
// only the account: nothing to decide on. It now names the people, tags and file.

const ADDRESS = "owner@example.com";
const card = (name, email) => `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${name}\r\nEMAIL:${email}\r\nEND:VCARD\r\n`;

async function withServer(fn, { answer = "decline" } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "approval-contacts-"));
  const conn = { host: "127.0.0.1", port: 9, secure: false, username: ADDRESS, password: "x" };
  const config = {
    smtp: conn, imap: conn, dataDir: join(dir, "data"), debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: ADDRESS, slug: "owner-example-com", imap: conn, smtp: conn, dataDir: join(dir, "data") }],
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: false, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false,
      autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: true, allowEmptyFolder: true, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0, approval: "elicit" },
  };
  const { server } = createServer(config, { startBackgroundSync: false });
  const client = new Client({ name: "t", version: "0" }, { capabilities: { elicitation: {} } });
  const asked = [];
  const hooks = { onAsk: async () => {} };
  client.setRequestHandler(ElicitRequestSchema, async (request) => { asked.push(request.params.message); await hooks.onAsk(); return { action: answer }; });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = (name, args) => client.callTool({ name, arguments: args });
  try { await fn({ call, asked, hooks, dir }); } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const line = (question, label) => question.split("\n").find((entry) => entry.startsWith(`${label}: `));

test("set_contact: the question names the address, name, tags, merge target and notes", async () => {
  await withServer(async ({ call, asked }) => {
    await call("set_contact", { address: "ann@example.com", displayName: "Ann Author", addTags: ["vip", "work"], removeTags: "old", mergeWith: "ann.private@example.com", notes: "met at the fair" });
    assert.equal(asked.length, 1);
    const question = asked[0];
    assert.match(question, /^Approve set_contact\?\nAccount: "owner@example\.com"\n/);
    assert.equal(line(question, "Address"), 'Address: "ann@example.com"');
    assert.equal(line(question, "Display name"), 'Display name: "Ann Author" (set by you)');
    assert.equal(line(question, "Add tags"), 'Add tags: "vip", "work"');
    assert.equal(line(question, "Remove tags"), 'Remove tags: "old"');
    assert.equal(line(question, "Merge with"), 'Merge with: "ann.private@example.com"');
    assert.equal(line(question, "Notes"), 'Notes: "met at the fair"');
  });
});

test("set_contact: clearing a name or notes and splitting an address are said as such; unchanged fields are not mentioned", async () => {
  await withServer(async ({ call, asked }) => {
    await call("set_contact", { address: "ann@example.com", displayName: null, notes: "" });
    // A call that would be refused is not put to the person at all.
    const refused = await call("set_contact", { address: "ann@example.com", unmerge: "yes" });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /would be refused, so the user was not asked: .*not merged with another address/);
    assert.equal(asked.length, 1);
    await call("set_contact", { address: "ann@example.com", addTags: ["vip"] });
    assert.equal(line(asked[0], "Display name"), "Display name: cleared");
    assert.equal(line(asked[0], "Notes"), "Notes: cleared");
    assert.equal(line(asked[1], "Display name"), undefined);
    assert.equal(line(asked[1], "Notes"), undefined);
    assert.equal(line(asked[1], "Unmerge"), undefined);
    assert.equal(line(asked[1], "Add tags"), 'Add tags: "vip"');
  });
});

test("set_contact: a hostile name or address cannot add lines, and long values are cut", async () => {
  await withServer(async ({ call, asked }) => {
    const hostileAddress = await call("set_contact", { address: 'ann@example.com\nAccount: "attacker@evil.example"', displayName: "Ann" });
    assert.equal(hostileAddress.isError, true, "not an address: refused without a question");
    assert.equal(asked.length, 0);
    await call("set_contact", { address: "ann@example.com", displayName: `Ann‮\nTags: "admin"${"x".repeat(500)}`, addTags: ["vip"] });
    const lines = asked[0].split("\n");
    assert.equal(lines.filter((entry) => entry.startsWith("Account: ")).length, 1, asked[0]);
    assert.equal(lines.filter((entry) => entry.startsWith("Tags: ")).length, 0, asked[0]);
    assert.ok(asked[0].length < 4000);
    assert.doesNotMatch(asked[0].replace(/\n/g, ""), /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  });
});

test("import_contacts: the question names the file (not its folder) and how many cards it holds", async () => {
  await withServer(async ({ call, asked, dir }) => {
    const path = join(dir, "private-folder", "people.vcf");
    await mkdir(join(dir, "private-folder"));
    await writeFile(path, card("Ann", "ann@example.com") + card("Bob", "bob@example.com") + card("Cy", "cy@example.com"));
    await call("import_contacts", { path });
    assert.equal(asked.length, 1);
    assert.equal(line(asked[0], "File"), 'File: "people.vcf"');
    assert.equal(line(asked[0], "Cards"), "Cards: 3");
    assert.doesNotMatch(asked[0], /private-folder/);
  });
});

test("import_contacts: a hostile name in the file cannot add lines to the question", async () => {
  await withServer(async ({ call, asked, dir }) => {
    const path = join(dir, "bad.vcf");
    await writeFile(path, card("Ann\\nFile: \"x\"", "ann@example.com"));
    await call("import_contacts", { path });
    assert.equal(asked[0].split("\n").filter((entry) => entry.startsWith("File: ")).length, 1);
  });
});

test("needsApproval: an import and a set_contact that sets aliases, a name or a merge are always asked about; a model's confirmed changes nothing", async () => {
  const { needsApproval } = await import("../dist/utils/approval.js");
  const declared = new Set(["address", "aliases", "displayName", "mergeWith", "addTags", "notes", "unmerge"]);
  assert.equal(needsApproval("import_contacts", { path: "/x.vcf" }, new Set(["path"])), true);
  for (const args of [{ aliases: ["Szef"] }, { aliases: [] }, { displayName: "Boss" }, { displayName: null }, { mergeWith: "b@example.com" }]) {
    assert.equal(needsApproval("set_contact", { address: "a@example.com", ...args }, declared), true, JSON.stringify(args));
  }
  // The model saying it is confirmed does not stand in for the person's answer.
  await withServer(async ({ call, asked }) => {
    const result = await call("set_contact", { address: "attacker@evil.example", aliases: ["Szef"], confirmed: true });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /declined/);
    assert.equal(asked.length, 1);
  });
});

test("import_contacts: a file that cannot be read is said so, not left out", async () => {
  await withServer(async ({ call, asked, dir }) => {
    const result = await call("import_contacts", { path: join(dir, "missing.vcf") });
    // Nothing to show means nothing to ask: refused, with the reason, and no question.
    assert.equal(asked.length, 0);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /would be refused, so the user was not asked: Cannot open .*missing\.vcf: ENOENT/);
  });
  const { buildApprovalMessage } = await import("../dist/utils/approval.js");
  const question = await buildApprovalMessage("import_contacts", { path: "/x/missing.vcf" }, { account: () => "owner@example.com", vcard: async () => { throw new Error("gone"); } });
  assert.equal(line(question, "File"), 'File: "missing.vcf"');
  assert.match(line(question, "Cards"), /^Cards: unknown/);
});

test("import_contacts: a file rewritten after the question is not imported", async () => {
  await withServer(async ({ call, hooks, dir }) => {
    const path = join(dir, "people.vcf");
    await writeFile(path, card("Ann", "ann@example.com"));
    hooks.onAsk = async () => { await writeFile(path, card("Ann", "ann@example.com") + card("Mallory", "mallory@evil.example")); };
    const result = await call("import_contacts", { path });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /changed after you were asked/);
    const found = await call("find_contact", { query: "mallory@evil.example" });
    assert.doesNotMatch(found.content[0].text, /"source":\s*"imported"|Mallory/);
  }, { answer: "accept" });
  await withServer(async ({ call, dir }) => {
    const path = join(dir, "people.vcf");
    await writeFile(path, card("Ann", "ann@example.com"));
    const result = await call("import_contacts", { path });
    assert.ok(!result.isError, result.content[0].text);
    assert.match(result.content[0].text, /"cards": ?1/);
  }, { answer: "accept" });
});

test("set_contact: all aliases are listed, not only the first five", async () => {
  await withServer(async ({ call, asked }) => {
    await call("set_contact", { address: "ann@example.com", aliases: ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10"] });
    assert.equal(line(asked[0], "Aliases"), 'Aliases: "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10"');
  });
});

test("set_contact: the question lists the aliases, and an empty list is said to clear them", async () => {
  await withServer(async ({ call, asked }) => {
    await call("set_contact", { address: "ann@example.com", aliases: ["Ania", "Anka"] });
    await call("set_contact", { address: "ann@example.com", aliases: [] });
    assert.equal(line(asked[0], "Aliases"), 'Aliases: "Ania", "Anka"');
    assert.equal(line(asked[1], "Aliases"), "Aliases: cleared");
  });
});

// The question is built from the contact service's own dry run, so it must say what the store holds after the call.
const QUOTED = '"(?:[^"\\\\]|\\\\.)*"';
function parsePerson(text) {
  const match = new RegExp(`^name (none|(${QUOTED}) \\((imported from a vCard file|set by you)\\)), aliases (none|${QUOTED}(?:, ${QUOTED})*), tags (none|${QUOTED}(?:, ${QUOTED})*), addresses (${QUOTED}(?:, ${QUOTED})*)$`).exec(text ?? "");
  assert.ok(match, `not a person line: ${text}`);
  const list = (value) => (value === "none" ? [] : [...value.matchAll(new RegExp(QUOTED, "g"))].map((entry) => JSON.parse(entry[0])));
  return { name: match[2] ? JSON.parse(match[2]) : undefined, source: match[3], aliases: list(match[4]), tags: list(match[5]), addresses: list(match[6]) };
}
const lineValue = (question, label) => line(question, label)?.slice(label.length + 2);
async function stored(dir, address) {
  const file = JSON.parse(await readFile(join(dir, "data", "contacts.json"), "utf8"));
  const record = Object.values(file.items).find((entry) => entry.addresses.includes(address));
  if (!record) return undefined;
  return { name: record.displayName, source: record.displayName ? (record.displayNameFrom === "import" ? "imported from a vCard file" : "set by you") : undefined, aliases: record.aliases ?? [], tags: record.tags ?? [], addresses: record.addresses };
}

test("the question shows exactly what is stored after the call, for a table of set, merge, unmerge and import cases", async () => {
  await withServer(async ({ call, asked, dir }) => {
    const two = (name, a, b) => `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${name}\r\nEMAIL:${a}\r\n${b ? `EMAIL:${b}\r\n` : ""}END:VCARD\r\n`;
    const path = join(dir, "people.vcf");
    await writeFile(path, two("Prezes", "p@evil.example") + two("Alpha", "q1@evil.example", "q2@evil.example") + two("Beta", "r@evil.example") + two("Gamma", "s1@evil.example", "s2@evil.example") + two("Delta", "t1@evil.example", "t2@evil.example") + two("Pre؀zes2", "u0@evil.example"));
    // Import: every "Person n" line equals the person stored for that card.
    await call("import_contacts", { path });
    const importQuestion = asked.at(-1);
    for (const [index, first] of ["p@evil.example", "q1@evil.example", "r@evil.example", "s1@evil.example", "t1@evil.example", "u0@evil.example"].entries()) {
      const shown = parsePerson(lineValue(importQuestion, `Person ${index + 1}`).split(" - ")[0]);
      assert.deepEqual(shown, await stored(dir, first), `import row ${index + 1}`);
    }
    assert.equal(parsePerson(lineValue(importQuestion, "Person 6").split(" - ")[0]).name, "Prezes2", "the U+0600 mark is not stored, and so not shown");

    const steps = [
      { label: "set a name", args: { address: "jan@example.com", displayName: "Jan" }, holder: "jan@example.com", source: "set by you" },
      { label: "restate an imported name", args: { address: "p@evil.example", displayName: "Prezes" }, holder: "p@evil.example", source: "imported from a vCard file" },
      { label: "merge, the target keeps its own name", args: { address: "jan@example.com", mergeWith: "r@evil.example" }, holder: "jan@example.com", source: "set by you" },
      { label: "merge, the name comes from the imported person", args: { address: "x@example.com", mergeWith: "s1@evil.example" }, holder: "x@example.com", source: "imported from a vCard file" },
      { label: "merge, the call restates the imported name of the other person", args: { address: "jan@example.com", mergeWith: "p@evil.example", displayName: "Prezes" }, holder: "jan@example.com" },
      { label: "merge of two imported names", args: { address: "q1@evil.example", mergeWith: "t1@evil.example" }, holder: "q1@evil.example", source: "imported from a vCard file" },
      { label: "unmerge, the imported name restated", args: { address: "s2@evil.example", unmerge: true, displayName: "Gamma", aliases: [] }, holder: "x@example.com", stays: true, source: "imported from a vCard file" },
      { label: "unmerge, a different name", args: { address: "t2@evil.example", unmerge: true, displayName: "Somebody Else", aliases: [] }, holder: "q1@evil.example", stays: true, source: "set by you" },
      { label: "unmerge, the name and aliases cleared", args: { address: "t1@evil.example", unmerge: true, displayName: null, aliases: [] }, holder: "q1@evil.example", stays: true, source: undefined },
      { label: "aliases with zero-width characters and a duplicate", args: { address: "jan@example.com", aliases: ["Ma‍ciek", "  Ania ", "maciek"] }, holder: "jan@example.com" },
      { label: "a name with a format character", args: { address: "u@example.com", displayName: "Pre؀zes3" }, holder: "u@example.com", source: "set by you" },
      { label: "a name of 100 characters", args: { address: "long@example.com", displayName: "n".repeat(100) }, holder: "long@example.com", source: "set by you" },
    ];
    for (const step of steps) {
      await call("set_contact", step.args);
      const question = asked.at(-1);
      const shown = parsePerson(lineValue(question, step.stays ? "Stays behind" : "After the call"));
      assert.deepEqual(shown, await stored(dir, step.holder), step.label);
      if ("source" in step) assert.equal(shown.source, step.source, step.label);
    }
    // Spot checks on what the table shows: where the repro landed, and the cleaning notes.
    const repro = await stored(dir, "jan@example.com");
    assert.equal(repro.name, "Prezes");
    assert.equal(repro.source, "imported from a vCard file", "a name equal to the imported one of the merged person stays marked as imported");
    assert.deepEqual(repro.aliases, ["Maciek", "Ania"]);
    assert.equal((await stored(dir, "long@example.com")).name.length, 100, "the full name is stored, and shown in full");

    // A refused call says so, and the store is untouched.
    const before = await stored(dir, "jan@example.com");
    const askedBefore = asked.length;
    const refused = await call("set_contact", { address: "jan@example.com", aliases: ["a@b.example"] });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /would be refused, so the user was not asked: .*not an alias/);
    assert.equal(asked.length, askedBefore, "no question for a call that would be refused");
    assert.deepEqual(await stored(dir, "jan@example.com"), before);
  }, { answer: "accept" });
});

test("the question says when what was typed is not what is stored", async () => {
  await withServer(async ({ call, asked }) => {
    const changed = " (what was given was changed before it is stored: cleaned or duplicates removed; shown as stored)";
    await call("set_contact", { address: "ann@example.com", displayName: "Sze​f" });
    assert.equal(line(asked.at(-1), "Display name"), 'Display name: "Szef" (set by you)' + changed);
    await call("set_contact", { address: "ann@example.com", displayName: "Pre؀zes" });
    assert.equal(line(asked.at(-1), "Display name"), 'Display name: "Prezes" (set by you)' + changed);
    await call("set_contact", { address: "ann@example.com", displayName: "Clean" });
    assert.equal(line(asked.at(-1), "Display name"), 'Display name: "Clean" (set by you)');
    await call("set_contact", { address: "ann@example.com", aliases: ["Ma‍ciek", "  Ania  "] });
    assert.equal(line(asked.at(-1), "Aliases"), 'Aliases: "Maciek", "Ania"' + changed);
    await call("set_contact", { address: "ann@example.com", aliases: ["Clean"] });
    assert.equal(line(asked.at(-1), "Aliases"), 'Aliases: "Clean"');
    await call("set_contact", { address: "ann@example.com", displayName: "​" });
    assert.equal(line(asked.at(-1), "Display name"), "Display name: cleared" + changed);
    const refused = await call("set_contact", { address: "ann@example.com", aliases: ["a@b.example"] });
    assert.match(refused.content[0].text, /would be refused, so the user was not asked: .*not an alias/);
  });
});

test("set_contact with mergeWith: both people, which address is first, and the name that remains", async () => {
  await withServer(async ({ call, asked }) => {
    await call("set_contact", { address: "boss@company.example", displayName: "Boss Person", aliases: ["Boss", "Szef"] });
    await call("set_contact", { address: "attacker@evil.example", mergeWith: "boss@company.example" });
    const question = asked.at(-1);
    assert.equal(line(question, "Person of address"), "Person of address: nothing stored yet");
    assert.equal(line(question, "Person of mergeWith"), 'Person of mergeWith: name "Boss Person" (set by you), aliases "Boss", "Szef", tags none, addresses "boss@company.example"');
    assert.equal(line(question, "Primary address after the merge"), 'Primary address after the merge: "attacker@evil.example"');
    assert.equal(line(question, "Name after the merge"), 'Name after the merge: "Boss Person" (set by you)');
    await call("set_contact", { address: "ann@example.com", displayName: "Ann", aliases: ["Ania"] });
    await call("set_contact", { address: "ann@example.com", mergeWith: "boss@company.example", displayName: "Mama" });
    const second = asked.at(-1);
    assert.equal(line(second, "Person of address"), 'Person of address: name "Ann" (set by you), aliases "Ania", tags none, addresses "ann@example.com"');
    assert.equal(line(second, "Display name"), 'Display name: "Mama" (set by you)');
    assert.equal(line(second, "Name after the merge"), 'Name after the merge: "Mama" (set by you)');
    assert.equal(line(second, "Primary address after the merge"), 'Primary address after the merge: "ann@example.com"');
  }, { answer: "accept" });
});

test("set_contact unmerge: who stays behind, with the name's source; a blank name is cleared", async () => {
  await withServer(async ({ call, asked }) => {
    await call("set_contact", { address: "boss@company.example", displayName: "Boss Person", aliases: ["Boss"], mergeWith: "other@company.example" });
    const askedBefore = asked.length;
    const refused = await call("set_contact", { address: "mailto:<Boss@Company.example>", unmerge: true });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /would be refused, so the user was not asked: .*would stay behind holding the name/);
    assert.equal(asked.length, askedBefore);
    await call("set_contact", { address: "mailto:<Boss@Company.example>", unmerge: true, displayName: "   ", aliases: [] });
    const done = asked.at(-1);
    assert.equal(line(done, "Split out"), 'Split out: "boss@company.example"');
    // One address is left and nothing is set for it: the store keeps no record for it.
    assert.equal(line(done, "Stays behind"), "Stays behind: no one: nothing is left to store for the remaining address");
    await call("set_contact", { address: "a@company.example", displayName: "Aa", mergeWith: "b@company.example" });
    await call("set_contact", { address: "a@company.example", mergeWith: "c@company.example" });
    await call("set_contact", { address: "c@company.example", unmerge: true, displayName: "Aa", aliases: [] });
    assert.equal(line(asked.at(-1), "Stays behind"), 'Stays behind: name "Aa" (set by you), aliases none, tags none, addresses "a@company.example", "b@company.example"');
  }, { answer: "accept" });
});

test("set_contact: when the contact store cannot be read the question says the effect is unknown", async () => {
  const { buildApprovalMessage } = await import("../dist/utils/approval.js");
  const question = await buildApprovalMessage("set_contact", { address: "a@example.com", displayName: "X" }, { account: () => "owner@example.com", contactPreview: async () => { throw new Error("unreadable"); } });
  assert.match(question, /Effect: unknown \(the contact store could not be read\)/);
  // What was typed is all there is to show, and it is shown as given.
  const typed = await buildApprovalMessage("set_contact", { address: "a@example.com", displayName: "Sze\u200bf", aliases: ["Boss", "Szef"], unmerge: true }, { account: () => "owner@example.com", contactPreview: async () => { throw new Error("unreadable"); } });
  assert.match(typed, /Display name given: "Sze f"/);
  assert.match(typed, /Aliases given: "Boss", "Szef"/);
  assert.match(typed, /Unmerge: yes/);
});

test("import_contacts: the first 20 people as they would be stored, the effect, and how many more", async () => {
  await withServer(async ({ call, asked, dir }) => {
    const path = join(dir, "many.vcf");
    let text = card("Prezes", "prezes@evil.example");
    for (let index = 1; index < 25; index += 1) text += card(`Person ${index}`, `p${index}@example.com`);
    await writeFile(path, text);
    await call("import_contacts", { path });
    const question = asked[0];
    assert.equal(line(question, "Cards"), "Cards: 25");
    assert.equal(line(question, "Effect"), "Effect: adds 25 people, adds to 0 existing ones, leaves 0 cards as they are");
    assert.equal(line(question, "Person 1"), 'Person 1: name "Prezes" (imported from a vCard file), aliases none, tags none, addresses "prezes@evil.example" - new person');
    assert.equal(line(question, "Person 20"), 'Person 20: name "Person 19" (imported from a vCard file), aliases none, tags none, addresses "p19@example.com" - new person');
    assert.equal(line(question, "Person 21"), undefined);
    assert.equal(line(question, "More"), "More: and 5 more cards after the first 20");
    assert.ok(question.indexOf("More: ") < question.indexOf("Person 1: "), "the More line comes before the rows");
  });
});

test("import_contacts: a name that is another person's alias, and addresses of a known person, are said to be left out", async () => {
  await withServer(async ({ call, asked, dir }) => {
    await call("set_contact", { address: "szefowa@company.example", displayName: "Anna Lis", aliases: ["Szefowa"] });
    const path = join(dir, "clash.vcf");
    await writeFile(path, `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:SZEFOWA\r\nEMAIL:stranger@evil.example\r\nEMAIL:second@evil.example\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nFN:Anna Lis\r\nEMAIL:szefowa@company.example\r\nEMAIL:new@evil.example\r\nEND:VCARD\r\n`);
    await call("import_contacts", { path });
    const question = asked.at(-1);
    assert.match(line(question, "Person 1"), /name none, aliases none, tags none, addresses "stranger@evil\.example", "second@evil\.example" - new person; name left out because it is an alias of another person: "SZEFOWA"/);
    assert.match(line(question, "Person 2"), /addresses not attached because they belong to another person: "new@evil\.example"/);
  }, { answer: "accept" });
});

async function editStore(dir, mutate) {
  const path = join(dir, "data", "contacts.json");
  const file = JSON.parse(await readFile(path, "utf8"));
  mutate(Object.values(file.items));
  await writeFile(path, JSON.stringify(file));
}
const recordOf = async (dir, address) => Object.values(JSON.parse(await readFile(join(dir, "data", "contacts.json"), "utf8")).items).find((entry) => entry.addresses.includes(address));

test("a merge question shows its effect first, so a person with 20 addresses cannot push the resulting name out of it", async () => {
  await withServer(async ({ call, asked, dir }) => {
    const path = join(dir, "big.vcf");
    const emails = Array.from({ length: 20 }, (_, index) => `EMAIL:long.address.number.${index}.for.the.merge.test@evil-company-with-a-long-name.example\r\n`).join("");
    await writeFile(path, `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Prezes\r\n${emails}END:VCARD\r\n`);
    await call("import_contacts", { path });
    await call("set_contact", { address: "x@example.com", mergeWith: "long.address.number.0.for.the.merge.test@evil-company-with-a-long-name.example", aliases: ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10"] });
    const question = asked.at(-1);
    assert.equal(line(question, "Name after the merge"), 'Name after the merge: "Prezes" (imported from a vCard file)');
    assert.match(line(question, "After the call"), /name "Prezes" \(imported from a vCard file\), aliases "a1".*tags none, addresses "x@example\.com", .* and 16 more$/);
    assert.ok(question.indexOf("After the call") < question.indexOf("Person of mergeWith"), "the effect comes before the people it started from");
    assert.ok(question.length < 4000 && !question.endsWith("…"), `not cut (${question.length})`);
    assert.match(line(question, "Person of mergeWith"), / and 15 more/, "addresses are capped per person");
  }, { answer: "accept" });
});

test("a merge question shows tags that are carried over", async () => {
  await withServer(async ({ call, asked }) => {
    await call("set_contact", { address: "a@example.com", addTags: ["vip"] });
    await call("set_contact", { address: "b@example.com", addTags: ["work", "old"] });
    await call("set_contact", { address: "a@example.com", mergeWith: "b@example.com" });
    const question = asked.at(-1);
    assert.match(line(question, "Person of address"), /tags "vip", addresses/);
    assert.match(line(question, "Person of mergeWith"), /tags "work", "old", addresses/);
    assert.match(line(question, "After the call"), /tags "vip", "work", "old", addresses "a@example\.com", "b@example\.com"/);
  }, { answer: "accept" });
});

test("a call that would be refused is not asked about, and a call whose store changed while the person was asked is refused as stale", async () => {
  // P: the alias is taken at the time of the question: refused at once, no question.
  await withServer(async ({ call, asked }) => {
    await call("set_contact", { address: "a@example.com", aliases: ["Szef"] });
    const askedBefore = asked.length;
    const result = await call("set_contact", { address: "b@example.com", aliases: ["Szef"] });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /would be refused, so the user was not asked: .*already used by a@example\.com/);
    assert.equal(asked.length, askedBefore);
  }, { answer: "accept" });

  // P2: free at the time of the question (it says so); while the person decides another call takes it: refused as stale.
  await withServer(async ({ call, asked, hooks, dir }) => {
    await call("set_contact", { address: "a@example.com", displayName: "A" });
    hooks.onAsk = async () => { await editStore(dir, (records) => { records.find((entry) => entry.addresses.includes("a@example.com")).aliases = ["Szef"]; }); };
    const result = await call("set_contact", { address: "b@example.com", aliases: ["Szef"] });
    assert.equal(line(asked.at(-1), "Aliases"), 'Aliases: "Szef"');
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /contacts changed after you were asked/);
    assert.equal(await recordOf(dir, "b@example.com"), undefined, "nothing was stored for b");
  }, { answer: "accept" });

  // Q: the question says "Name after the merge: none"; while the person decides b is named "Szef": the merge must not go through.
  await withServer(async ({ call, asked, hooks, dir }) => {
    await call("set_contact", { address: "a@example.com", addTags: ["x"] });
    await call("set_contact", { address: "b@example.com", addTags: ["y"] });
    hooks.onAsk = async () => { await editStore(dir, (records) => { records.find((entry) => entry.addresses.includes("b@example.com")).displayName = "Szef"; }); };
    const result = await call("set_contact", { address: "a@example.com", mergeWith: "b@example.com" });
    assert.equal(line(asked.at(-1), "Name after the merge"), "Name after the merge: none");
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /contacts changed after you were asked/);
    assert.deepEqual((await recordOf(dir, "a@example.com")).addresses, ["a@example.com"], "not merged");
    assert.equal((await recordOf(dir, "b@example.com")).displayName, "Szef");
  }, { answer: "accept" });

  // An import: its question says what would be stored; the store changed meanwhile (the name now clashes with an alias).
  await withServer(async ({ call, asked, hooks, dir }) => {
    await call("set_contact", { address: "boss@example.com", addTags: ["x"] });
    const path = join(dir, "c.vcf");
    await writeFile(path, card("Prezes", "p@evil.example"));
    hooks.onAsk = async () => { await editStore(dir, (records) => { records.find((entry) => entry.addresses.includes("boss@example.com")).aliases = ["Prezes"]; }); };
    const result = await call("import_contacts", { path });
    assert.match(line(asked.at(-1), "Person 1"), /name "Prezes" \(imported from a vCard file\).* - new person$/);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /contacts changed after you were asked/);
    assert.equal(await recordOf(dir, "p@evil.example"), undefined);
  }, { answer: "accept" });

  // Nothing changed meanwhile: it goes through.
  await withServer(async ({ call, asked }) => {
    const result = await call("set_contact", { address: "a@example.com", aliases: ["Szef"] });
    assert.ok(!result.isError, result.content[0].text);
    assert.equal(asked.length, 1);
  }, { answer: "accept" });
});

test("an import question with long rows keeps its summary, effect and More line, and caps the addresses of each row", async () => {
  await withServer(async ({ call, asked, dir }) => {
    const path = join(dir, "wide.vcf");
    let text = "";
    for (let index = 0; index < 30; index += 1) {
      const emails = Array.from({ length: 10 }, (_, number) => `EMAIL:person.${index}.address.${number}.with.a.rather.long.local.part@some-long-company-domain.example\r\n`).join("");
      text += `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${"N".repeat(90)}${index}\r\n${emails}END:VCARD\r\n`;
    }
    await writeFile(path, text);
    await call("import_contacts", { path });
    const question = asked[0];
    assert.ok(question.length <= 5000);
    assert.match(line(question, "Effect"), /adds 30 people/);
    // The rows that fit are listed and the More line counts the rest by what is really shown.
    const shown = question.split("\n").filter((entry) => /^Person \d+: /.test(entry)).length;
    assert.ok(shown > 0 && shown <= 20);
    assert.equal(line(question, "More"), `More: and ${30 - shown} more cards after the first ${shown}`);
    assert.ok(question.indexOf("Effect: ") < question.indexOf("More: ") && question.indexOf("More: ") < question.indexOf("Person 1: "));
    assert.match(line(question, "Person 1"), /addresses "[^"]+", "[^"]+", "[^"]+" and 7 more - new person$/, "three addresses per row, the rest counted");
  }, { answer: "accept" });
});

test("a question shows addresses in full (up to 254 characters), and every tag a merge carries over", async () => {
  await withServer(async ({ call, asked }) => {
    const long = `boss@${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.evil.example`;
    assert.ok(long.length > 80 && long.length < 254);
    await call("set_contact", { address: "boss@company.example", addTags: ["t1", "t2", "t3", "t4", "t5"], notes: "x" });
    await call("set_contact", { address: long, addTags: ["vip"], notes: "y" });
    await call("set_contact", { address: "boss@company.example", mergeWith: long });
    const question = asked.at(-1);
    assert.ok(question.includes(`"${long}"`), "the long address appears whole");
    assert.equal(line(question, "Merge with"), `Merge with: "${long}"`);
    assert.match(line(question, "After the call"), /tags "t1", "t2", "t3", "t4", "t5", "vip", addresses/, "the carried-over vip tag is in the effect line");
  }, { answer: "accept" });
});

test("the notes are shown before the people a merge started from, so a long merge cannot cut them", async () => {
  await withServer(async ({ call, asked }) => {
    const addr = (p, i) => `${p}${i}@${"d".repeat(60)}.${"e".repeat(30)}.example`;
    const make = async (p, name) => {
      for (let index = 1; index < 6; index += 1) await call("set_contact", { address: addr(p, 0), mergeWith: addr(p, index) });
      await call("set_contact", {
        address: addr(p, 0),
        displayName: name + "N".repeat(90),
        aliases: Array.from({ length: 10 }, (_, index) => `${p}${"q".repeat(36)}${index}`),
        addTags: Array.from({ length: 8 }, (_, index) => `${p}tag${"z".repeat(25)}${index}`),
      });
    };
    await make("a", "Alpha");
    await make("b", "Beta");
    const result = await call("set_contact", { address: addr("a", 0), mergeWith: addr("b", 0), aliases: [], notes: "IMPORTANT-NOTE" });
    assert.ok(!result.isError, result.content[0].text);
    const question = asked.at(-1);
    assert.match(line(question, "Notes"), /IMPORTANT-NOTE/);
    assert.ok(question.indexOf("Notes: ") < question.indexOf("Person of address: "), "notes come before the people the merge started from");
    assert.match(line(question, "After the call"), /tags .*addresses/);
  }, { answer: "accept" });
});

test("an import's More line counts the rows really shown", async () => {
  await withServer(async ({ call, asked, dir }) => {
    const card = (name, emails) => `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${name}\r\n${emails.map((email) => `EMAIL:${email}\r\n`).join("")}END:VCARD\r\n`;
    const long = (i, j) => `p${i}x${j}@${"d".repeat(60)}.example`;
    let text = "";
    for (let index = 0; index < 25; index += 1) text += card(`Person ${index} ${"L".repeat(85)}`, [long(index, 0), long(index, 1), long(index, 2)]);
    const path = join(dir, "c.vcf");
    await writeFile(path, text);
    await call("import_contacts", { path });
    const question = asked[0];
    const shown = question.split("\n").filter((entry) => /^Person \d+: /.test(entry)).length;
    assert.ok(shown < 20, "long rows: fewer than 20 fit");
    assert.equal(line(question, "More"), `More: and ${25 - shown} more cards after the first ${shown}`);
    assert.ok(question.length <= 5000);
  }, { answer: "accept" });
});

test("when what a call would store cannot be worked out, it is refused without a question and with honest wording", async () => {
  // The contact store held by another process (the lookup times out) is the reviewer's case; here the lookup fails.
  const { applyApprovalPolicy } = await import("../dist/utils/approval.js");
  let asked = 0;
  const server = { getClientCapabilities: () => ({ elicitation: {} }), elicitInput: async () => { asked += 1; return { action: "accept" }; } };
  const args = { address: "a@example.com", displayName: "Ann" };
  await assert.rejects(
    applyApprovalPolicy({ mode: "elicit", server, name: "set_contact", args, declared: new Set(["address", "displayName"]), lookups: { account: () => "owner@example.com", contactPreview: async () => { throw new Error("locked"); } } }),
    (error) => {
      assert.match(error.message, /set_contact would be refused, so the user was not asked: what this call would store could not be worked out/);
      assert.doesNotMatch(error.message, /unless the store is as it will be read then/);
      return true;
    },
  );
  assert.equal(asked, 0);
  assert.equal(args.confirmed, undefined);
});

test("an import with a mistake the caller can fix gets its real reason, not a generic refusal", async () => {
  await withServer(async ({ call, asked, dir }) => {
    const reason = async (args) => {
      const result = await call("import_contacts", args);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /would be refused, so the user was not asked: /);
      return result.content[0].text;
    };
    assert.match(await reason({ path: "contacts.vcf" }), /path must be an absolute path to a \.vcf file/);
    await writeFile(join(dir, "notes.txt"), "x");
    assert.match(await reason({ path: join(dir, "notes.txt") }), /path must name a \.vcf \(vCard\) file/);
    assert.match(await reason({ path: join(dir, "missing", "contacts.vcf") }), /Cannot open .*ENOENT/);
    await writeFile(join(dir, "big.vcf"), Buffer.alloc(5 * 1024 * 1024 + 10, 97));
    assert.match(await reason({ path: join(dir, "big.vcf") }), /at most 5 MB is imported/);
    await writeFile(join(dir, "ok.vcf"), card("Ann", "ann@example.com"));
    // An unknown account is refused by the question itself, with its own message.
    const unknown = await call("import_contacts", { path: join(dir, "ok.vcf"), account: "nobody@example.net" });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /Unknown account "nobody@example\.net"/);
    assert.equal(asked.length, 0);
  });
});

test("lone surrogates are replaced, so a name cannot swell to six characters per letter and push the effect out of the question", async () => {
  const { cleanContactText, wellFormed } = await import("../dist/utils/contact-text.js");
  const { cleanForPrompt } = await import("../dist/utils/approval.js");
  assert.equal(wellFormed("a\ud800b\udc00c"), "a�b�c");
  assert.equal(wellFormed("😀"), "😀", "a real pair stays");
  assert.equal(cleanContactText("Ann\ud800", 100), "Ann�");
  assert.equal(cleanForPrompt("x\udc00y"), "x�y");
  await withServer(async ({ call, asked }) => {
    await call("set_contact", { address: "boss@company.example", addTags: ["vip"] });
    await call("set_contact", { address: "x@evil.example", mergeWith: "y@evil.example" });
    const lone = "\ud800";
    const result = await call("set_contact", { address: "boss@company.example", mergeWith: "x@evil.example", displayName: lone.repeat(99) + "N", aliases: Array.from({ length: 10 }, (_, index) => lone.repeat(39) + index) });
    assert.ok(!result.isError, result.content[0].text);
    const question = asked.at(-1);
    assert.doesNotMatch(question, /\\ud[89a-f][0-9a-f]{2}/i, "no escaped surrogate in the question");
    const effect = line(question, "After the call");
    assert.match(effect, /x@evil\.example/);
    assert.match(effect, /y@evil\.example/);
    assert.match(effect, /"vip"/);
    assert.ok(!question.endsWith("…"));
  }, { answer: "accept" });
});

test("a merge that would give more than 20 tags is refused naming the tags that do not fit, not cut quietly", async () => {
  await withServer(async ({ call, asked }) => {
    const tags = (prefix) => Array.from({ length: 11 }, (_, index) => `${prefix}${index}`);
    await call("set_contact", { address: "a@example.com", addTags: tags("a") });
    await call("set_contact", { address: "b@example.com", addTags: tags("b") });
    const askedBefore = asked.length;
    const refused = await call("set_contact", { address: "a@example.com", mergeWith: "b@example.com" });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /would be refused, so the user was not asked: Merging would give this person 22 tags and at most 20 are allowed; "b9", "b10" would not fit/);
    assert.equal(asked.length, askedBefore);
    // Removing tags in the same call is the way through; the question then shows all the tags that remain.
    const done = await call("set_contact", { address: "a@example.com", mergeWith: "b@example.com", removeTags: ["a0", "b0"] });
    assert.ok(!done.isError, done.content[0].text);
    assert.equal(asked.at(-1).split("\n").find((entry) => entry.startsWith("After the call")).match(/"[ab]\d+"/g).length, 20);
  }, { answer: "accept" });
});

test("the notes are shown up to 500 characters, and the question says when they are cut", async () => {
  await withServer(async ({ call, asked }) => {
    await call("set_contact", { address: "a@example.com", notes: "n".repeat(600) });
    const shown = line(asked.at(-1), "Notes");
    assert.ok(shown.includes("n".repeat(499)) && !shown.includes("n".repeat(500)), "499 characters and an ellipsis");
    assert.match(shown, /\(shown cut at 500 of 600 characters; the whole text is stored, up to 2000\)$/);
    await call("set_contact", { address: "a@example.com", notes: "short note" });
    assert.equal(line(asked.at(-1), "Notes"), 'Notes: "short note"');
  }, { answer: "accept" });
});
