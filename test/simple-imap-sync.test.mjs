import test from "node:test";
import assert from "node:assert/strict";
import {
  describeImapError,
  isLikelyAuthenticationError,
  isLikelyConnectionError,
  mapHeaderValue,
  pickNewestUids,
  planFolderSync,
  SimpleIMAPService,
} from "../dist/services/simple-imap-service.js";

function createConfig() {
  return {
    smtp: {
      host: "127.0.0.1",
      port: 1025,
      secure: false,
      username: "owner@example.com",
      password: "secret",
    },
    imap: {
      host: "127.0.0.1",
      port: 1143,
      secure: false,
      username: "owner@example.com",
      password: "secret",
    },
    dataDir: "/tmp/protonmail-pro-mcp-test",
    debug: false,
    cacheEnabled: true,
    analyticsEnabled: true,
    autoSync: false,
    syncInterval: 5,
    runtime: {
      readOnly: false,
      allowSend: true,
      allowRemoteDraftSync: true,
      allowedActions: ["mark_read", "mark_unread", "star", "unstar", "archive", "trash", "restore"],
      startupSync: false,
      autoSyncFolder: "INBOX",
      autoSyncFull: false,
      autoSyncLimitPerFolder: 25,
      idleWatchEnabled: false,
      idleMaxSeconds: 30,
      confirmDestructive: false,
      allowEmptyFolder: true,
      restrictOutboundToSelf: false,
      allowFileDownloadDir: undefined,
      maxInlineBytes: 40960,
      opDelayMs: 0,
    },
  };
}

test("planFolderSync uses incremental strategy with overlap when checkpoint matches", () => {
  const plan = planFolderSync({
    folder: "INBOX",
    exists: 120,
    uidNext: 151,
    uidValidity: "999",
    full: false,
    limit: 50,
    checkpoint: {
      folder: "INBOX",
      uidValidity: "999",
      uidNext: 141,
      highestUid: 140,
      lastSyncAt: "2026-03-24T12:00:00.000Z",
    },
  });

  assert.equal(plan.strategy, "incremental");
  assert.equal(plan.changed, true);
  assert.equal(plan.startUid, 116);
  assert.equal(plan.endUid, 150);
});

test("planFolderSync falls back to recent when uidValidity changed", () => {
  const plan = planFolderSync({
    folder: "INBOX",
    exists: 80,
    uidNext: 101,
    uidValidity: "222",
    full: false,
    limit: 25,
    checkpoint: {
      folder: "INBOX",
      uidValidity: "111",
      uidNext: 91,
      highestUid: 90,
      lastSyncAt: "2026-03-24T12:00:00.000Z",
    },
  });

  assert.equal(plan.strategy, "recent");
  assert.equal(plan.startUid, 76);
  assert.equal(plan.endUid, 100);
});

test("planFolderSync treats mailbox count drift as a changed incremental window", () => {
  const plan = planFolderSync({
    folder: "INBOX",
    exists: 140,
    uidNext: 151,
    uidValidity: "999",
    full: false,
    limit: 50,
    checkpoint: {
      folder: "INBOX",
      uidValidity: "999",
      uidNext: 151,
      highestUid: 150,
      total: 141,
      lastSyncAt: "2026-03-24T12:00:00.000Z",
    },
  });

  assert.equal(plan.strategy, "incremental");
  assert.equal(plan.changed, true);
  assert.equal(plan.startUid, 126);
  assert.equal(plan.endUid, 150);
});

test("emptyFolder rejects INBOX before making IMAP calls", async () => {
  const service = new SimpleIMAPService(createConfig());
  let connectCalls = 0;
  service.connect = async () => {
    connectCalls += 1;
    throw new Error("IMAP should not be contacted");
  };

  await assert.rejects(
    () => service.emptyFolder("INBOX"),
    /cannot be used on INBOX/i,
  );
  assert.equal(connectCalls, 0);
});

