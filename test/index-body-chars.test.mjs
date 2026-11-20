import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { parseIndexBodyCharsEnv } from "../dist/config-env.js";
import { SimpleIMAPService } from "../dist/services/simple-imap-service.js";
import { LocalIndexService } from "../dist/services/local-index-service.js";
import { createMessage, makeCertificate, startFakeBridge } from "./helpers/fake-bridge.mjs";

const certificate = makeCertificate();
const needsOpenssl = certificate ? {} : { skip: "openssl is not available to make a test certificate" };

// PROTONMAIL_INDEX_BODY_CHARS: how much of a message's text the full-text index keeps. The default is the preview length,
// so nothing changes unless it is raised; changing it rebuilds the index instead of mixing rows.

const NEEDLE = "zephyrquokka";
// The needle sits well beyond the first 220 characters (and beyond 1000).
const LONG_BODY = `${"Quarterly planning notes and other filler words. ".repeat(30)}${NEEDLE} is only mentioned here.\r\n`;

const runtimeBase = { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 50, idleWatchEnabled: false, idleMaxSeconds: 30, maxInlineBytes: 40960, opDelayMs: 0 };

function makeConfig(bridge, dataDir, indexBodyChars) {
  const imap = { host: "127.0.0.1", port: bridge.port, secure: false, username: "owner@example.com", password: "secret" };
  const smtp = { ...imap, port: 9 };
  const runtime = indexBodyChars === undefined ? runtimeBase : { ...runtimeBase, indexBodyChars };
  return { imap, smtp, dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5, runtime };
}

