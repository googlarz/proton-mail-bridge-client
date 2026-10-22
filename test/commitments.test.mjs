import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { extractCommitments, parseDue } from "../dist/utils/commitment-phrases.js";
import { CommitmentService } from "../dist/services/commitment-service.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";
import { createMessage, makeCertificate, startFakeBridge } from "./helpers/fake-bridge.mjs";

const WEDNESDAY = new Date("2026-10-21T10:00:00Z");

test("dates named in a sentence are read in English, Polish and German", () => {
  assert.equal(parseDue("I'll send it by Friday.", WEDNESDAY), "2026-10-23");
  assert.equal(parseDue("Wyślę to do piątku.", WEDNESDAY), "2026-10-23");
  assert.equal(parseDue("Ich schicke es bis Freitag.", WEDNESDAY), "2026-10-23");
  assert.equal(parseDue("tomorrow", WEDNESDAY), "2026-10-22");
  assert.equal(parseDue("Odpiszę jutro", WEDNESDAY), "2026-10-22");
  assert.equal(parseDue("by 05.11.", WEDNESDAY), "2026-11-05");
  assert.equal(parseDue("by 3.1.", WEDNESDAY), "2027-01-03", "a date already past this year means next year");
  assert.equal(parseDue("due 2026-12-24", WEDNESDAY), "2026-12-24");
  assert.equal(parseDue("Zrobię to w środę", WEDNESDAY), "2026-10-28");
  assert.equal(parseDue("dziś wieczorem", WEDNESDAY), "2026-10-21");
  assert.equal(parseDue("when I can", WEDNESDAY), undefined);
  assert.equal(parseDue("by Wednesday", WEDNESDAY), "2026-10-28", "the same weekday means next week");
});

test("promises are found, ordinary sentences and quoted text are not", () => {
  const text = "Hi Pat,\nThanks for the call. I'll send the revised offer by Friday.\nWyślę też umowę jutro.\nThe weather is nice.\n> On Monday Pat wrote:\n> I will call you back.\n";
  const found = extractCommitments(text, WEDNESDAY);
  assert.deepEqual(found.map((f) => [f.sentence, f.due]), [
    ["I'll send the revised offer by Friday.", "2026-10-23"],
    ["Wyślę też umowę jutro.", "2026-10-22"],
  ]);
});

test("named months, hard-wrapped lines and the word 'well' behave", () => {
  assert.equal(parseDue("I will send you my comments by 16 October 2026, as agreed.", WEDNESDAY), "2026-10-16");
  assert.equal(parseDue("do 5 listopada", WEDNESDAY), "2026-11-05");
  assert.equal(parseDue("bis 3. Dezember", WEDNESDAY), "2026-12-03");
  assert.equal(parseDue("by October 30th", WEDNESDAY), "2026-10-30");
  assert.equal(parseDue("I may stay", WEDNESDAY), undefined, "'may' alone is not a month without a day");
  assert.deepEqual(extractCommitments("It went well and we need to adjust ours as well.", WEDNESDAY), [], "'well' is not we'll");
  const wrapped = extractCommitments("We'll check the dates and\nsend the new plan by Friday.\n", WEDNESDAY);
  assert.deepEqual(wrapped.map((c) => [c.sentence, c.due]), [["We'll check the dates and send the new plan by Friday.", "2026-10-23"]]);
});

