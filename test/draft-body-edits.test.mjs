import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { DraftStoreService, applyBodyEdits } from "../dist/services/draft-store-service.js";

// Working on a long draft through Claude used to mean resending the WHOLE body for every
// small change (a real draft here is ~14,500 characters of HTML). bodyEdits lets the model
// send only the words that change.

test("applyBodyEdits: one edit, several in order, and deletion", () => {
  assert.deepEqual(applyBodyEdits("Hello Anna, see you", [{ find: "Anna", replace: "Ben" }]), { body: "Hello Ben, see you", replacements: 1 });
  assert.equal(applyBodyEdits("a b c", [{ find: "a", replace: "x" }, { find: "x b", replace: "y" }]).body, "y c", "edits apply in order, each to the result of the last");
  assert.equal(applyBodyEdits("keep this, drop that", [{ find: ", drop that", replace: "" }]).body, "keep this");
});

test("applyBodyEdits: a missing or ambiguous find changes nothing and says why", () => {
  assert.throws(() => applyBodyEdits("abc", [{ find: "zzz", replace: "x" }]), /not found/);
  assert.throws(() => applyBodyEdits("ab ab", [{ find: "ab", replace: "x" }]), /appears 2 times/);
  assert.equal(applyBodyEdits("ab ab", [{ find: "ab", replace: "x", all: true }]).body, "x x");
  assert.equal(applyBodyEdits("ab ab", [{ find: "ab", replace: "x", all: true }]).replacements, 2);
});

test("applyBodyEdits: all-or-nothing — a later bad edit discards the earlier good one", () => {
  const original = "one two";
  assert.throws(() => applyBodyEdits(original, [{ find: "one", replace: "1" }, { find: "missing", replace: "x" }]), /bodyEdits\[1\]/);
  assert.equal(original, "one two");
});

test("applyBodyEdits: rejects malformed edits", () => {
  assert.throws(() => applyBodyEdits("abc", []), /non-empty array/);
  assert.throws(() => applyBodyEdits("abc", [{ find: "", replace: "x" }]), /find must be a non-empty string/);
  assert.throws(() => applyBodyEdits("abc", [{ find: "a" }]), /replace must be a string/);
});

function storeConfig(dir) {
  return {
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "o@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "o@example.com", password: "x" },
    dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    runtime: {
      readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false,
      autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30,
      confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false, allowFileDownloadDir: undefined,
      maxInlineBytes: 40960, opDelayMs: 0,
    },
  };
}

test("the store applies edits to the STORED body under its lock, so concurrent edits of different fragments both land", async () => {
  const dir = await mkdtemp(join(tmpdir(), "body-edits-"));
  try {
    const store = new DraftStoreService(storeConfig(dir));
    const draft = await store.createDraft({ to: ["a@example.com"], subject: "S", body: "First sentence. Second sentence. Third sentence." });
    await Promise.all([
      store.updateDraft(draft.id, { bodyEdits: [{ find: "First", replace: "1st" }] }),
      store.updateDraft(draft.id, { bodyEdits: [{ find: "Third", replace: "3rd" }] }),
    ]);
    assert.equal((await store.getDraft(draft.id)).body, "1st sentence. Second sentence. 3rd sentence.");
    await assert.rejects(store.updateDraft(draft.id, { bodyEdits: [{ find: "First", replace: "x" }] }), /not found/);
    assert.equal((await store.getDraft(draft.id)).body, "1st sentence. Second sentence. 3rd sentence.", "a failed edit writes nothing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function withServer(fn) {
  const dir = await mkdtemp(join(tmpdir(), "body-edits-srv-"));
  const config = storeConfig(dir);
  const account = { address: "o@example.com", slug: "o-example-com", dataDir: dir, imap: config.imap, smtp: config.smtp };
  const { server } = createServer({ ...config, accounts: [account] }, { startBackgroundSync: false });
  const client = new Client({ name: "t", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    return { result, text: result.content[0].text, data: (() => { try { return JSON.parse(result.content[0].text); } catch { return undefined; } })() };
  };
  try { await fn(call); } finally { await client.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
}

test("update_draft bodyEdits through the real handler: edits a long HTML draft, tiny request, reports bodyEditsApplied", async () => {
  await withServer(async (call) => {
    const longBody = "<p>Hi Thomas,</p>" + "<p>We need a quotation for 20,000 copies, hardcover, thread-sewn.</p>".repeat(200) + "<p>Best,<br>Dawid</p>";
    const { data: created } = await call("create_draft", { to: "t@example.com", subject: "Quotation", body: longBody, isHtml: true, syncToRemote: false });
    assert.ok(longBody.length > 12000);

    const edits = [{ find: "Hi Thomas,", replace: "Hi Thomas and Laura," }, { find: "Best,<br>Dawid", replace: "Kind regards,<br>Dawid" }];
    const request = JSON.stringify({ draftId: created.id, bodyEdits: edits, syncToRemote: false });
    const fullResend = JSON.stringify({ draftId: created.id, body: longBody, syncToRemote: false });
    assert.ok(request.length * 50 < fullResend.length, `edit request ${request.length} chars vs full body ${fullResend.length}`);

    const { data: updated } = await call("update_draft", { draftId: created.id, bodyEdits: edits, syncToRemote: false });
    assert.equal(updated.bodyEditsApplied, 2);

    const { data: full } = await call("get_draft", { draftId: created.id });
    assert.ok(full.body.startsWith("<p>Hi Thomas and Laura,</p>"));
    assert.ok(full.body.endsWith("Kind regards,<br>Dawid</p>"));
    assert.equal(full.body.length, longBody.length + " and Laura".length + "Kind regards".length - "Best".length);
  });
});

test("update_draft bodyEdits: bad edits and body+bodyEdits fail cleanly and leave the draft untouched", async () => {
  await withServer(async (call) => {
    const { data: created } = await call("create_draft", { to: "t@example.com", subject: "S", body: "alpha beta beta", syncToRemote: false });

    // InvalidParams comes back as a protocol-level error, like every other tool's.
    await assert.rejects(call("update_draft", { draftId: created.id, bodyEdits: [{ find: "gamma", replace: "x" }], syncToRemote: false }), /bodyEdits\[0\].*not found/);
    await assert.rejects(call("update_draft", { draftId: created.id, bodyEdits: [{ find: "beta", replace: "x" }], syncToRemote: false }), /appears 2 times/);
    await assert.rejects(call("update_draft", { draftId: created.id, body: "new", bodyEdits: [{ find: "alpha", replace: "x" }], syncToRemote: false }), /either body .* or bodyEdits/);
    await assert.rejects(call("update_draft", { draftId: created.id, bodyEdits: [], syncToRemote: false }), /non-empty array/);

    assert.equal((await call("get_draft", { draftId: created.id })).data.body, "alpha beta beta");

    const all = await call("update_draft", { draftId: created.id, bodyEdits: [{ find: "beta", replace: "gamma", all: true }], syncToRemote: false });
    assert.equal(all.data.bodyEditsApplied, 2);
    assert.equal((await call("get_draft", { draftId: created.id })).data.body, "alpha gamma gamma");
  });
});