async function withIndex(indexBodyChars, fn) {
  const dataDir = await mkdtemp(join(tmpdir(), "index-body-chars-"));
  const bridge = await startFakeBridge({ mode: "starttls", certificate, folders: { INBOX: { uidValidity: 7, messages: [createMessage(1, { subject: "Planning", body: LONG_BODY }), createMessage(2, { subject: "Other" })] } } });
  const open = (chars) => {
    const config = makeConfig(bridge, dataDir, chars);
    return { config, index: new LocalIndexService(config), imap: new SimpleIMAPService(config) };
  };
  const sync = async ({ index, imap }) => {
    const snapshot = await imap.collectEmailsForIndex({ folder: "INBOX", limitPerFolder: 50, checkpoints: await index.getSyncCheckpointMap() });
    await index.recordSnapshot({ folders: snapshot.folders, emails: snapshot.emails, syncedAt: snapshot.syncedAt, folderStats: snapshot.folderStats });
    return snapshot;
  };
  const opened = [];
  const first = open(indexBodyChars);
  opened.push(first);
  try {
    await fn({ first, open: (chars) => { const next = open(chars); opened.push(next); return next; }, sync, dataDir });
  } finally {
    for (const { index, imap } of opened) {
      await index.close();
      await imap.disconnect().catch(() => {});
    }
    await bridge.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("the default (220) indexes nothing beyond the preview", needsOpenssl, async () => {
  await withIndex(undefined, async ({ first, sync }) => {
    const snapshot = await sync(first);
    assert.ok(snapshot.emails.every((email) => email.indexText === undefined), "no extra text is collected at the default");
    const found = await first.index.search({ query: NEEDLE, limit: 10 });
    assert.equal(found.emails.length, 0, "a word past the first 220 characters is not searchable");
    assert.equal((await first.index.search({ query: "quarterly", limit: 10 })).emails.length, 1, "a word inside the preview still is");
  });
});

test("a raised limit finds a word past the first 220 characters, and the answer keeps the short preview", needsOpenssl, async () => {
  await withIndex(5000, async ({ first, sync, dataDir }) => {
    await sync(first);
    const found = await first.index.search({ query: NEEDLE, limit: 10 });
    assert.equal(found.emails.length, 1);
    const [email] = found.emails;
    assert.equal(email.subject, "Planning");
    // 219 characters and "...", as previewText has always cut it.
    assert.ok(email.preview.length <= 222, `preview stays short, was ${email.preview.length}`);
    assert.equal(email.indexText, undefined);
    assert.ok(!JSON.stringify(found).includes(NEEDLE), "the longer text is not returned");

    // A flags-only refresh brings no body: the stored text must survive it.
    await sync(first);
    assert.equal((await first.index.search({ query: NEEDLE, limit: 10 })).emails.length, 1);

    // The stored text is cut at the limit.
    await first.index.close();
    const db = new Database(join(dataDir, "mail-index.sqlite"), { readonly: true });
    try {
      const { body } = db.prepare("SELECT body FROM message_bodies").get();
      assert.ok(body.length <= 5000 && body.includes(NEEDLE));
    } finally {
      db.close();
    }
  });
});

test("the limit cuts the stored text", needsOpenssl, async () => {
  await withIndex(1000, async ({ first, sync }) => {
    await sync(first);
    assert.equal((await first.index.search({ query: NEEDLE, limit: 10 })).emails.length, 0, "the word lies beyond 1000 characters");
    assert.equal((await first.index.search({ query: "quarterly", limit: 10 })).emails.length, 1);
  });
});

test("changing the limit clears the index so it is built again, not mixed", needsOpenssl, async () => {
  await withIndex(undefined, async ({ first, open, sync }) => {
    await sync(first);
    assert.equal((await first.index.getFreshness()).storedMessageCount, 2);
    await first.index.close();

    // Raised: the rows built from the preview alone are dropped, then a new sync fills the index with the longer text.
    const raised = open(5000);
    assert.equal((await raised.index.getFreshness()).storedMessageCount, 0, "old rows are not kept beside new ones");
    assert.equal((await raised.index.getStatus()).syncCheckpoints.length, 0, "the checkpoints go too, so the next sync fetches again");
    await sync(raised);
    assert.equal((await raised.index.getFreshness()).storedMessageCount, 2);
    assert.equal((await raised.index.search({ query: NEEDLE, limit: 10 })).emails.length, 1);

    // Same value again: nothing is cleared.
    await raised.index.close();
    const same = open(5000);
    assert.equal((await same.index.getFreshness()).storedMessageCount, 2);
    assert.equal((await same.index.search({ query: NEEDLE, limit: 10 })).emails.length, 1);

    // Back to the default: the longer text is gone with the rows.
    await same.index.close();
    const lowered = open(undefined);
    assert.equal((await lowered.index.getFreshness()).storedMessageCount, 0);
    await sync(lowered);
    assert.equal((await lowered.index.search({ query: NEEDLE, limit: 10 })).emails.length, 0);
    assert.equal((await lowered.index.getFreshness()).storedMessageCount, 2);
  });
});

test("an index that was built before the setting existed is kept at the default", needsOpenssl, async () => {
  await withIndex(undefined, async ({ first, open, sync }) => {
    await sync(first);
    await first.index.close();
    // 220 spelled out is the same as unset.
    const explicit = open(220);
    assert.equal((await explicit.index.getFreshness()).storedMessageCount, 2);
  });
});

test("PROTONMAIL_INDEX_BODY_CHARS: unset means 220, a value in range is used, anything else is rejected", () => {
  const name = "PROTONMAIL_INDEX_BODY_CHARS";
  const saved = process.env[name];
  try {
    delete process.env[name];
    assert.equal(parseIndexBodyCharsEnv(name), 220);
    process.env[name] = "  ";
    assert.equal(parseIndexBodyCharsEnv(name), 220);
    process.env[name] = "${user_config.index_body_chars}";
    assert.equal(parseIndexBodyCharsEnv(name), 220, "an unfilled placeholder counts as not set");
    for (const [raw, expected] of [["220", 220], ["5000", 5000], [" 20000 ", 20000]]) {
      process.env[name] = raw;
      assert.equal(parseIndexBodyCharsEnv(name), expected);
    }
    for (const raw of ["219", "20001", "0", "-5", "abc", "5e3", "1.5", "100000000000000000000"]) {
      process.env[name] = raw;
      assert.throws(() => parseIndexBodyCharsEnv(name), new RegExp(`${name} must be an integer between 220 and 20000`), raw);
    }
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
});
