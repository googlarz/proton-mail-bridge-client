import test from "node:test";
import assert from "node:assert/strict";
import { SimpleIMAPService } from "../dist/services/simple-imap-service.js";
import { createEmailId, parseEmailId } from "../dist/utils/helpers.js";

// Reproduces the P1 fixed here: an emailId minted under one UIDVALIDITY
// generation must never silently resolve against a *different* generation's
// same-numbered UID after a mailbox recreation (full recreation, some
// migration scenarios). Every test below drives SimpleIMAPService against a
// hand-rolled fake ImapFlow client rather than a real IMAP server — the
// class's `client` field is plain TS `private` (not `#private`), so it's a
// perfectly ordinary property on the compiled object and can be swapped in
// directly, the same way test/snooze.test.mjs injects its own fake service.

function createConfig() {
  return {
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "secret" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "secret" },
    dataDir: "/tmp/uid-validity-test",
    debug: false,
    cacheEnabled: true,
    analyticsEnabled: true,
    autoSync: false,
    syncInterval: 5,
    runtime: {
      readOnly: false,
      allowSend: true,
      allowRemoteDraftSync: true,
      allowedActions: [],
      startupSync: false,
      autoSyncFolder: "INBOX",
      autoSyncFull: false,
      autoSyncLimitPerFolder: 25,
      idleWatchEnabled: false,
      idleMaxSeconds: 30,
      confirmDestructive: false,
      allowEmptyFolder: false,
      restrictOutboundToSelf: false,
      allowFileDownloadDir: undefined,
      maxInlineBytes: 40960,
      opDelayMs: 0,
      sendDelaySeconds: 0,
    },
  };
}

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

// A minimal fake ImapFlow client backing a single folder's message set.
// `state.uidValidity` models the mailbox's current "generation" — bumping it
// and changing which uids map to which messages is exactly what a real
// UIDVALIDITY change (folder recreation) does.
function createFakeClient(state) {
  return {
    usable: true,
    capabilities: new Set(["UIDPLUS"]),
    mailbox: false,
    _selected: undefined,
    async getMailboxLock(folder) {
      this._selected = folder;
      this.mailbox = {
        uidValidity: state.uidValidity,
        exists: state.messages.size,
        uidNext: state.uidNext,
      };
      return { release: () => {} };
    },
    async status(folder) {
      return { uidValidity: state.uidValidity, uidNext: state.uidNext, messages: state.messages.size };
    },
    async fetchOne(range) {
      const uid = Number(range);
      if (!state.messages.has(uid)) return false;
      return { uid, envelope: {} };
    },
    async messageDelete(range) {
      for (const uid of String(range).split(",").map(Number)) {
        state.messages.delete(uid);
      }
      return true;
    },
    async search(query) {
      if (query && typeof query.uid === "string") {
        return query.uid.split(",").map(Number).filter((uid) => state.messages.has(uid));
      }
      if (query && query.all) {
        return [...state.messages.keys()];
      }
      return [];
    },
  };
}

function createService(state) {
  const service = new SimpleIMAPService(createConfig(), quietLogger, 0);
  service.client = createFakeClient(state);
  return service;
}

test("delete_email: a stale-generation id (UID reused after a UIDVALIDITY change) is rejected, not silently resolved against the wrong message", async () => {
  // Generation 1 minted this id for UID 42. The mailbox was then recreated
  // (UIDVALIDITY bumped 1000000001 -> 2000000002) and a *different* message
  // now occupies UID 42 in the new generation — the exact reproduction from
  // the P1 writeup.
  const staleId = createEmailId("INBOX", 42, "1000000001");
  const state = { uidValidity: "2000000002", uidNext: 100, messages: new Map([[42, { subject: "new message" }]]) };
  const service = createService(state);

  const parsed = parseEmailId(staleId);
  await assert.rejects(
    () => service.deleteEmail(staleId, parsed.uidValidity),
    /before the mailbox changed|no longer points to a valid message/,
  );
  // Not silently deleted — the message under UID 42 in the *new* generation
  // must still be there.
  assert.equal(state.messages.has(42), true);
});

