import test from "node:test";
import assert from "node:assert/strict";
import { SimpleIMAPService } from "../dist/services/simple-imap-service.js";

// Found live (2.1.23): with the IDLE watcher on, every other IMAP operation waited out the
// watcher's whole idle period (30 s) for the shared connection's mailbox lock — a
// single-folder search took 26-31 s instead of 1-2 s and a 9-folder search never finished
// in 170 s. The watcher now yields as soon as an operation is waiting.

class FakeImapClient {
  usable = true;
  idling = false;
  preCheck = false;
  mailbox = { exists: 1 };
  locked = false;
  waiters = [];
  on() {}
  off() {}
  async getMailboxLock() {
    if (this.locked) await new Promise((resolve) => this.waiters.push(resolve));
    this.locked = true;
    return { release: () => { this.locked = false; this.waiters.shift()?.(); } };
  }
  // Like imapflow: idle() blocks until something breaks it (preCheck) or its time is up.
  async idle() {
    this.idling = true;
    await new Promise((resolve) => {
      this.preCheck = async () => resolve();
      setTimeout(resolve, 60_000).unref();
    });
    this.idling = false;
  }
}

function config() {
  return {
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "o@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "o@example.com", password: "x" },
    dataDir: "/tmp/unused", debug: false,
    runtime: { idleMaxSeconds: 30 },
  };
}

test("an operation waiting for the mailbox lock does not sit behind a 30 s IDLE", async () => {
  const service = new SimpleIMAPService(config(), { debug() {}, info() {}, warn() {}, error() {} });
  service.client = new FakeImapClient();

  const idle = service.waitForMailboxChanges({ folder: "INBOX", timeoutMs: 30_000 });
  await new Promise((resolve) => setTimeout(resolve, 100)); // let the watcher take the lock and start IDLE

  const started = Date.now();
  const value = await service.withMailbox("Sent", true, async () => "done");
  const waited = Date.now() - started;

  assert.equal(value, "done");
  assert.ok(waited < 2_000, `operation waited ${waited} ms for the lock — it must not wait out the idle period`);
  const result = await idle;
  assert.equal(result.changed, false);
});

test("many operations in a row (a multi-folder search) each get the lock promptly while a watcher keeps re-entering IDLE", async () => {
  const service = new SimpleIMAPService(config(), { debug() {}, info() {}, warn() {}, error() {} });
  const client = new FakeImapClient();
  service.client = client;

  let watching = true;
  const watcher = (async () => {
    while (watching) await service.waitForMailboxChanges({ folder: "INBOX", timeoutMs: 30_000 });
  })();
  await new Promise((resolve) => setTimeout(resolve, 100));

  const started = Date.now();
  for (const folder of ["INBOX", "Sent", "Drafts", "Archive", "Trash", "Spam", "Recovered Messages"]) {
    await service.withMailbox(folder, true, async () => folder);
  }
  const total = Date.now() - started;
  watching = false;
  // let a pending IDLE end so the watcher loop can finish
  await service.withMailbox("INBOX", true, async () => undefined);
  await watcher;

  assert.ok(total < 5_000, `7 folder switches took ${total} ms; each used to cost up to a full idle period`);
});

test("without any IDLE running, withMailbox behaves as before and leaves no waiter count behind", async () => {
  const service = new SimpleIMAPService(config(), { debug() {}, info() {}, warn() {}, error() {} });
  service.client = new FakeImapClient();
  assert.equal(await service.withMailbox("INBOX", true, async () => 42), 42);
  await assert.rejects(service.withMailbox("INBOX", true, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(service._pendingMailboxOps, 0);
});
