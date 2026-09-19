import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DraftStoreService } from "../dist/services/draft-store-service.js";
import { DeliveryQueueService } from "../dist/services/delivery-queue-service.js";
import { withFileLock } from "../dist/utils/file-lock.js";

// Real OS processes: SIGKILL mid-send, a lock held by a killed process, and two
// processes syncing the same draft at once. (The mail servers are fakes.)

const CHILD = fileURLToPath(new URL("./helpers/crash-child.mjs", import.meta.url));

function config(dataDir) {
  return {
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "x" },
    dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    runtime: {
      readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false,
      autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30,
      confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false, allowFileDownloadDir: undefined,
      maxInlineBytes: 40960, opDelayMs: 0,
    },
  };
}

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "crash-test-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

async function waitForFile(path, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { await access(path); return; } catch { await new Promise((r) => setTimeout(r, 25)); }
  }
  throw new Error(`timed out waiting for ${path}`);
}

function spawnChild(...args) {
  const child = spawn(process.execPath, [CHILD, ...args], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  return { child, exited };
}

test("SIGKILL while SMTP is in flight: the restart never resends and reports an unknown outcome", async () => {
  await withDir(async (dir) => {
    const { child, exited } = spawnChild("send-hang", dir);
    await waitForFile(join(dir, "smtp-in-flight"));
    child.kill("SIGKILL");
    await exited;

    // A fresh process (a new service instance over the same files) starts up.
    let resent = 0;
    const smtp = { async sendEmail() { resent += 1; return { messageId: "<x>", accepted: [], rejected: [] }; } };
    const store = new DraftStoreService(config(dir));
    const queue = new DeliveryQueueService(config(dir), smtp);
    queue.setDraftStore(store);
    await queue.start();
    await queue.stop?.();

    assert.equal(resent, 0, "an interrupted send must never be auto-resent");
    const [record] = await queue.list();
    assert.equal(record.status, "failed");
    assert.match(record.failureReason, /outcome is unknown/i);
    assert.match(record.failureReason, /Sent folder/);

    // ...and the draft is not handed back as freely resendable: the claim survives.
    const draftId = (await readFile(join(dir, "draft-id"), "utf8")).trim();
    assert.equal((await store.getDraft(draftId)).status, "sending");
    await assert.rejects(store.claimForSending(draftId), /./, "a second send_draft must be refused");
  });
});

test("a file lock held by a process that was SIGKILLed is reclaimed instead of blocking forever", async () => {
  await withDir(async (dir) => {
    const { child, exited } = spawnChild("hold-lock", dir);
    await waitForFile(join(dir, "lock-held"));
    child.kill("SIGKILL");
    await exited;

    const started = Date.now();
    const value = await withFileLock(join(dir, "drafts.json"), async () => "acquired");
    assert.equal(value, "acquired");
    assert.ok(Date.now() - started < 20000, "took the stale lock over in reasonable time");
  });
});

test("two processes syncing the same draft at once produce exactly one remote copy", async () => {
  await withDir(async (dir) => {
    const store = new DraftStoreService(config(dir));
    const draft = await store.createDraft({ to: ["x@example.com"], subject: "S", body: "b" });
    const a = spawnChild("sync-once", dir, draft.id);
    const b = spawnChild("sync-once", dir, draft.id);
    await Promise.all([a.exited, b.exited]);

    const lines = (await readFile(join(dir, "sync-log"), "utf8")).trim().split("\n");
    const appends = lines.filter((l) => l.includes(":append:start"));
    assert.equal(appends.length, 1, `one APPEND, the other an update of that copy — got:\n${lines.join("\n")}`);
    assert.equal(lines.length, 4, "both syncs ran");
    // no interleaving: first sync's end comes before the second's start
    assert.ok(lines[0].endsWith(":start") && lines[1].endsWith(":end") && lines[2].endsWith(":start") && lines[3].endsWith(":end"));
  });
});