test("delete_email: an id minted under the CURRENT UIDVALIDITY still works exactly as before (no regression)", async () => {
  const state = { uidValidity: "2000000002", uidNext: 100, messages: new Map([[42, { subject: "hi" }]]) };
  const service = createService(state);
  const currentId = createEmailId("INBOX", 42, "2000000002");

  const parsed = parseEmailId(currentId);
  const result = await service.deleteEmail(currentId, parsed.uidValidity);

  assert.equal(result.deleted, true);
  assert.equal(state.messages.has(42), false);
});

test("delete_email: an OLD-FORMAT id (no embedded uidValidity) still works — unverifiable, not blocked", async () => {
  const state = { uidValidity: "2000000002", uidNext: 100, messages: new Map([[42, { subject: "hi" }]]) };
  const service = createService(state);
  const legacyId = createEmailId("INBOX", 42); // 3-field, pre-this-fix format

  const parsed = parseEmailId(legacyId);
  assert.equal(parsed.uidValidity, undefined);
  const result = await service.deleteEmail(legacyId, parsed.uidValidity);

  assert.equal(result.deleted, true);
});

test("mark_email_read: an OLD-FORMAT id still works (no new error introduced for ids that used to work fine)", async () => {
  const state = { uidValidity: "2000000002", uidNext: 100, messages: new Map([[42, { subject: "hi" }]]) };
  const service = createService(state);
  // markEmailRead's fake client needs messageFlagsAdd/Remove + a way for
  // verifyFlags (client.fetchOne) to observe the flag it just "applied".
  service.client.messageFlagsAdd = async () => true;
  service.client.messageFlagsRemove = async () => true;
  service.client.fetchOne = async (range) => ({ uid: Number(range), flags: ["\\Seen"] });

  const legacyId = createEmailId("INBOX", 42);
  const parsed = parseEmailId(legacyId);
  const result = await service.markEmailRead(legacyId, true, parsed.uidValidity);

  assert.equal(result.isRead, true);
  assert.deepEqual(result.notApplied, []);
});

test("update_message_flags: an OLD-FORMAT id still works (no new error introduced for ids that used to work fine)", async () => {
  const state = { uidValidity: "2000000002", uidNext: 100, messages: new Map([[42, { subject: "hi" }]]) };
  const service = createService(state);
  service.client.messageFlagsAdd = async () => true;
  service.client.messageFlagsRemove = async () => true;
  service.client.fetchOne = async (range) => ({ uid: Number(range), flags: ["\\Flagged"] });

  const legacyId = createEmailId("INBOX", 42);
  const parsed = parseEmailId(legacyId);
  const result = await service.updateMessageFlags(legacyId, ["\\Flagged"], [], parsed.uidValidity);

  assert.deepEqual(result.notApplied, []);
});

test("update_message_labels: an OLD-FORMAT id still works (no new error introduced for ids that used to work fine)", async () => {
  const state = { uidValidity: "2000000002", uidNext: 100, messages: new Map([[42, { subject: "hi" }]]) };
  const service = createService(state);
  service.client.fetchOne = async (range, query) => {
    const uid = Number(range);
    if (!state.messages.has(uid)) return false;
    if (query && query.envelope) {
      return { uid, envelope: { messageId: "<msg-1@example.com>" } };
    }
    return { uid };
  };
  service.client.messageCopy = async () => true;

  const legacyId = createEmailId("INBOX", 42);
  const parsed = parseEmailId(legacyId);
  const result = await service.updateMessageLabels(legacyId, ["Labels/Work"], [], parsed.uidValidity);

  assert.deepEqual(result.added, ["Labels/Work"]);
  assert.deepEqual(result.notFound, []);
});