test("getEmailById resolves real Proton labels instead of always reporting an empty array", async () => {
  // Found live: toSummary's `labels` field comes from imapflow's `labels`
  // fetch option, which maps to Gmail's X-GM-LABELS IMAP extension — Proton
  // Bridge doesn't implement it, so that field is always empty/undefined
  // regardless of a message's real Proton labels (applied via
  // updateMessageLabels's COPY to a Labels/<name> virtual folder). A message
  // freshly labeled and confirmed present in Labels/mcptest-label still read
  // back labels:[] via get_email_by_id/read. Fixed by resolving labels with
  // a bounded Message-ID search across known label folders, run only for
  // this single-message detail fetch (not the bulk list paths).
  const service = new SimpleIMAPService(createConfig());
  service.getFolders = async () => [
    { path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "\\Inbox", listed: true, subscribed: true, flags: [] },
    { path: "Labels/mcptest-label", name: "mcptest-label", delimiter: "/", listed: true, subscribed: true, flags: [] },
    { path: "Labels/other-label", name: "other-label", delimiter: "/", listed: true, subscribed: true, flags: [] },
  ];

  const raw = Buffer.from(
    ["From: alice@example.com", "To: owner@example.com", "Subject: Test", "Message-ID: <abc@example.com>", "", "Hello"].join(
      "\r\n",
    ),
  );

  const fakeClient = {
    usable: true,
    mailbox: { path: "INBOX" },
    getMailboxLock: async () => ({ release() {} }),
    fetchOne: async () => ({
      uid: 1,
      seq: 1,
      flags: new Set(["\\Seen"]),
      envelope: { messageId: "<abc@example.com>", subject: "Test", from: [], to: [], cc: [], bcc: [], replyTo: [] },
      bodyStructure: {},
      source: raw,
    }),
    // Only Labels/mcptest-label actually has this Message-ID; other-label doesn't.
    search: async () => (fakeClient.mailbox.path === "Labels/mcptest-label" ? [7] : []),
  };
  service.client = fakeClient;
  service.connect = async () => {
    service.client = fakeClient;
  };
  service.withMailbox = async (folder, readOnly, action) => {
    fakeClient.mailbox = { path: folder };
    return action(fakeClient);
  };

  const detail = await service.getEmailById("INBOX::1");
  assert.deepEqual(detail.labels, ["Labels/mcptest-label"]);
});

test("deleteThread(permanent:false) errors instead of silently permanent-deleting when Trash can't be resolved", async () => {
  // Reproduces a real bug: unlike bulkDelete (identical Trash-resolution
  // logic, but lets a resolution failure propagate as a hard error) and
  // trashEmail, deleteThread used to swallow resolveSpecialFolder's
  // rejection with `.catch(() => undefined)`. The resulting `!trashFolder`
  // check then silently fell into the *permanent*-delete branch even
  // though the caller explicitly asked for permanent:false — directly
  // contradicting the tool's own documented contract ("false moves to
  // Trash"). A transient IMAP hiccup, permission issue, or unusual mailbox
  // layout with no Trash-like folder turned a "safe" reversible delete
  // into an unannounced, unrecoverable one.
  const service = new SimpleIMAPService(createConfig());

  // A mailbox with a matching message but genuinely no Trash-like folder —
  // resolveSpecialFolder("\\Trash", ["Trash", "INBOX.Trash"]) throws.
  service.getFolders = async () => [
    { path: "INBOX", name: "INBOX", delimiter: "/", flags: [], messages: 1, unseen: 0, uidNext: 2 },
  ];

  const calls = [];
  const fakeClient = {
    usable: true,
    getMailboxLock: async () => ({ release() {} }),
    search: async (query) => (query?.header?.["Message-ID"] === "<msg-1@example.com>" ? [42] : []),
    messageDelete: async (uidSet) => {
      calls.push({ op: "delete", uidSet });
      return true;
    },
    messageMove: async (uidSet, target) => {
      calls.push({ op: "move", uidSet, target });
      return true;
    },
  };
  service.client = fakeClient;
  service.connect = async () => {
    service.client = fakeClient;
  };

  await assert.rejects(
    () => service.deleteThread({ messageId: "<msg-1@example.com>", permanent: false }),
    /unable to find target folder/i,
  );
  // No delete or move ever happened — the failure surfaced before touching
  // any message, instead of silently expunging it.
  assert.deepEqual(calls, []);
});

