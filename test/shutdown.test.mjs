import test from "node:test";
import assert from "node:assert/strict";
import { stopAllAccounts } from "../dist/index.js";

// Shutdown stopped the timers and the IMAP connection of the PRIMARY account only, so extra accounts kept
// scheduling during teardown and were never logged out, and it waited for logout with no limit: a Bridge that
// never answered LOGOUT made the process ignore SIGTERM for as long as imapflow's own socket timeout (5 min).

function bundle(name, calls, { hangLogout = false } = {}) {
  const note = (what) => calls.push(`${name}:${what}`);
  return {
    backgroundSyncService: { stop: () => note("sync.stop") },
    deliveryQueueService: { stop: () => note("queue.stop") },
    snoozeService: { stop: () => note("snooze.stop") },
    imapService: { disconnect: () => { note("imap.disconnect"); return hangLogout ? new Promise(() => {}) : Promise.resolve(); } },
    smtpService: { close: async () => note("smtp.close") },
    localIndexService: { close: async () => note("index.close") },
  };
}

test("every account's timers, connections and index are stopped, not only the primary's", async () => {
  const calls = [];
  await stopAllAccounts([bundle("a", calls), bundle("b", calls)], 1000);
  for (const name of ["a", "b"]) {
    for (const what of ["sync.stop", "queue.stop", "snooze.stop", "imap.disconnect", "smtp.close", "index.close"]) {
      assert.ok(calls.includes(`${name}:${what}`), `${name}:${what} was not called`);
    }
  }
});

test("a logout that never answers does not hold the shutdown up beyond the limit", async () => {
  const calls = [];
  const started = Date.now();
  await stopAllAccounts([bundle("a", calls, { hangLogout: true }), bundle("b", calls)], 300);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 250 && elapsed < 1500, `took ${elapsed} ms`);
  assert.ok(calls.includes("b:index.close"), "the other account was still closed");
});

test("a service that throws while stopping does not prevent the others from stopping", async () => {
  const calls = [];
  const broken = bundle("a", calls);
  broken.imapService.disconnect = async () => { throw new Error("already gone"); };
  await stopAllAccounts([broken, bundle("b", calls)], 500);
  assert.ok(calls.includes("b:imap.disconnect"));
});