test("bulk_delete: a batch mixing a stale-generation id and a valid one excludes the stale one and still deletes the valid one", async () => {
  const state = {
    uidValidity: "2000000002",
    uidNext: 100,
    messages: new Map([
      [42, { subject: "new message occupying reused uid 42" }],
      [43, { subject: "a genuinely current message" }],
    ]),
  };
  const service = createService(state);

  const staleId = createEmailId("INBOX", 42, "1000000001"); // stale generation
  const validId = createEmailId("INBOX", 43, "2000000002"); // current generation

  const uids = await service.resolveUidsForBulkOp("INBOX", [staleId, validId], undefined);
  // The stale id's uid must never make it into the resolved set that
  // actually gets executed against.
  assert.deepEqual(uids.sort((a, b) => a - b), [43]);

  const result = await service.bulkDelete({
    emailIds: [staleId, validId],
    folder: "INBOX",
    permanent: true,
    resolvedUids: uids,
  });

  assert.equal(result.succeeded, 1);
  assert.equal(result.results.some((r) => r.uid === 43 && r.ok), true);
  // Message 42 (a different message, under the new generation) must survive
  // untouched — it was never a valid target of this stale reference.
  assert.equal(state.messages.has(42), true);
  assert.equal(state.messages.has(43), false);
});

test("resolveUidsForBulkOp: an emailIds batch using the CURRENT generation resolves exactly as before (no regression)", async () => {
  const state = {
    uidValidity: "2000000002",
    uidNext: 100,
    messages: new Map([[1, {}], [2, {}], [3, {}]]),
  };
  const service = createService(state);
  const ids = [1, 2, 3].map((uid) => createEmailId("INBOX", uid, "2000000002"));

  const uids = await service.resolveUidsForBulkOp("INBOX", ids, undefined);
  assert.deepEqual(uids.sort((a, b) => a - b), [1, 2, 3]);
});

test("resolveUidsForBulkOp: OLD-FORMAT ids (no embedded uidValidity) still resolve — unverifiable, not blocked", async () => {
  const state = { uidValidity: "2000000002", uidNext: 100, messages: new Map([[1, {}], [2, {}]]) };
  const service = createService(state);
  const ids = [1, 2].map((uid) => createEmailId("INBOX", uid)); // legacy 3-field, no uidValidity

  const uids = await service.resolveUidsForBulkOp("INBOX", ids, undefined);
  assert.deepEqual(uids.sort((a, b) => a - b), [1, 2]);
});

// --- Regression coverage: the id's own embedded uidValidity must protect a
// caller even when it doesn't separately pass the uidValidity parameter —
// this is exactly cli.ts's calling shape (e.g. `imapService.deleteEmail(emailId)`
// with no second argument), which previously got zero staleness protection
// even though the id it passed in carried a perfectly valid generation.

test("delete_email: called with NO second argument (CLI's exact calling shape) still rejects a stale-generation id", async () => {
  const staleId = createEmailId("INBOX", 42, "1000000001");
  const state = { uidValidity: "2000000002", uidNext: 100, messages: new Map([[42, { subject: "new message" }]]) };
  const service = createService(state);

  await assert.rejects(
    () => service.deleteEmail(staleId),
    /before the mailbox changed|no longer points to a valid message/,
  );
  assert.equal(state.messages.has(42), true);
});

test("move_email: called with NO second argument for uidValidity (CLI's exact calling shape) still rejects a stale-generation id", async () => {
  const staleId = createEmailId("INBOX", 42, "1000000001");
  const state = { uidValidity: "2000000002", uidNext: 100, messages: new Map([[42, { subject: "new message" }]]) };
  const service = createService(state);

  await assert.rejects(
    () => service.moveEmail(staleId, "Archive"),
    /before the mailbox changed|no longer points to a valid message/,
  );
});

test("mark_email_read: called with NO uidValidity argument (CLI's exact calling shape) still rejects a stale-generation id", async () => {
  const staleId = createEmailId("INBOX", 42, "1000000001");
  const state = { uidValidity: "2000000002", uidNext: 100, messages: new Map([[42, { subject: "new message" }]]) };
  const service = createService(state);

  await assert.rejects(
    () => service.markEmailRead(staleId, true),
    /before the mailbox changed|no longer points to a valid message/,
  );
});

test("update_message_flags: called with NO uidValidity argument (CLI's exact calling shape) still rejects a stale-generation id", async () => {
  const staleId = createEmailId("INBOX", 42, "1000000001");
  const state = { uidValidity: "2000000002", uidNext: 100, messages: new Map([[42, { subject: "new message" }]]) };
  const service = createService(state);

  await assert.rejects(
    () => service.updateMessageFlags(staleId, ["\\Flagged"], []),
    /before the mailbox changed|no longer points to a valid message/,
  );
});