test("markEmailRead throws instead of silently reporting success for a UID that doesn't exist", async () => {
  // Reproduces a real bug: IMAP's STORE command silently no-ops for a UID
  // that doesn't match any message — no error — so messageFlagsAdd already
  // "succeeded" against nothing. verifyFlags's re-FETCH was the only real
  // signal the target never existed (fetchOne returns false), but the old
  // code wrapped it in `if (msg !== false) { ...check... }` with no else —
  // skipping the check entirely left notApplied as [], which callers read
  // as "verified, all flags correctly applied." Found live via
  // batch_email_action on a deliberately-fake UID: reported ok:true.
  const service = new SimpleIMAPService(createConfig());

  const fakeClient = {
    usable: true,
    mailbox: { path: "INBOX" },
    getMailboxLock: async () => ({ release() {} }),
    messageFlagsAdd: async () => true,
    fetchOne: async () => false, // no message matches this UID
  };
  service.client = fakeClient;
  service.connect = async () => {
    service.client = fakeClient;
  };

  await assert.rejects(
    () => service.markEmailRead("INBOX::999999", true),
    /not found/i,
  );
});

test("moveEmail throws instead of silently reporting success for a UID that doesn't exist (UIDPLUS server)", async () => {
  // Same class of bug as markEmailRead above: IMAP's MOVE command silently
  // succeeds with nothing moved for a non-matching UID. messageMove's own
  // `moved === false` check only catches an empty/invalid range, not this
  // case — moved.uidMap (populated only when UIDPLUS is active, which
  // Proton Bridge is confirmed to support live) simply has no entry for the
  // requested UID, and the old code let that through as a "successful"
  // move with a silently-missing targetUid instead of an error. Found live
  // via move_email on a deliberately-fake UID.
  const service = new SimpleIMAPService(createConfig());

  const fakeClient = {
    usable: true,
    mailbox: { path: "INBOX" },
    capabilities: new Map([["UIDPLUS", true]]),
    getMailboxLock: async () => ({ release() {} }),
    messageMove: async () => ({ path: "INBOX", destination: "Archive", uidMap: new Map() }),
  };
  service.client = fakeClient;
  service.connect = async () => {
    service.client = fakeClient;
  };

  await assert.rejects(
    () => service.moveEmail("INBOX::999999", "Archive"),
    /not found/i,
  );
});

test("moveEmail does not falsely fail on a server without UIDPLUS, even though uidMap is unavailable", async () => {
  // Guards the fix above from over-correcting: a server without UIDPLUS
  // never populates uidMap at all, by design (see imapflow's own docs) —
  // that must not be misread as "nothing was moved."
  const service = new SimpleIMAPService(createConfig());

  const fakeClient = {
    usable: true,
    mailbox: { path: "INBOX" },
    capabilities: new Map(), // no UIDPLUS
    getMailboxLock: async () => ({ release() {} }),
    messageMove: async () => ({ path: "INBOX", destination: "Archive" }), // no uidMap at all
  };
  service.client = fakeClient;
  service.connect = async () => {
    service.client = fakeClient;
  };

  const result = await service.moveEmail("INBOX::42", "Archive");
  assert.equal(result.targetUid, undefined);
});

test("bulkUpdateFlags reports failure for a UID absent from the mailbox instead of defaulting to success", async () => {
  // Reproduces a real bug: the post-flag-change FETCH loop only iterates
  // messages that actually exist, so a fake/stale UID never gets a
  // notAppliedByUid entry — but the old code still unconditionally pushed
  // {ok:true, notApplied:[]} for every requested UID, misreporting a UID
  // the FETCH never touched as "verified, flags correctly applied." Found
  // live via bulk_update_flags with one real id and one deliberately fake
  // one — reported ok:true for both.
  const service = new SimpleIMAPService(createConfig());

  const fakeClient = {
    usable: true,
    mailbox: { path: "INBOX" },
    getMailboxLock: async () => ({ release() {} }),
    messageFlagsAdd: async () => true,
    // Only uid 10 actually exists — 999 (requested below) never appears here.
    async *fetch() {
      yield { uid: 10, flags: new Set(["\\Flagged"]) };
    },
  };
  service.client = fakeClient;
  service.connect = async () => {
    service.client = fakeClient;
  };
  service.resolveUidsForBulkOp = async () => [10, 999];

  const result = await service.bulkUpdateFlags({ emailIds: ["INBOX::10", "INBOX::999"], flagsToAdd: ["\\Flagged"] });

  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  const ok = result.results.find((r) => r.uid === 10);
  const bad = result.results.find((r) => r.uid === 999);
  assert.equal(ok.ok, true);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /not found/i);
});

