import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";
import { createMessage, makeCertificate, startFakeBridge } from "./helpers/fake-bridge.mjs";

const certificate = makeCertificate();
const needsOpenssl = certificate ? {} : { skip: "openssl is not available to make a test certificate" };
const LIST = { "List-Unsubscribe": "<mailto:u@x.example>" };

async function withServer(runtimeOverrides, fn) {
  const dir = await mkdtemp(join(tmpdir(), "triage-"));
  const folders = {
    INBOX: { uidValidity: 1, messages: [
      createMessage(1, { subject: "Deals A", from: "deals@shop.example", headers: LIST }),
      createMessage(2, { subject: "Deals B", from: "news@paper.example", headers: LIST }),
      createMessage(3, { subject: "Read newsletter", from: "old@list.example", headers: LIST, flags: ["\\Seen"] }),
      createMessage(4, { subject: "A person", from: "pat@client.example" }),
    ] },
    Archive: { uidValidity: 3, specialUse: "\\Archive", messages: [] },
    Trash: { uidValidity: 4, specialUse: "\\Trash", messages: [] },
  };
  const bridge = await startFakeBridge({ mode: "starttls", certificate, folders });
  const conn = { imap: { host: "127.0.0.1", port: bridge.port, secure: false, username: "owner@example.com", password: "secret" }, smtp: { host: "127.0.0.1", port: 9, secure: false, username: "owner@example.com", password: "secret" } };
  const config = {
    ...conn, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: "owner@example.com", slug: "owner-example-com", ...conn, dataDir: dir }],
    runtime: { readOnly: false, allowSend: false, allowRemoteDraftSync: false, allowedActions: ["archive", "move", "mark_read"], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 50, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: true, allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0, ...runtimeOverrides },
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
  try { await fn({ call, folders }); } finally {
    await client.close(); await server.close(); await closeTrackedIndexes(); await bridge.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("a plan is proposed, approved in part, applied, and undone", needsOpenssl, async () => {
  await withServer({}, async ({ call, folders }) => {
    const plan = await call("plan_inbox", {});
    assert.ok(plan.planId, JSON.stringify(plan));
    const subjects = plan.items.map((item) => item.subject).sort();
    assert.deepEqual(subjects, ["Deals A", "Deals B", "Read newsletter"], "automatic mail only, never the person");
    assert.ok(plan.items.every((item) => item.do === "archive" && item.reason));
    assert.equal(folders.INBOX.messages.length, 4, "planning changes nothing");

    const dealsB = plan.items.find((item) => item.subject === "Deals B");
    const applied = await call("approve_plan", { planId: plan.planId, exclude: [dealsB.n] });
    assert.equal(applied.applied, 2);
    assert.deepEqual(applied.leftOut, [dealsB.n]);
    assert.deepEqual(folders.INBOX.messages.map((m) => m.subject).sort(), ["A person", "Deals B"]);
    assert.equal(folders.Archive.messages.length, 2);
    assert.equal((await call("approve_plan", { planId: plan.planId })).error?.includes("already applied"), true);

    const undone = await call("undo_plan", { planId: plan.planId });
    assert.equal(undone.undone, 2);
    assert.equal(undone.status, "undone");
    assert.equal(folders.INBOX.messages.length, 4, "everything is back in the INBOX");
    assert.equal(folders.Archive.messages.length, 0);

    const again = await call("plan_inbox", {});
    const senders = again.items.map((item) => item.from);
    assert.ok(!senders.includes("news@paper.example"), "a sender left out of an approved plan is not proposed again");
  });
});

test("the model's own items are checked, and delete is not a plan action", needsOpenssl, async () => {
  await withServer({}, async ({ call }) => {
    const refused = await call("plan_inbox", { scan: false, items: [{ emailId: "x", action: "delete" }] });
    assert.match(refused.error, /Deleting is not part of a plan/);
    const needsTarget = await call("plan_inbox", { scan: false, items: [{ emailId: "x", action: "move" }] });
    assert.match(needsTarget.error, /needs a target/);
  });
});

test("an action the runtime policy does not allow is reported and skipped on approval", needsOpenssl, async () => {
  await withServer({ allowedActions: ["mark_read"] }, async ({ call, folders }) => {
    const plan = await call("plan_inbox", {});
    assert.deepEqual(plan.notAllowedNow, ["archive"]);
    const result = await call("approve_plan", { planId: plan.planId });
    assert.equal(result.applied, 0);
    assert.equal(result.failed.length, 3);
    assert.equal(folders.INBOX.messages.length, 4);
  });
});
