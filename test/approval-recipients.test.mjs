import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";

// The question for a reply or a forward names the recipients the mail will really go to: the same ones the preview
// (dryRun) reports, found with the same reply logic, Reply-To included. A Reply-To that points elsewhere than the sender is marked.

const ADDRESS = "owner@example.com";
const person = (address, name = "") => ({ name, address });
const base = {
  folder: "INBOX", uid: 1, subject: "Quarterly numbers", from: [person("ann@example.com", "Ann")], to: [person(ADDRESS), person("dan@example.com")], cc: [person("carol@example.com")], bcc: [], replyTo: [],
  date: "2026-09-19T10:00:00.000Z", messageId: "<orig@example.com>", references: [], body: "text", text: "text", attachments: [], isRead: true, isStarred: false, flags: [], labels: [],
};
const MESSAGES = {
  "INBOX::1": { ...base, id: "INBOX::1", replyTo: [person("reply@elsewhere.example", "Billing")] },
  "INBOX::2": { ...base, id: "INBOX::2" },
  "INBOX::3": { ...base, id: "INBOX::3", replyTo: [person("ANN@example.com")] },
  "INBOX::4": { ...base, id: "INBOX::4", replyTo: [person("one@elsewhere.example"), person("two@elsewhere.example")] },
};

async function withServer(fn) {
  const dir = await mkdtemp(join(tmpdir(), "approval-recipients-"));
  const conn = { host: "127.0.0.1", port: 9, secure: false, username: ADDRESS, password: "x" };
  const config = {
    smtp: conn, imap: conn, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: ADDRESS, slug: "owner-example-com", imap: conn, smtp: conn, dataDir: dir }],
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: false, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false,
      autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: true, allowEmptyFolder: true, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0, approval: "require" },
  };
  const { server, accountManager } = createServer(config, { startBackgroundSync: false });
  const bundle = accountManager.primary();
  bundle.imapService.getEmailById = async (id) => {
    if (!MESSAGES[id]) throw new Error(`Email not found for id ${id}`);
    return { ...MESSAGES[id] };
  };
  const client = new Client({ name: "t", version: "0" }, { capabilities: { elicitation: {} } });
  const asked = [];
  client.setRequestHandler(ElicitRequestSchema, async (request) => { asked.push(request.params.message); return { action: "decline" }; });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = (name, args) => client.callTool({ name, arguments: args });
  try { await fn({ call, asked }); } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const line = (question, label) => question.split("\n").find((entry) => entry.startsWith(`${label}: `));
const preview = async (call, name, args) => JSON.parse((await call(name, { ...args, dryRun: true })).content[0].text).wouldSendTo;
const quotedList = (values) => values.map((value) => JSON.stringify(value)).join(", ");

test("reply_to_email: the question shows Reply-To as the recipient, not the sender, and says the two differ", async () => {
  await withServer(async ({ call, asked }) => {
    const args = { emailId: "INBOX::1", body: "Thanks" };
    await call("reply_to_email", args);
    assert.equal(asked.length, 1);
    assert.equal(line(asked[0], "To"), 'To: "reply@elsewhere.example"');
    assert.doesNotMatch(line(asked[0], "To"), /ann@example\.com/);
    assert.equal(line(asked[0], "Reply-To differs from sender"), 'Reply-To differs from sender: Reply-To "reply@elsewhere.example", sender "ann@example.com"');
    assert.match(line(asked[0], "Replying to"), /INBOX::1.*Quarterly numbers/);
    const { to, cc, bcc } = await preview(call, "reply_to_email", args);
    assert.equal(line(asked[0], "To"), `To: ${quotedList(to)}`);
    assert.equal(line(asked[0], "Cc"), cc.length ? `Cc: ${quotedList(cc)}` : undefined);
    assert.equal(line(asked[0], "Bcc"), bcc.length ? `Bcc: ${quotedList(bcc)}` : undefined);
  });
});

