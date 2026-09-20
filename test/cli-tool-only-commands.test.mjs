import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { TOOL_ONLY_COMMANDS } from "../dist/cli.js";

// Every hand-written CLI command string from printHelp()/main()'s switch,
// kept here as a plain list (not parsed from cli.ts) so a new TOOL_ONLY_COMMANDS
// entry can never silently shadow one of these.
const HAND_WRITTEN_COMMANDS = new Set([
  "help", "--help", "-h", "-v", "version", "setup-claude-desktop",
  "status", "doctor", "connection-status", "runtime-status", "sync", "index-status",
  "folders", "create-folder", "rename-folder", "delete-folder", "empty-folder",
  "labels", "threads", "digest", "followups", "drafts", "attachments", "search",
  "read", "move", "archive", "trash", "restore", "mark-read", "star", "delete",
  "send", "reply", "forward", "emails", "thread", "thread-brief", "actionable",
  "document-threads", "meeting-context", "thread-action", "batch", "bulk-delete",
  "bulk-move", "stats", "analytics", "folder-stats", "contacts", "volume-trends",
  "watch", "clear-cache", "get-logs", "notify", "test-email", "draft-create",
  "draft-read", "draft-update", "draft-reply", "draft-forward", "draft-sync",
  "draft-send", "draft-delete", "remote-drafts", "draft-thread-reply", "tools",
  "tool", "claude",
]);

test("TOOL_ONLY_COMMANDS has no duplicate command names", () => {
  const commands = TOOL_ONLY_COMMANDS.map((entry) => entry.command);
  assert.deepEqual(commands, [...new Set(commands)]);
});

test("TOOL_ONLY_COMMANDS never shadows a hand-written command", () => {
  const collisions = TOOL_ONLY_COMMANDS.filter((entry) => HAND_WRITTEN_COMMANDS.has(entry.command));
  assert.deepEqual(collisions, []);
});

test("every TOOL_ONLY_COMMANDS entry references a real MCP tool name", async () => {
  const srcPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const source = await readFile(srcPath, "utf8");
  const realToolNames = new Set([...source.matchAll(/^\s*name:\s*"([a-z_0-9]+)",$/gm)].map((m) => m[1]));

  const unknown = TOOL_ONLY_COMMANDS.filter((entry) => !realToolNames.has(entry.tool));
  assert.deepEqual(unknown.map((entry) => entry.tool), []);
});

test("every TOOL_ONLY_COMMANDS entry has a non-empty help string", () => {
  const missingHelp = TOOL_ONLY_COMMANDS.filter((entry) => !entry.help || !entry.help.trim());
  assert.deepEqual(missingHelp, []);
});

// The README and docs/cli.md promise a CLI command for every MCP tool. list_accounts (added
// with multi-account support) slipped through: nothing checked. Every tool name must at
// least appear in the CLI source — either as a TOOL_ONLY_COMMANDS entry or in one of the
// hand-written commands' callTool/handler — so a new tool with no CLI path fails here.
test("every MCP tool is reachable from the CLI", async () => {
  const indexSource = await readFile(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
  const cliSource = await readFile(fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "utf8");
  const realToolNames = [...new Set([...indexSource.matchAll(/^\s*name:\s*"([a-z_0-9]+)",$/gm)].map((m) => m[1]))];
  assert.ok(realToolNames.length >= 90, "found the tool list");
  const unreachable = realToolNames.filter((name) => !cliSource.includes(`"${name}"`));
  assert.deepEqual(unreachable, []);
});
