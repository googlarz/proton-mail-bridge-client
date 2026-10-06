import test from "node:test";
import assert from "node:assert/strict";
import { SimpleIMAPService } from "../dist/services/simple-imap-service.js";

// 1. waitForMailboxChanges marked the folder as "being watched" and only then connected, outside the
//    try/finally that clears the mark. If Bridge was down when the first IDLE started (the normal state at
//    boot), the mark was never cleared: every later call returned "no changes" instantly, forever, with no
//    error, even after Bridge came back.
// 2. A second caller (the wait_for_mailbox_changes tool) while background IDLE was active returned
//    "no changes" in 0 ms instead of waiting for one.
// 3. disconnect() cleared this.client after awaiting logout, so a client connected during a slow logout was
//    forgotten, never closed and never reused: one leaked Bridge session per occurrence.

function service() {
  return new SimpleIMAPService({
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "o@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "o@example.com", password: "x" },
    dataDir: "/tmp/idle-lifecycle-test", debug: false, runtime: { idleMaxSeconds: 30 },
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a failed connection does not leave the folder marked as watched", async () => {
  const svc = service();
  let attempts = 0;
  svc.ensureConnected = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("connect ECONNREFUSED");
    return {};
  };
  svc.waitForMailboxChangesWithClient = async (_client, folder, timeoutMs) => ({ folder, timeoutMs, checkedAt: "now", changed: true, events: [{ type: "exists" }] });

  await assert.rejects(svc.waitForMailboxChanges({ folder: "INBOX", timeoutMs: 1000 }), /ECONNREFUSED/);
  const second = await svc.waitForMailboxChanges({ folder: "INBOX", timeoutMs: 1000 });
  assert.equal(second.changed, true, "the second call really watches instead of returning at once");
  assert.equal(attempts, 2);
});

test("a caller that arrives while IDLE is already active waits for a change instead of answering 'none'", async () => {
  const svc = service();
  svc.ensureConnected = async () => ({});
  let cycle = 0;
  svc.waitForMailboxChangesWithClient = async (_client, folder, timeoutMs) => {
    cycle += 1;
    const mine = cycle;
    await sleep(60); // one IDLE cycle
    return { folder, timeoutMs, checkedAt: "now", changed: mine === 2, events: mine === 2 ? [{ type: "exists", count: 5 }] : [] };
  };
  const background = (async () => {
    await svc.waitForMailboxChanges({ folder: "INBOX", timeoutMs: 1000 }); // cycle 1: nothing
    return svc.waitForMailboxChanges({ folder: "INBOX", timeoutMs: 1000 }); // cycle 2: a change
  })();
  await sleep(10); // the tool call arrives during cycle 1
  const started = Date.now();
  const waiter = await svc.waitForMailboxChanges({ folder: "INBOX", timeoutMs: 2000 });
  assert.equal(waiter.changed, true);
  assert.deepEqual(waiter.events, [{ type: "exists", count: 5 }]);
  assert.ok(Date.now() - started >= 50, "it waited for the cycle that saw the change");
  await background;
});

test("a waiter whose own timeout passes with no change answers 'no changes' at that time, not before", async () => {
  const svc = service();
  svc.ensureConnected = async () => ({});
  svc.waitForMailboxChangesWithClient = async (_client, folder, timeoutMs) => {
    await sleep(40);
    return { folder, timeoutMs, checkedAt: "now", changed: false, events: [] };
  };
  let stop = false;
  const loop = (async () => { while (!stop) await svc.waitForMailboxChanges({ folder: "INBOX", timeoutMs: 1000 }); })();
  await sleep(5);
  const started = Date.now();
  const result = await svc.waitForMailboxChanges({ folder: "INBOX", timeoutMs: 1000 });
  stop = true;
  assert.equal(result.changed, false);
  assert.ok(Date.now() - started >= 900, `answered after ${Date.now() - started} ms, expected about its 1000 ms timeout`);
  await loop;
});

test("disconnect() forgets only the client it closed, not one connected while it was logging out", async () => {
  const svc = service();
  let release;
  const slowLogout = new Promise((resolve) => { release = resolve; });
  const oldClient = { usable: true, logout: () => slowLogout, close() {} };
  const newClient = { usable: true, logout: async () => {}, close() {} };
  svc.client = oldClient;
  const closing = svc.disconnect();
  svc.client = newClient; // a call connected a fresh client while the old one was still logging out
  release();
  await closing;
  assert.equal(svc.client, newClient, "the new connection must survive the old disconnect");
});

test("if the mailbox lock cannot be taken, the IDLE listeners are removed from the client again", async () => {
  const svc = service();
  const listeners = new Set();
  const client = {
    mailbox: { exists: 1 },
    on: (event) => listeners.add(event),
    off: (event) => listeners.delete(event),
    removeListener: (event) => listeners.delete(event),
    getMailboxLock: async () => { throw new Error("lock failed"); },
  };
  await assert.rejects(svc.waitForMailboxChangesWithClient(client, "INBOX", 1000, false), /lock failed/);
  assert.deepEqual([...listeners], [], "no listener may stay behind on a client that is reused");
});