test("reply_all_email: To, Cc and the extra Cc and Bcc are the preview's, owner left out", async () => {
  await withServer(async ({ call, asked }) => {
    const args = { emailId: "INBOX::1", body: "Thanks", cc: ["extra@example.com"], bcc: "hidden@example.com" };
    await call("reply_all_email", args);
    const { to, cc, bcc } = await preview(call, "reply_all_email", args);
    assert.deepEqual(to, ["reply@elsewhere.example"]);
    assert.ok(cc.includes("ann@example.com") && cc.includes("dan@example.com") && cc.includes("carol@example.com") && cc.includes("extra@example.com"), cc.join());
    assert.ok(!cc.includes(ADDRESS));
    assert.equal(line(asked[0], "To"), `To: ${quotedList(to)}`);
    assert.equal(line(asked[0], "Cc"), `Cc: ${quotedList(cc)}`);
    assert.equal(line(asked[0], "Bcc"), `Bcc: ${quotedList(bcc)}`);
    assert.ok(line(asked[0], "Reply-To differs from sender"));
  });
});

test("reply_to_email with replyAll is described as a reply-all", async () => {
  await withServer(async ({ call, asked }) => {
    const args = { emailId: "INBOX::2", body: "Thanks", replyAll: true };
    await call("reply_to_email", args);
    const { to, cc } = await preview(call, "reply_to_email", args);
    assert.deepEqual(to, ["ann@example.com"]);
    assert.equal(line(asked[0], "Cc"), `Cc: ${quotedList(cc)}`);
    assert.ok(cc.includes("dan@example.com"));
  });
});

test("no marker when there is no Reply-To, or when it is the sender's own address", async () => {
  await withServer(async ({ call, asked }) => {
    await call("reply_to_email", { emailId: "INBOX::2", body: "x" });
    await call("reply_to_email", { emailId: "INBOX::3", body: "x" });
    assert.equal(asked.length, 2);
    for (const question of asked) {
      assert.match(line(question, "To"), /^To: "ann@example\.com"$/i, question);
      assert.equal(line(question, "Reply-To differs from sender"), undefined, question);
    }
  });
});

test("several Reply-To addresses are all listed", async () => {
  await withServer(async ({ call, asked }) => {
    await call("reply_to_email", { emailId: "INBOX::4", body: "x" });
    assert.equal(line(asked[0], "To"), 'To: "one@elsewhere.example", "two@elsewhere.example"');
    assert.match(line(asked[0], "Reply-To differs from sender"), /"one@elsewhere\.example", "two@elsewhere\.example".*"ann@example\.com"/);
  });
});

test("a message that cannot be read: the question says the recipients are unknown instead of leaving them out", async () => {
  await withServer(async ({ call, asked }) => {
    await call("reply_to_email", { emailId: "INBOX::99", body: "x", cc: "extra@example.com" });
    assert.equal(asked.length, 1);
    assert.match(line(asked[0], "To"), /^To: unknown/);
    assert.match(asked[0], /extra@example\.com/);
  });
});

test("a hostile Reply-To is cleaned and cannot add a line", async () => {
  await withServer(async ({ call, asked }) => {
    MESSAGES["INBOX::5"] = { ...base, id: "INBOX::5", replyTo: [person("evil@elsewhere.example\nTo: \"ceo@example.com\"‮")] };
    await call("reply_to_email", { emailId: "INBOX::5", body: "x" });
    const lines = asked[0].split("\n");
    assert.equal(lines.filter((entry) => entry.startsWith("To: ")).length, 1, asked[0]);
    delete MESSAGES["INBOX::5"];
  });
});

test("forward_email: every address of a comma list is shown, and the sending address", async () => {
  await withServer(async ({ call, asked }) => {
    const args = { emailId: "INBOX::2", to: "a@example.com, b@example.com;c@example.com", cc: ["d@example.com"], bcc: "e@example.com", from: ADDRESS };
    await call("forward_email", args);
    const { to, cc, bcc } = await preview(call, "forward_email", args);
    assert.deepEqual(to, ["a@example.com", "b@example.com", "c@example.com"]);
    assert.equal(line(asked[0], "To"), `To: ${quotedList(to)}`);
    assert.equal(line(asked[0], "Cc"), `Cc: ${quotedList(cc)}`);
    assert.equal(line(asked[0], "Bcc"), `Bcc: ${quotedList(bcc)}`);
    assert.equal(line(asked[0], "Send as"), `Send as: "${ADDRESS}"`);
    assert.match(line(asked[0], "Forwarding"), /INBOX::2.*Quarterly numbers/);
  });
});