test("delete_email: an explicit uidValidity override, when supplied, is still respected (doesn't regress that path)", async () => {
  // A legacy id (no embedded uidValidity) with an explicit override that
  // mismatches the mailbox's actual current generation must still be
  // rejected — the id's own (absent) uidValidity must never silently
  // override an explicit, deliberately-supplied parameter.
  const legacyId = createEmailId("INBOX", 42);
  const state = { uidValidity: "2000000002", uidNext: 100, messages: new Map([[42, { subject: "hi" }]]) };
  const service = createService(state);

  await assert.rejects(
    () => service.deleteEmail(legacyId, "1000000001"),
    /before the mailbox changed|no longer points to a valid message/,
  );
  assert.equal(state.messages.has(42), true);

  // ...and still works normally when the explicit override matches.
  const result = await service.deleteEmail(legacyId, "2000000002");
  assert.equal(result.deleted, true);
});

// --- Finding 2: getParsedMailDetail (backing get_email_by_id) must enforce
// the same UIDVALIDITY check mutations already do — previously it never
// checked at all, so a stale-generation id silently returned a *different*
// real message's content under a freshly-recomputed, correct-looking new id.

function createDetailFakeClient(state) {
  const raw = Buffer.from(
    [
      "From: alice@example.com",
      "To: owner@example.com",
      `Subject: ${state.subject}`,
      "",
      state.body,
    ].join("\r\n"),
  );
  return {
    usable: true,
    capabilities: new Set(["UIDPLUS"]),
    mailbox: false,
    async getMailboxLock(folder) {
      this._selected = folder;
      this.mailbox = { uidValidity: state.uidValidity, exists: 1, uidNext: state.uidNext };
      return { release: () => {} };
    },
    async fetchOne(range) {
      const uid = Number(range);
      if (uid !== state.uid) return false;
      return {
        uid,
        seq: 1,
        flags: ["\\Seen"],
        envelope: { subject: state.subject, from: [], to: [], cc: [], bcc: [], replyTo: [] },
        bodyStructure: {},
        source: raw,
      };
    },
  };
}

function createDetailService(state) {
  const service = new SimpleIMAPService(createConfig(), quietLogger, 0);
  service.client = createDetailFakeClient(state);
  return service;
}

test("get_email_by_id: a stale-generation id must throw, not silently return a different message's content", async () => {
  // Generation 1 minted this id for UID 42 pointing at "Original message".
  // The mailbox was recreated and a genuinely different message now sits at
  // UID 42 in generation 2 — reading it back must fail loudly, not
  // relabel the new message under a "current"-looking id with no error.
  const staleId = createEmailId("INBOX", 42, "1000000001");
  const state = { uidValidity: "2000000002", uidNext: 100, uid: 42, subject: "A different message", body: "Hi" };
  const service = createDetailService(state);

  await assert.rejects(
    () => service.getEmailById(staleId),
    /before the mailbox changed|no longer points to a valid message/,
  );
});

test("get_email_by_id: an id minted under the CURRENT UIDVALIDITY still works exactly as before (no regression)", async () => {
  const currentId = createEmailId("INBOX", 42, "2000000002");
  const state = { uidValidity: "2000000002", uidNext: 100, uid: 42, subject: "Current message", body: "Hi" };
  const service = createDetailService(state);

  const detail = await service.getEmailById(currentId);
  assert.equal(detail.subject, "Current message");
});

test("get_email_by_id: an OLD-FORMAT id (no embedded uidValidity) still works with no new error (no regression for pre-existing ids)", async () => {
  const legacyId = createEmailId("INBOX", 42); // 3-field, pre-UIDVALIDITY format
  const state = { uidValidity: "2000000002", uidNext: 100, uid: 42, subject: "Legacy message", body: "Hi" };
  const service = createDetailService(state);

  const detail = await service.getEmailById(legacyId);
  assert.equal(detail.subject, "Legacy message");
});
