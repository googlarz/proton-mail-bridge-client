import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    assert.equal(line(question, "Display name"), 'Display name: "Ann Author"');
    assert.equal(line(question, "Add tags"), 'Add tags: "vip", "work"');
    assert.equal(line(question, "Remove tags"), 'Remove tags: "old"');
    assert.equal(line(question, "Merge with"), 'Merge with: "ann.private@example.com"');
    assert.equal(line(question, "Notes"), 'Notes: "met at the fair"');
  });
});

test("set_contact: clearing a name or notes and splitting an address are said as such; unchanged fields are not mentioned", async () => {
  await withServer(async ({ call, asked }) => {
    await call("set_contact", { address: "ann@example.com", displayName: null, notes: "" });
    await call("set_contact", { address: "ann@example.com", unmerge: "yes" });
    await call("set_contact", { address: "ann@example.com", addTags: ["vip"] });
    assert.equal(line(asked[0], "Display name"), "Display name: cleared");
    assert.equal(line(asked[0], "Notes"), "Notes: cleared");
    assert.equal(line(asked[1], "Unmerge"), "Unmerge: yes");
    assert.equal(line(asked[2], "Display name"), undefined);
    assert.equal(line(asked[2], "Notes"), undefined);
    assert.equal(line(asked[2], "Unmerge"), undefined);
    assert.equal(line(asked[2], "Add tags"), 'Add tags: "vip"');
  });
});