test("updateMessageLabels throws instead of silently reporting a label added to a nonexistent message", async () => {
  // Reproduces a real bug: messageCopy's own `result === false` check only
  // catches an empty/invalid range, not a syntactically valid UID that
  // doesn't match any message — IMAP's COPY command silently "succeeds"
  // with nothing copied in that case. The up-front fetchOne (originally
  // just to grab the Message-ID for label *removal*) is the only real
  // existence signal, but the old code let a `msg === false` result pass
  // through silently (messageId just stayed undefined) instead of failing
  // the whole call. Found live: update_message_labels on a
  // deliberately-fake UID against a real label folder reported
  // added:["Labels/X"].
  const service = new SimpleIMAPService(createConfig());

  const fakeClient = {
    usable: true,
    mailbox: { path: "INBOX" },
    getMailboxLock: async () => ({ release() {} }),
    fetchOne: async () => false, // no message matches this UID
    messageCopy: async () => ({ path: "INBOX", destination: "Labels/X", uidMap: new Map() }),
  };
  service.client = fakeClient;
  service.connect = async () => {
    service.client = fakeClient;
  };

  await assert.rejects(
    () => service.updateMessageLabels("INBOX::999999", ["Labels/X"], []),
    /not found/i,
  );
});

test("isLikelyAuthenticationError and isLikelyConnectionError classify errors correctly", () => {
  const authError = new Error("Incorrect login credentials.");
  assert.equal(isLikelyAuthenticationError(authError), true);
  assert.equal(isLikelyConnectionError(authError), false);

  const connError = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1143"), { code: "ECONNREFUSED" });
  assert.equal(isLikelyConnectionError(connError), true);
  assert.equal(isLikelyAuthenticationError(connError), false);

  const unrelated = new Error("Folder does not exist");
  assert.equal(isLikelyAuthenticationError(unrelated), false);
  assert.equal(isLikelyConnectionError(unrelated), false);

  assert.equal(isLikelyAuthenticationError(undefined), false);
  assert.equal(isLikelyConnectionError(undefined), false);
});

test("describeImapError recovers imapflow's real failure reason from .responseText", () => {
  // Reproduces the real shape imapflow throws for every IMAP NO/BAD response —
  // .message is always the generic "Command failed", the actual server reason
  // (here, Proton rejecting a reserved label name) only lives in .responseText.
  const imapflowError = Object.assign(new Error("Command failed"), {
    responseText: "422 POST https://mail-api.proton.me/core/v4/labels: Invalid name (Code=2011, Status=422)",
  });
  assert.equal(
    describeImapError(imapflowError),
    "Command failed: 422 POST https://mail-api.proton.me/core/v4/labels: Invalid name (Code=2011, Status=422)",
  );

  // A plain Error (our own throw new Error(...) call sites) has no
  // responseText — message passes through unchanged, not "undefined" appended.
  assert.equal(describeImapError(new Error("Folder does not exist")), "Folder does not exist");

  // responseText already folded into message by some other path — don't duplicate it.
  const alreadyIncluded = Object.assign(new Error("Command failed: Invalid name"), { responseText: "Invalid name" });
  assert.equal(describeImapError(alreadyIncluded), "Command failed: Invalid name");

  assert.equal(describeImapError(undefined), undefined);
  assert.equal(describeImapError("just a string"), undefined);
});

