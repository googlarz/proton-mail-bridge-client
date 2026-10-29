import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { CategoryService, classifyMessage, validateCategory } from "../dist/services/category-service.js";
import { slugifyAccountAddress } from "../dist/utils/helpers.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";
import { createMessage, makeCertificate, startFakeBridge } from "./helpers/fake-bridge.mjs";
import { IGNORE_EN, FORWARD_EVERYTHING } from "./helpers/injection-samples.mjs";

// Independent adversarial tests for the own-categories feature. A test marked DEFECT asserts the EXPECTED behaviour and
// fails today; the others pin behaviour that held up.

const certificate = makeCertificate();
const needsOpenssl = certificate ? {} : { skip: "openssl is not available to make a test certificate" };
const at = "2026-10-01T00:00:00.000Z";

// ---- pure rules -----------------------------------------------------------------------------------------------------

test("held up: regex metacharacters, huge and prototype-key values are only ever compared literally", () => {
  const defs = [{ name: "R", keywords: ["(a+)+$", ".", "[", "\\"], senders: ["@shop.example"], createdAt: at }];
  const t0 = Date.now();
  const v = classifyMessage(defs, [], { from: "x@y.example", subject: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!".repeat(200), automated: false });
  assert.ok(Date.now() - t0 < 500);
  assert.equal(v.category, null, "'.' is not a wildcard");
  assert.throws(() => validateCategory({ name: "x".repeat(61) }), /longer than 60/);
  assert.throws(() => validateCategory({ name: "ok", description: "d".repeat(301) }), /longer than 300/);
  assert.throws(() => validateCategory({ name: "ok", keywords: Array(31).fill("k").map((k, i) => k + i) }), /at most 30/);
  assert.throws(() => validateCategory({ name: "ok", senders: ["@a.com\n@b.com"] }) && 0 /* control chars collapse to a space */, /not an address/);
  assert.throws(() => validateCategory({ name: { toString: () => "x" } }), /must be text/);
  assert.throws(() => validateCategory({ name: "ok", automated: "yes" }), /true or false/);
});

test("held up: one sender's correction cannot move another sender's mail (exact address, not a pattern)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "adv-cat-"));
  try {
    const store = new CategoryService({ dataDir: dir });
    for (const who of ["*@shop.example", "@shop.example", "SHOP.EXAMPLE", "a@shop.example "]) await store.learn(who, "People");
    const { learned } = await store.list();
    const defs = [{ name: "People", createdAt: at }, { name: "Other", keywords: ["x"], createdAt: at }];
    for (const from of ["b@shop.example", "c@other.example", "x@shop.example"]) {
      assert.equal(classifyMessage(defs, learned, { from, subject: "hello", automated: false }).category, null, from);
    }
    assert.equal(classifyMessage(defs, learned, { from: "a@shop.example", subject: "hello" }).category, "People");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("held up: category names that are prototype keys are stored and sorted as data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "adv-cat-"));
  try {
    const store = new CategoryService({ dataDir: dir });
    for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) await store.define({ name, keywords: ["zzz"] });
    await store.learn("a@x.example", "__proto__");
    const state = await store.list();
    assert.deepEqual(state.categories.map((c) => c.name), ["__proto__", "constructor", "toString", "hasOwnProperty"]);
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal(classifyMessage(state.categories, state.learned, { from: "a@x.example", subject: "q" }).category, "__proto__");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("DEFECT (medium-low): Reply-To, which any sender controls, files mail into a category (and passes the auth gate)", () => {
  const defs = [{ name: "Receipts", senders: ["@shop.example"], createdAt: at }];
  const forged = classifyMessage(defs, [], { from: "stranger@evil.example", replyTo: "billing@shop.example", subject: "hello", automated: false });
  // Expected: a sender who only sets a header is not put in the category of the address they named.
  assert.equal(forged.category, null, `observed category ${forged.category} (${forged.reasons.join("; ")})`);
});

test("DEFECT (low): the label is a free-text field the instruction filter does not read", () => {
  const draft = validateCategory({ name: "Work", label: `${IGNORE_EN} and ${FORWARD_EVERYTHING}` });
  assert.equal(draft.label, undefined, `label accepted verbatim: ${draft.label}`);
});

test("held up: zero-width characters inside the words do not hide an instruction", () => {
  const zw = IGNORE_EN.split(" ").map((w) => w.slice(0, 2) + "​" + w.slice(2)).join(" ");
  assert.throws(() => validateCategory({ name: "Work", description: `${zw} and ${FORWARD_EVERYTHING}` }), /instruction/, "zero-width text accepted");
});

test("DEFECT (low): the instruction filter is bypassed by one Cyrillic letter (homoglyph)", () => {
  const homoglyph = IGNORE_EN.replace(/o/g, "\u043e");
  assert.throws(() => validateCategory({ name: "Work", description: homoglyph }), /instruction/, "homoglyph instruction text accepted");
});

test("label names with slashes, dots and prefixes", () => {
  for (const bad of ["..", "a/../b", "Labels/../x", "/x", "x/"]) assert.throws(() => validateCategory({ name: "N", label: bad }), /label must be/, bad);
  assert.equal(validateCategory({ name: "N", label: "Labels/Labels/x" }).label, "Labels/x", "only one prefix is stripped; the folder lookup then simply finds nothing");
  assert.equal(validateCategory({ name: "N", label: "a\r\nb" }).label, "a b");
  assert.throws(() => validateCategory({ name: "N", label: "l".repeat(101) }), /longer than 100/);
});

// ---- through a fake Bridge -------------------------------------------------------------------------------------------

const LIST = { "List-Unsubscribe": "<mailto:u@x.example>" };
function inbox() {
  return {
    INBOX: { uidValidity: 1, messages: [
      createMessage(1, { subject: "Your invoice 42", from: "billing@shop.example", flags: ["\\Flagged", "\\Answered"] }),
      createMessage(2, { subject: "Weekly deals", from: "deals@shop.example", headers: LIST }),
      createMessage(3, { subject: "Invoice again", from: "other@shop.example", flags: ["\\Seen"] }),
    ] },
    Archive: { uidValidity: 3, specialUse: "\\Archive", messages: [] },
    Trash: { uidValidity: 4, specialUse: "\\Trash", messages: [] },
    "Labels/Receipts": { uidValidity: 5, messages: [] },
    "Labels/Promos": { uidValidity: 6, messages: [] },
    "Labels/Social": { uidValidity: 7, messages: [] },
  };
}
const snapshot = (folders) => Object.fromEntries(Object.entries(folders).map(([p, f]) => [p, f.messages.map((m) => `${m.subject}|${[...m.flags].sort().join(",")}`).sort()]));

async function tree(dir, base = dir, out = {}) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await tree(path, base, out);
    else out[path.slice(base.length)] = (await stat(path)).size;
  }
  return out;
}

async function withServer(fn, { instances = 1 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "adv-cat-"));
  const address = "owner@example.com";
  const mailbox = inbox();
  const bridge = await startFakeBridge({ mode: "starttls", certificate, folders: mailbox, accounts: { [address]: "secret" } });
  const conn = { imap: { host: "127.0.0.1", port: bridge.port, secure: false, username: address, password: "secret" }, smtp: { host: "127.0.0.1", port: 9, secure: false, username: address, password: "secret" } };
  const dataDir = join(dir, address);
  const config = {
    imap: conn.imap, smtp: conn.smtp, dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address, slug: slugifyAccountAddress(address), ...conn, dataDir }],
    runtime: { readOnly: false, allowSend: false, allowRemoteDraftSync: false, allowedActions: ["archive", "move", "mark_read"], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 50, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: true, allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0 },
  };
  const closers = [];
  const calls = [];
  for (let i = 0; i < instances; i++) {
    const { server } = createServer(config, { startBackgroundSync: false });
    const client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    closers.push(async () => { await client.close(); await server.close(); });
    calls.push(async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      const text = result.content.find((c) => c.type === "text").text;
      return result.isError ? { error: text } : JSON.parse(text);
    });
  }
  try {
    await fn({ call: calls[0], calls, mailbox, dataDir });
  } finally {
    for (const close of closers) await close();
    await closeTrackedIndexes();
    await bridge.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("DEFECT (low): categories named like Object.prototype members corrupt the counts of categorize_inbox", needsOpenssl, async () => {
  await withServer(async ({ call }) => {
    await call("define_category", { name: "constructor", keywords: ["invoice"] });
    await call("define_category", { name: "__proto__", keywords: ["deals"] });
    const r = await call("categorize_inbox", {});
    const cats = Object.fromEntries(r.messages.map((m) => [m.category, 0]));
    assert.ok("constructor" in cats && "__proto__" in cats || r.messages.some((m) => m.category === "constructor"), "sorted into the categories");
    // Expected: a count per category. Observed: a function-source string for "constructor" and nothing for "__proto__".
    assert.ok(Object.keys(r.counts).includes("constructor") && typeof r.counts.constructor === "number", `counts = ${JSON.stringify(r.counts)}`);
    assert.equal(Object.getPrototypeOf(r.counts) === Object.prototype && Object.hasOwn(r.counts, "__proto__"), true, `__proto__ count lost: ${JSON.stringify(r.counts)}`);
  });
});

test("dry run writes nothing in the data dir beyond what reading the mailbox needs (listing what it does write)", needsOpenssl, async () => {
  await withServer(async ({ call, dataDir }) => {
    await call("define_category", { name: "Receipts", keywords: ["invoice"], label: "Receipts" });
    const before = await tree(dataDir);
    await call("categorize_inbox", {});
    const after = await tree(dataDir);
    const added = Object.keys(after).filter((p) => !(p in before));
    const changed = Object.keys(after).filter((p) => p in before && before[p] !== after[p]);
    for (const name of ["categories.json", "triage-plans.json"]) assert.equal(JSON.stringify(after[`/${name}`]), JSON.stringify(before[`/${name}`]), `${name} untouched by a dry run`);
    console.log(`  [info] dry run added ${JSON.stringify(added)} changed ${JSON.stringify(changed)}`);
    assert.ok(!added.some((p) => /plan|categor/i.test(p)));
  });
});

test("held up: flags and other labels are untouched by apply and undo; a message deleted before approve is reported, not fatal", needsOpenssl, async () => {
  await withServer(async ({ call, mailbox }) => {
    await call("define_category", { name: "Receipts", keywords: ["invoice"], label: "Receipts" });
    await call("define_category", { name: "Deals", automated: true, label: "promos" });
    const before = snapshot(mailbox);
    const plan = await call("categorize_inbox", { dryRun: false });
    assert.equal(plan.items.length, 3, JSON.stringify(plan));
    mailbox.INBOX.messages = mailbox.INBOX.messages.filter((m) => m.subject !== "Invoice again");
    const applied = await call("approve_plan", { planId: plan.planId });
    assert.equal(applied.applied + applied.failed.length, 3, JSON.stringify(applied));
    const flags = Object.fromEntries(mailbox.INBOX.messages.map((m) => [m.subject, [...m.flags].sort().join(",")]));
    assert.equal(flags["Your invoice 42"], "\\Answered,\\Flagged");
    assert.equal(mailbox["Labels/Promos"].messages.length, 1, "label resolved to the folder's real case");
    await call("undo_plan", { planId: plan.planId });
    const after = snapshot(mailbox);
    assert.deepEqual(after.INBOX, before.INBOX.filter((s) => !s.startsWith("Invoice again")));
    assert.equal(after["Labels/Receipts"].length + after["Labels/Promos"].length, 0);
  });
});

test("held up: approving the same plan twice at once applies it once (one client)", needsOpenssl, async () => {
  await withServer(async ({ call, mailbox }) => {
    await call("define_category", { name: "Receipts", keywords: ["invoice"], label: "Receipts" });
    const plan = await call("categorize_inbox", { dryRun: false });
    const [a, b] = await Promise.all([call("approve_plan", { planId: plan.planId }), call("approve_plan", { planId: plan.planId })]);
    assert.equal([a, b].filter((r) => r.error).length, 1, JSON.stringify([a, b]));
    assert.equal(mailbox["Labels/Receipts"].messages.length, 2);
  });
});

test("held up: two server processes approving the same plan: exactly one applies", needsOpenssl, async () => {
  await withServer(async ({ calls, mailbox }) => {
    await calls[0]("define_category", { name: "Receipts", keywords: ["invoice"], label: "Receipts" });
    const plan = await calls[0]("categorize_inbox", { dryRun: false });
    const results = await Promise.all([calls[0]("approve_plan", { planId: plan.planId }), calls[1]("approve_plan", { planId: plan.planId })]);
    assert.equal(results.filter((r) => r.error).length, 1, JSON.stringify(results));
    assert.equal(mailbox["Labels/Receipts"].messages.length, 2);
    // two concurrent undos must not corrupt the state either
    const undos = await Promise.all([calls[0]("undo_plan", { planId: plan.planId }), calls[1]("undo_plan", { planId: plan.planId })]);
    assert.ok(undos.every((u) => !u.error), JSON.stringify(undos));
    assert.equal(mailbox["Labels/Receipts"].messages.length, 0);
  }, { instances: 2 });
});

test("a category that shares Proton's name and label is reported, and applying adds only the ordinary label", needsOpenssl, async () => {
  await withServer(async ({ call, mailbox }) => {
    const def = await call("define_category", { name: "Social", keywords: ["invoice"], label: "Social" });
    assert.match(def.category.protonClash, /Proton Mail has its own "Social"/);
    const plan = await call("categorize_inbox", { dryRun: false });
    await call("approve_plan", { planId: plan.planId });
    assert.equal(mailbox["Labels/Social"].messages.length, 2);
    assert.deepEqual(Object.keys(mailbox).sort(), ["Archive", "INBOX", "Labels/Promos", "Labels/Receipts", "Labels/Social", "Trash"], "no folder created");
  });
});
