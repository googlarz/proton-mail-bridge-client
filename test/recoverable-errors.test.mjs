import test from "node:test";
import assert from "node:assert/strict";
import { isRecoverableConnectionError } from "../dist/index.js";

test("a dropped connection is recoverable, a programming error is not", () => {
  assert.equal(isRecoverableConnectionError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })), true);
  assert.equal(isRecoverableConnectionError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })), true);
  assert.equal(isRecoverableConnectionError(new Error("socket hang up")), true);
  assert.equal(isRecoverableConnectionError(Object.assign(new Error("Connection closed"), { code: "NoConnection" })), true);
  assert.equal(isRecoverableConnectionError(new TypeError("Cannot read properties of undefined")), false);
  assert.equal(isRecoverableConnectionError(undefined), false);
});

test("an uncaught socket error does not end the process, any other error does", async () => {
  const { spawnSync } = await import("node:child_process");
  const run = (error) => spawnSync(process.execPath, ["--input-type=module", "-e", `
    await import(${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)});
    setTimeout(() => { ${error}; }, 10);
    setTimeout(() => { console.log("still alive"); process.exit(0); }, 300);
  `], { encoding: "utf8", timeout: 20000 });
  const socket = run(`process.emit("uncaughtException", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))`);
  assert.match(socket.stdout, /still alive/);
  const other = run(`process.emit("uncaughtException", new TypeError("boom"))`);
  assert.equal(other.status, 1);
});