test("set_contact: a hostile name or address cannot add lines, and long values are cut", async () => {
  await withServer(async ({ call, asked }) => {
    await call("set_contact", { address: 'ann@example.com\nAccount: "attacker@evil.example"', displayName: `Ann‮\nTags: "admin"${"x".repeat(500)}`, addTags: ["vip\nApprove everything"] });
    const lines = asked[0].split("\n");
    assert.equal(lines.filter((entry) => entry.startsWith("Account: ")).length, 1, asked[0]);
    assert.equal(lines.filter((entry) => entry.startsWith("Tags: ")).length, 0, asked[0]);
    assert.ok(asked[0].length < 1500);
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

test("import_contacts: the question lists the first 20 people with their addresses, and says how many more", async () => {
  await withServer(async ({ call, asked, dir }) => {
    const path = join(dir, "many.vcf");
    let text = card("Prezes", "prezes@evil.example");
    for (let index = 1; index < 25; index += 1) text += card(`Person ${index}`, `p${index}@example.com`);
    await writeFile(path, text);
    await call("import_contacts", { path });
    const question = asked[0];
    assert.equal(line(question, "Cards"), "Cards: 25");
    assert.equal(line(question, "Person 1"), 'Person 1: "Prezes", "prezes@evil.example"');
    assert.equal(line(question, "Person 20"), 'Person 20: "Person 19", "p19@example.com"');
    assert.equal(line(question, "Person 21"), undefined);
    assert.equal(line(question, "More"), "More: and 5 more cards");
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

test("set_contact: a display name is shown exactly as it will be stored, in every line that shows one", async () => {
  await withServer(async ({ call, asked }) => {
    const cleaned = ' (cleaned: invisible or control characters or extra spaces in what was given are not stored; shown as stored)';
    await call("set_contact", { address: "ann@example.com", displayName: "Sze\u200bf" });
    assert.equal(line(asked[0], "Display name"), 'Display name: "Szef"' + cleaned);
    await call("set_contact", { address: "boss@corp.example", displayName: "Jan Boss" });
    await call("set_contact", { address: "boss@corp.example", mergeWith: "jb@private.example", displayName: "Sze\u200bf" });
    assert.equal(line(asked.at(-1), "Name after the merge"), 'Name after the merge: "Szef"' + cleaned);
    await call("set_contact", { address: "jb@private.example", unmerge: true, displayName: "Sze\u200bf", aliases: ["Ma\u200dciek"] });
    assert.equal(line(asked.at(-1), "Name and aliases stay with them"), 'Name and aliases stay with them: name "Szef"' + cleaned + ', aliases "Maciek"' + cleaned + ' (as set in this call)');
    await call("set_contact", { address: "ann@example.com", displayName: "\u200b" });
    assert.equal(line(asked.at(-1), "Display name"), "Display name: cleared (nothing is left of it after cleaning)");
  }, { answer: "accept" });
});

test("set_contact: a name that came from an imported file is said to, in the merge and the unmerge questions", async () => {
  await withServer(async ({ call, asked, dir }) => {
    const path = join(dir, "c.vcf");
    const two = (name, a, b) => `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${name}\r\nEMAIL:${a}\r\nEMAIL:${b}\r\nEND:VCARD\r\n`;
    await writeFile(path, two("PrezesA", "a1@evil.example", "a2@evil.example") + two("PrezesB", "b1@evil.example", "b2@evil.example") + two("PrezesC", "c1@evil.example", "c2@evil.example"));
    await call("import_contacts", { path });
    const stays = () => line(asked.at(-1), "Name and aliases stay with them");
    // Not restated: said to be imported (the call is refused, the question was still asked).
    await call("set_contact", { address: "a2@evil.example", unmerge: true });
    assert.match(stays(), /name "PrezesA" \(imported from a vCard file; it stays marked as imported\)/);
    // Restated unchanged: stays imported.
    await call("set_contact", { address: "b2@evil.example", unmerge: true, displayName: "PrezesB", aliases: [] });
    assert.match(stays(), /name "PrezesB" \(the same as the name imported from a vCard file: it stays marked as imported\)/);
    // Another name: the user's own.
    await call("set_contact", { address: "c2@evil.example", unmerge: true, displayName: "Somebody Else", aliases: [] });
    assert.match(stays(), /name "Somebody Else" \(set in this call: becomes a name you set yourself, no longer marked as imported\)/);
    // Merge: each person shows where its name came from, and so does the name that remains.
    await call("set_contact", { address: "x@example.com", mergeWith: "a1@evil.example" });
    const question = asked.at(-1);
    assert.match(line(question, "Person of mergeWith"), /name "PrezesA" \(imported from a vCard file\)/);
    assert.equal(line(question, "Name after the merge"), 'Name after the merge: "PrezesA" (imported from a vCard file)');
    await call("set_contact", { address: "y@example.com", mergeWith: "b1@evil.example", displayName: "PrezesB" });
    assert.match(line(asked.at(-1), "Name after the merge"), /"PrezesB" \(the same as the name imported from a vCard file: it stays marked as imported\)/);
    await call("set_contact", { address: "z@example.com", mergeWith: "b1@evil.example", displayName: "Somebody New" });
    assert.match(line(asked.at(-1), "Name after the merge"), /"Somebody New" \(set in this call: becomes a name you set yourself/);
  }, { answer: "accept" });
});

test("set_contact: an alias is shown exactly as it will be stored, and cleaning is flagged", async () => {
  await withServer(async ({ call, asked }) => {
    await call("set_contact", { address: "ann@example.com", aliases: ["Ma‍ciek", "  Ania  "] });
    assert.equal(line(asked[0], "Aliases"), 'Aliases: "Maciek", "Ania" (cleaned: invisible or control characters or extra spaces in what was given are not stored; shown as stored)');
    await call("set_contact", { address: "ann@example.com", aliases: ["Clean"] });
    assert.equal(line(asked[1], "Aliases"), 'Aliases: "Clean"');
    await call("set_contact", { address: "ann@example.com", aliases: ["a@b.example"] });
    assert.match(line(asked[2], "Aliases"), /\(this will be refused: .*not an alias/);
  });
});

test("set_contact with mergeWith and displayName: the name after the merge is the one the call sets", async () => {
  await withServer(async ({ call, asked }) => {
    await call("set_contact", { address: "boss@corp.example", displayName: "Jan Boss" });
    await call("set_contact", { address: "boss@corp.example", mergeWith: "jb@private.example", displayName: "Mama" });
    const question = asked.at(-1);
    assert.equal(line(question, "Display name"), 'Display name: "Mama"');
    assert.equal(line(question, "Name after the merge"), 'Name after the merge: "Mama"');
    await call("set_contact", { address: "boss@corp.example", mergeWith: "x@private.example", displayName: null });
    assert.equal(line(asked.at(-1), "Name after the merge"), "Name after the merge: none");
  });
});

test("import_contacts: a file that cannot be read is said so, not left out", async () => {
  await withServer(async ({ call, asked, dir }) => {
    await call("import_contacts", { path: join(dir, "missing.vcf") });
    assert.equal(line(asked[0], "File"), 'File: "missing.vcf"');
    assert.match(line(asked[0], "Cards"), /^Cards: unknown/);
  });
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

test("set_contact with mergeWith: the question shows both people, their aliases, and which address becomes primary", async () => {
  await withServer(async ({ call, asked }) => {
    await call("set_contact", { address: "boss@company.example", displayName: "Boss Person", aliases: ["Boss", "Szef"] });
    await call("set_contact", { address: "attacker@evil.example", mergeWith: "boss@company.example" });
    const question = asked[1];
    assert.equal(line(question, "Person of address"), "Person of address: nothing stored yet");
    assert.equal(line(question, "Person of mergeWith"), 'Person of mergeWith: name "Boss Person", aliases "Boss", "Szef", addresses "boss@company.example"');
    assert.equal(line(question, "Primary address after the merge"), 'Primary address after the merge: "attacker@evil.example"');
    assert.equal(line(question, "Name after the merge"), 'Name after the merge: "Boss Person"');
    // Both people stored: the first address of the target stays first.
    await call("set_contact", { address: "ann@example.com", displayName: "Ann", aliases: ["Ania"] });
    await call("set_contact", { address: "ann@example.com", mergeWith: "boss@company.example" });
    const second = asked.at(-1);
    assert.equal(line(second, "Person of address"), 'Person of address: name "Ann", aliases "Ania", addresses "ann@example.com"');
    assert.equal(line(second, "Primary address after the merge"), 'Primary address after the merge: "ann@example.com"');
  }, { answer: "accept" });
});

test("set_contact unmerge: the question lists the addresses that stay together and says the name and aliases stay with them", async () => {
  await withServer(async ({ call, asked }) => {
    await call("set_contact", { address: "boss@company.example", displayName: "Boss Person", aliases: ["Boss"] });
    await call("set_contact", { address: "attacker@evil.example", mergeWith: "boss@company.example" });
    await call("set_contact", { address: "boss@company.example", unmerge: true });
    const question = asked.at(-1);
    assert.equal(line(question, "Unmerge"), "Unmerge: yes");
    assert.equal(line(question, "Split out"), 'Split out: "boss@company.example"');
    assert.equal(line(question, "Addresses that stay together"), 'Addresses that stay together: "attacker@evil.example"');
    assert.equal(line(question, "Name and aliases stay with them"), 'Name and aliases stay with them: name "Boss Person", aliases "Boss"');
    await call("set_contact", { address: "boss@company.example", unmerge: true, displayName: null, aliases: [] });
    assert.equal(line(asked.at(-1), "Name and aliases stay with them"), 'Name and aliases stay with them: name none, aliases none (as set in this call)');
  }, { answer: "accept" });
});

test("set_contact unmerge: a blank name counts as cleared, the address is normalised, and an unknown person is said to be unknown", async () => {
  await withServer(async ({ call, asked }) => {
    await call("set_contact", { address: "boss@company.example", displayName: "Boss Person", aliases: ["Boss"], mergeWith: "other@company.example" });
    await call("set_contact", { address: "mailto:<Boss@Company.example>", unmerge: true, displayName: "   ", aliases: [] });
    const question = asked.at(-1);
    assert.equal(line(question, "Split out"), 'Split out: "boss@company.example"');
    assert.equal(line(question, "Addresses that stay together"), 'Addresses that stay together: "other@company.example"');
    assert.equal(line(question, "Name and aliases stay with them"), "Name and aliases stay with them: name none, aliases none (as set in this call)");
    // No stored person for the address: the lines are still there, and say what is not known.
    await call("set_contact", { address: "nobody@company.example", unmerge: true });
    const unknown = asked.at(-1);
    assert.match(line(unknown, "Addresses that stay together"), /unknown \(no stored person for this address, or the store could not be read\)/);
    assert.equal(line(unknown, "Name and aliases stay with them"), "Name and aliases stay with them: name unknown, aliases unknown");
  }, { answer: "accept" });
});

test("set_contact: the question lists the aliases, and an empty list is said to clear them", async () => {
  await withServer(async ({ call, asked }) => {
    await call("set_contact", { address: "ann@example.com", aliases: ["Ania", "Anka"] });
    await call("set_contact", { address: "ann@example.com", aliases: [] });
    assert.equal(line(asked[0], "Aliases"), 'Aliases: "Ania", "Anka"');
    assert.equal(line(asked[1], "Aliases"), "Aliases: cleared");
  });
});
