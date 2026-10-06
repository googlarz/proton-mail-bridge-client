import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { COMMAND_SPECS, TOOL_ONLY_COMMANDS } from "../dist/cli.js";

const docs = await readFile(new URL("../docs/cli.md", import.meta.url), "utf8");
// Only the `proton-mail-bridge-client <command>` invocations and `### \`command\`` headings
// count as mentions, so a command name appearing in prose by accident does not satisfy this.
const BIN = "proton-mail-bridge-client";

function documentedCommands() {
  const found = new Set();
  for (const match of docs.matchAll(/^#{2,4} `([a-z][a-z0-9-]*)(?: [^`]*)?`/gm)) found.add(match[1]);
  for (const match of docs.matchAll(new RegExp(`${BIN} ([a-z][a-z0-9-]*)`, "g"))) found.add(match[1]);
  return found;
}

const tableCommands = () => new Set([...Object.keys(COMMAND_SPECS), ...TOOL_ONLY_COMMANDS.map((entry) => entry.command)]);

test("docs/cli.md documents every command in the CLI tables", () => {
  const documented = documentedCommands();
  const missing = [...tableCommands()].filter((command) => !documented.has(command));
  assert.deepEqual(missing, [], `commands missing from docs/cli.md: ${missing.join(", ")}`);
});

test("docs/cli.md does not mention a command that does not exist", () => {
  const known = tableCommands();
  const phantom = [...documentedCommands()].filter((command) => !known.has(command));
  assert.deepEqual(phantom, [], `docs/cli.md mentions unknown commands: ${phantom.join(", ")}`);
});

test("docs/cli.md documents the argument syntax and exit codes", () => {
  assert.match(docs, /--flag=value|--to=/);
  assert.match(docs, /`--`/);
  assert.match(docs, /start(s|ing)? with `--`/);
  assert.match(docs, /exit code/i);
});