test("mapHeaderValue never produces the literal string '[object Object]'", () => {
  // Reproduces the reported bug: mailparser structures from/to/list/content-type/
  // dkim-signature as objects, and a blind String(value) stringified them all to
  // the useless literal "[object Object]".
  const addressHeader = {
    value: [{ name: "Alice", address: "alice@example.com" }],
    html: '<span class="mp_label_from">Alice &lt;alice@example.com&gt;</span>',
    text: "Alice <alice@example.com>",
  };
  assert.equal(mapHeaderValue(addressHeader), "Alice <alice@example.com>");

  const contentType = { value: "text/html", params: { charset: "utf-8" } };
  assert.equal(mapHeaderValue(contentType), "text/html; charset=utf-8");

  const dkimSignature = { value: "", params: { v: "1", a: "rsa-sha256" } };
  const dkimResult = mapHeaderValue(dkimSignature);
  assert.ok(!String(dkimResult).includes("[object Object]"));

  const listHeader = {
    unsubscribe: { url: "https://example.com/unsub", mail: "unsub@example.com" },
    id: { value: "list.example.com" },
  };
  const listResult = mapHeaderValue(listHeader);
  assert.equal(listResult.unsubscribe.url, "https://example.com/unsub");
  assert.ok(!JSON.stringify(listResult).includes("[object Object]"));

  // Plain strings, arrays of strings, and Dates must pass through untouched or ISO-formatted.
  assert.equal(mapHeaderValue("plain-string"), "plain-string");
  assert.deepEqual(mapHeaderValue(["a", "b"]), ["a", "b"]);
  assert.equal(typeof mapHeaderValue(new Date()), "string");
});

test("pickNewestUids picks by date, not by UID order (GitHub issue #6)", () => {
  // Reproduces an imported mailbox: today's messages sit on low UIDs while
  // messages from a year ago occupy the highest UIDs. slice(-limit) on UIDs
  // would silently keep the old messages and drop today's.
  const dated = [
    { uid: 1, date: Date.now() },
    { uid: 2, date: Date.now() - 1_000 },
    { uid: 3, date: Date.now() - 2_000 },
    { uid: 10_600, date: Date.now() - 365 * 24 * 60 * 60 * 1000 },
    { uid: 10_601, date: Date.now() - 366 * 24 * 60 * 60 * 1000 },
  ];

  const picked = pickNewestUids(dated, 3);

  assert.deepEqual(picked.sort(), [1, 2, 3]);
});

test("deleteEmail throws instead of silently reporting deleted:true for a UID that doesn't exist", async () => {
  // Reproduces a real bug, the most severe instance of a pattern found
  // repeatedly in this file: messageDelete's EXPUNGE only reflects whether
  // the server accepted the command, not whether any message actually
  // matched — the preceding \Deleted flag add is itself a silent no-op for
  // a nonexistent UID (same root cause as markEmailRead/moveEmail/
  // bulkUpdateFlags/updateMessageLabels), so EXPUNGE legitimately succeeds
  // having deleted nothing. Because this operation is irreversible, found
  // and fixed with a pre-existence check rather than a post-hoc one. Found
  // live: delete_email on a deliberately-fake UID reported deleted:true.
  const service = new SimpleIMAPService(createConfig());

  const fakeClient = {
    usable: true,
    mailbox: { path: "INBOX" },
    getMailboxLock: async () => ({ release() {} }),
    fetchOne: async () => false, // no message matches this UID
    messageDelete: async () => true, // would "succeed" if reached — must not be
  };
  service.client = fakeClient;
  service.connect = async () => {
    service.client = fakeClient;
  };

  await assert.rejects(
    () => service.deleteEmail("INBOX::999999"),
    /not found/i,
  );
});

test("deleteEmail still deletes a genuinely existing message", async () => {
  const service = new SimpleIMAPService(createConfig());

  let deleteCalledWith;
  const fakeClient = {
    usable: true,
    mailbox: { path: "INBOX" },
    getMailboxLock: async () => ({ release() {} }),
    fetchOne: async () => ({ uid: 42 }),
    messageDelete: async (range) => {
      deleteCalledWith = range;
      return true;
    },
  };
  service.client = fakeClient;
  service.connect = async () => {
    service.client = fakeClient;
  };

  const result = await service.deleteEmail("INBOX::42");
  assert.equal(result.deleted, true);
  assert.equal(deleteCalledWith, "42");
});

