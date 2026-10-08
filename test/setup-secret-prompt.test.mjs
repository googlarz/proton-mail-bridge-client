import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { createMutableOutput, promptSecret } from "../dist/scripts/setup-claude-desktop.js";

// The Bridge password typed into the setup wizard must not be echoed (terminal scrollback, screen sharing).

function capture() {
  const chunks = [];
  return { target: { write: (chunk) => { chunks.push(String(chunk)); return true; } }, text: () => chunks.join("") };
}

test("a muted stream swallows what is written to it and passes it on again when unmuted", async () => {
  const sink = capture();
  const mutable = createMutableOutput(sink.target);
  mutable.stream.write("shown 1;");
  mutable.setMuted(true);
  mutable.stream.write("hidden;");
  mutable.setMuted(false);
  mutable.stream.write("shown 2;");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sink.text(), "shown 1;shown 2;");
});

function session() {
  const input = new PassThrough();
  const sink = capture();
  const mutable = createMutableOutput(sink.target);
  // terminal:true makes readline echo each typed character to its output, as it does on a real terminal.
  const rl = createInterface({ input, output: mutable.stream, terminal: true });
  return { input, rl, mutable, sink };
}

test("the typed secret is returned and never reaches the output", async () => {
  const { input, rl, mutable, sink } = session();
  const pending = promptSecret(rl, mutable, "Password", "", (text) => sink.target.write(text));
  input.write("hunter2-secret\r");
  assert.equal(await pending, "hunter2-secret");
  rl.close();
  assert.ok(!sink.text().includes("hunter2"), JSON.stringify(sink.text()));
  assert.match(sink.text(), /Password: /);
});

test("an empty answer falls back to the default, and an empty answer without one asks again", async () => {
  const withDefault = session();
  const first = promptSecret(withDefault.rl, withDefault.mutable, "Password", "from-env", (text) => withDefault.sink.target.write(text));
  withDefault.input.write("\r");
  assert.equal(await first, "from-env");
  withDefault.rl.close();

  const without = session();
  const second = promptSecret(without.rl, without.mutable, "Password", "", (text) => without.sink.target.write(text));
  without.input.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 20));
  without.input.write("second-try\r");
  assert.equal(await second, "second-try");
  without.rl.close();
  assert.match(without.sink.text(), /This value is required\./);
  assert.ok(!without.sink.text().includes("second-try"));
});