test("the ledger adds, does not duplicate, and closes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ledger-"));
  try {
    const ledger = new CommitmentService({ dataDir: dir });
    const a = await ledger.add({ direction: "mine", text: "send the offer", due: "2026-11-05", messageId: "<a@x>" });
    const again = await ledger.add({ direction: "mine", text: "send the offer", due: "2026-11-05", messageId: "<a@x>" });
    assert.equal(again.id, a.id);
    await assert.rejects(ledger.add({ direction: "mine", text: "x", due: "5 Nov" }), /due must be a date/);
    assert.deepEqual([...(await ledger.knownMessageIds())], ["<a@x>"]);
    assert.equal((await ledger.close(a.id, "done"))?.status, "done");
    assert.equal(await ledger.close("c-nope", "done"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

const certificate = makeCertificate();
const needsOpenssl = certificate ? {} : { skip: "openssl is not available to make a test certificate" };

test("candidates are found in sent mail, recorded, and judged overdue or probably done from the thread", needsOpenssl, async () => {
  const dir = await mkdtemp(join(tmpdir(), "commit-"));
  const recent = new Date(Date.now() - 2 * 86_400_000);
  const bridge = await startFakeBridge({
    mode: "starttls", certificate,
    folders: {
      INBOX: { uidValidity: 1, messages: [createMessage(1, { subject: "Offer", from: "pat@client.example", date: new Date(Date.now() - 3 * 86_400_000) })] },
      Sent: { uidValidity: 2, specialUse: "\\Sent", messages: [
        createMessage(1, { subject: "Re: Offer", from: "owner@example.com", to: "pat@client.example", flags: ["\\Seen"], date: recent, body: "Hi Pat,\r\nI'll send the revised offer by Friday.\r\nThe weather is nice.\r\n" }),
        createMessage(2, { subject: "Quick note", from: "owner@example.com", to: "lee@client.example", flags: ["\\Seen"], date: recent, body: "Thanks, Lee.\r\n" }),
      ] },
    },
  });
  const conn = { imap: { host: "127.0.0.1", port: bridge.port, secure: false, username: "owner@example.com", password: "secret" }, smtp: { host: "127.0.0.1", port: 9, secure: false, username: "owner@example.com", password: "secret" } };
  const config = {
    ...conn, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: "owner@example.com", slug: "owner-example-com", ...conn, dataDir: dir }],
    runtime: { readOnly: true, allowSend: false, allowRemoteDraftSync: false, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX,Sent", autoSyncFull: false, autoSyncLimitPerFolder: 50, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: true, allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0 },
  };
  const { server } = createServer(config, { startBackgroundSync: false });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content.find((c) => c.type === "text").text;
    return result.isError ? { error: text } : JSON.parse(text);
  };
  try {
    const found = await call("find_commitments", { direction: "mine" });
    assert.equal(found.candidates.length, 1, JSON.stringify(found));
    assert.match(found.candidates[0].sentence, /revised offer by Friday/);
    assert.equal(found.candidates[0].with, "pat@client.example");
    assert.match(found.candidates[0].due, /^\d{4}-\d{2}-\d{2}$/);

    const first = await call("set_commitment", { text: "send the revised offer", direction: "mine", due: "2026-01-02", emailId: found.candidates[0].emailId });
    assert.equal(first.commitment.with, "pat@client.example", "the other party comes from the message");
    const second = await call("set_commitment", { text: "Pat sends the contract", direction: "theirs", due: "2999-01-01", with: "pat@client.example" });
    const listed = await call("list_commitments", {});
    assert.equal(listed.counts.overdue, 1);
    assert.deepEqual(listed.commitments.map((c) => [c.text, c.state]), [["send the revised offer", "overdue"], ["Pat sends the contract", "open"]]);
    assert.equal((await call("find_commitments", { direction: "mine" })).candidates.length, 0, "recorded messages are not offered again");

    const closed = await call("set_commitment", { id: second.commitment.id, status: "done" });
    assert.equal(closed.commitment.status, "done");
    assert.equal((await call("list_commitments", {})).commitments.length, 1);
    const bad = await call("set_commitment", { id: "c-nope", status: "done" });
    assert.match(bad.error, /No commitment/);

    const brief = await call("get_brief", { since: "2026-01-01T00:00:00Z" });
    assert.equal(brief.commitments.length, 1);
    assert.ok(brief.text.some((line) => /commitment/.test(line)), brief.text.join("|"));
  } finally {
    await client.close(); await server.close(); await closeTrackedIndexes(); await bridge.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
