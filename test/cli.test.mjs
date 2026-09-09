import test from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs } from "../dist/cli.js";

test("parseCliArgs handles basic commands and flags", () => {
  const parsed = parseCliArgs(["search", "invoice", "--folder", "INBOX", "--json"]);

  assert.equal(parsed.command, "search");
  assert.deepEqual(parsed.positionals, ["invoice"]);
  assert.equal(parsed.flags.folder, "INBOX");
  assert.equal(parsed.flags.json, true);
});

test("parseCliArgs handles claude subcommands", () => {
  const parsed = parseCliArgs(["claude", "check", "--json"]);

  assert.equal(parsed.command, "claude");
  assert.equal(parsed.subcommand, "check");
  assert.deepEqual(parsed.positionals, []);
  assert.equal(parsed.flags.json, true);
});

test("parseCliArgs handles generic tool calls", () => {
  const parsed = parseCliArgs([
    "tool",
    "search_indexed_emails",
    "--args",
    '{"query":"invoice","limit":2}',
  ]);

  assert.equal(parsed.command, "tool");
  assert.deepEqual(parsed.positionals, ["search_indexed_emails"]);
  assert.equal(parsed.flags.args, '{"query":"invoice","limit":2}');
});

test("parseCliArgs handles tools listing", () => {
  const parsed = parseCliArgs(["tools", "--json"]);

  assert.equal(parsed.command, "tools");
  assert.deepEqual(parsed.positionals, []);
  assert.equal(parsed.flags.json, true);
});

test("parseCliArgs does not let a boolean flag before a positional swallow it", () => {
  // Regression test: the parser used to have no notion of which flags are boolean, so any
  // boolean flag (--json, --unread, --confirmed, etc.) placed before a positional argument
  // consumed it as that flag's "value". `search --json invoice` set flags.json = "invoice"
  // (truthy check fails, so output silently fell back to plain text) and dropped the query
  // entirely, widening the search to the whole mailbox instead of the one term intended.
  const flagFirst = parseCliArgs(["search", "--json", "invoice"]);
  assert.equal(flagFirst.command, "search");
  assert.deepEqual(flagFirst.positionals, ["invoice"], "the query must not be swallowed by --json");
  assert.equal(flagFirst.flags.json, true);

  // No-regression check: the equivalent flag-after form must keep working exactly as before.
  const flagAfter = parseCliArgs(["search", "invoice", "--json"]);
  assert.deepEqual(flagAfter.positionals, ["invoice"]);
  assert.equal(flagAfter.flags.json, true);

  // A value-flag (--folder) placed before a positional must still correctly consume its value
  // and not be confused with a boolean flag.
  const valueFlagFirst = parseCliArgs(["search", "--folder", "INBOX", "invoice"]);
  assert.deepEqual(valueFlagFirst.positionals, ["invoice"]);
  assert.equal(valueFlagFirst.flags.folder, "INBOX");

  // A required positional (emailId) must not be eaten by a preceding boolean flag either.
  const markRead = parseCliArgs(["mark-read", "--unread", "INBOX::1::1::1"]);
  assert.deepEqual(markRead.positionals, ["INBOX::1::1::1"], "the emailId must not be swallowed by --unread");
  assert.equal(markRead.flags.unread, true);
});
