import test from "node:test";
import assert from "node:assert/strict";
import { checkForUpdate, isNewerVersion } from "../dist/utils/update-check.js";

test("versions compare numerically, not as text", () => {
  assert.equal(isNewerVersion("2.12.0", "2.11.0"), true);
  assert.equal(isNewerVersion("2.10.0", "2.9.1"), true);
  assert.equal(isNewerVersion("2.11.0", "2.11.0"), false);
  assert.equal(isNewerVersion("2.9.0", "2.10.0"), false);
  assert.equal(isNewerVersion("v3.0.0", "2.99.99"), true);
});

test("the check reports a newer release, an up-to-date install and a failed lookup", async () => {
  const answer = (version) => async () => new Response(JSON.stringify({ version }), { status: 200 });
  const newer = await checkForUpdate("2.11.0", answer("2.12.0"));
  assert.equal(newer.newer, true);
  assert.match(newer.releaseUrl, /v2\.12\.0$/);
  assert.equal((await checkForUpdate("2.12.0", answer("2.12.0"))).newer, false);
  const down = await checkForUpdate("2.12.0", async () => { throw new Error("offline"); });
  assert.deepEqual([down.newer, down.error], [false, "offline"]);
  const bad = await checkForUpdate("2.12.0", async () => new Response("no", { status: 503 }));
  assert.match(bad.error, /503/);
});
