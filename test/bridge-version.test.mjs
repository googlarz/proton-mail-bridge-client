import test from "node:test";
import assert from "node:assert/strict";
import { bridgeVersionNote, parseBridgeVersion } from "../dist/utils/bridge-version.js";

test("Bridge's own version formats are read, and only a newer major or minor gets a note", () => {
  assert.deepEqual(parseBridgeVersion("03.27.01"), [3, 27, 1]);
  assert.deepEqual(parseBridgeVersion("Proton Mail Bridge 03.28.00 ready"), [3, 28, 0]);
  assert.equal(parseBridgeVersion("nothing"), undefined);
  assert.equal(bridgeVersionNote({ version: "03.27.01" }), undefined);
  assert.equal(bridgeVersionNote({ version: "03.27.09" }), undefined, "a patch release is not news");
  assert.match(bridgeVersionNote({ version: "03.28.00" }), /newer than 3\.27\.1/);
  assert.match(bridgeVersionNote({ greeting: "Proton Mail Bridge 04.00.00" }), /newer/);
  assert.equal(bridgeVersionNote({}), undefined);
  assert.equal(bridgeVersionNote(undefined), undefined);
});