test("bulkMove reports per-UID failure for a UID that doesn't exist (UIDPLUS server), instead of marking everything ok", async () => {
  // Reproduces a real bug: bulkMove only checked `moved === false` (which
  // only catches an empty/invalid range) and otherwise unconditionally
  // marked *every* requested UID as ok:true, ignoring moved.uidMap
  // entirely — even a UID the MOVE never actually touched. Found live:
  // bulk_move with one real id and one deliberately fake one reported
  // ok:true for both; after the fix, exactly the real one succeeds.
  const service = new SimpleIMAPService(createConfig());

  const fakeClient = {
    usable: true,
    mailbox: { path: "INBOX" },
    capabilities: new Map([["UIDPLUS", true]]),
    getMailboxLock: async () => ({ release() {} }),
    // Only uid 10 actually gets an entry — 999 (requested below) never appears.
    messageMove: async () => ({ path: "INBOX", destination: "Archive", uidMap: new Map([[10, 100]]) }),
  };
  service.client = fakeClient;
  service.connect = async () => {
    service.client = fakeClient;
  };
  service.resolveUidsForBulkOp = async () => [10, 999];

  const result = await service.bulkMove({ emailIds: ["INBOX::10", "INBOX::999"], targetFolder: "Archive" });

  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  const ok = result.results.find((r) => r.uid === 10);
  const bad = result.results.find((r) => r.uid === 999);
  assert.equal(ok.ok, true);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /not found/i);
});

test("bulkMove does not falsely fail on a server without UIDPLUS, even though uidMap is unavailable", async () => {
  // Guards the fix above from over-correcting — mirrors the identical
  // guard test for moveEmail.
  const service = new SimpleIMAPService(createConfig());

  const fakeClient = {
    usable: true,
    mailbox: { path: "INBOX" },
    capabilities: new Map(), // no UIDPLUS
    getMailboxLock: async () => ({ release() {} }),
    messageMove: async () => ({ path: "INBOX", destination: "Archive" }), // no uidMap at all
  };
  service.client = fakeClient;
  service.connect = async () => {
    service.client = fakeClient;
  };
  service.resolveUidsForBulkOp = async () => [10, 20];

  const result = await service.bulkMove({ emailIds: ["INBOX::10", "INBOX::20"], targetFolder: "Archive" });
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 0);
});

test("bulkDelete (permanent) reports failure for a UID that doesn't exist instead of marking everything ok", async () => {
  // Reproduces a real bug: messageDelete's EXPUNGE gives no reliable
  // per-UID signal at all (same root cause as deleteEmail) — the old code
  // unconditionally marked every requested UID ok:true. Since this branch
  // is irreversible, fixed with a pre-delete search confirming which UIDs
  // actually exist, rather than trying to infer it after the fact. Found
  // live: bulk_delete(permanent:true) with one real id and one
  // deliberately fake one reported ok:true for both.
  const service = new SimpleIMAPService(createConfig());

  const fakeClient = {
    usable: true,
    mailbox: { path: "INBOX" },
    getMailboxLock: async () => ({ release() {} }),
    search: async () => [10], // only uid 10 actually exists; 999 does not
    messageDelete: async () => true,
  };
  service.client = fakeClient;
  service.connect = async () => {
    service.client = fakeClient;
  };
  service.resolveUidsForBulkOp = async () => [10, 999];

  const result = await service.bulkDelete({ emailIds: ["INBOX::10", "INBOX::999"], permanent: true });

  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  const ok = result.results.find((r) => r.uid === 10);
  const bad = result.results.find((r) => r.uid === 999);
  assert.equal(ok.ok, true);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /not found/i);
});

test("bulkDelete (to Trash) reports failure for a UID that doesn't exist (UIDPLUS server)", async () => {
  // Same bug as bulkMove for its non-permanent (move-to-Trash) branch.
  const service = new SimpleIMAPService(createConfig());

  const fakeClient = {
    usable: true,
    mailbox: { path: "INBOX" },
    capabilities: new Map([["UIDPLUS", true]]),
    getMailboxLock: async () => ({ release() {} }),
    messageMove: async () => ({ path: "INBOX", destination: "Trash", uidMap: new Map([[10, 100]]) }),
  };
  service.client = fakeClient;
  service.connect = async () => {
    service.client = fakeClient;
  };
  service.resolveUidsForBulkOp = async () => [10, 999];
  service.resolveSpecialFolder = async () => "Trash";

  const result = await service.bulkDelete({ emailIds: ["INBOX::10", "INBOX::999"], permanent: false });

  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  const bad = result.results.find((r) => r.uid === 999);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /not found/i);
});
