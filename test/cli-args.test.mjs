import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, writeFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliArgs } from "../dist/cli.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

// Dummy credentials and an unreachable Bridge port, with a throwaway data dir: nothing
// here can touch real mail or a real index.
async function tempEnv(extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pmbc-cli-test-"));
  return {
    dir,
    env: {
      ...process.env,
      PROTONMAIL_USERNAME: "user@example.com",
      PROTONMAIL_PASSWORD: "dummy",
      PROTONMAIL_IMAP_PORT: "9",
      PROTONMAIL_SMTP_PORT: "9",
      PROTONMAIL_DATA_DIR: dir,
      ...extra,
    },
  };
}

function runCli(args, env, input) {
  const result = spawnSync(process.execPath, [CLI, ...args], { env, input, encoding: "utf8", timeout: 60_000 });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("--help / -h after a command prints help and never runs the command", async () => {
  const { dir, env } = await tempEnv();
  try {
    const sentinel = join(dir, "mail-index.sqlite");
    await writeFile(sentinel, "not a real index");
    for (const args of [["clear-index", "--help"], ["clear-index", "-h"], ["--help", "clear-index"]]) {
      const result = runCli(args, env);
      assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
      assert.match(result.stdout, /clear-index/);
      await access(sentinel); // still there: the command did not run
    }
    for (const command of ["clear-cache", "sync", "bulk-delete", "doctor", "delete", "empty-folder"]) {
      const result = runCli([command, "--help"], env);
      assert.equal(result.code, 0, `${command} --help: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(command));
      assert.doesNotMatch(result.stderr, /ECONNREFUSED|Could not connect/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseCliArgs accepts --flag=value, splitting at the first =", () => {
  const parsed = parseCliArgs(["send", "--to=a@b.c", "--body=x=y", "--subject=", "--json"]);
  assert.equal(parsed.flags.to, "a@b.c");
  assert.equal(parsed.flags.body, "x=y");
  assert.equal(parsed.flags.subject, "");
  assert.equal(parsed.flags.json, true);
  assert.deepEqual(parsed.positionals, []);
});

test("parseCliArgs: =value may start with --, -- ends options, empty string is a value", () => {
  assert.equal(parseCliArgs(["send", "--body=--- sig"]).flags.body, "--- sig");

  const afterTerminator = parseCliArgs(["search", "--json", "--", "--weird", "--folder"]);
  assert.deepEqual(afterTerminator.positionals, ["--weird", "--folder"]);
  assert.equal(afterTerminator.flags.folder, undefined);
  assert.equal(afterTerminator.flags.json, true);

  const empty = parseCliArgs(["send", "--subject", "", "--json"]);
  assert.equal(empty.flags.subject, "");
  assert.deepEqual(empty.positionals, []);
});

test("parseCliArgs rejects a repeated value flag but tolerates a repeated boolean flag", () => {
  assert.throws(() => parseCliArgs(["get-logs", "--limit", "1", "--limit=2"]), /--limit.*more than once/);
  assert.doesNotThrow(() => parseCliArgs(["get-logs", "--json", "--json"]));
});

test("get-logs --limit=5 is parsed (the = form reaches the handler)", async () => {
  const { dir, env } = await tempEnv();
  try {
    const bad = runCli(["get-logs", "--limit=5x"], env);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /--limit/);
    const good = runCli(["get-logs", "--limit=5", "--json"], env);
    assert.equal(good.code, 0, good.stderr);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unknown flag is a usage error (exit 2) that names it and lists the valid ones", async () => {
  const { dir, env } = await tempEnv();
  try {
    const result = runCli(["search", "--frm", "a@b.c"], env);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--frm/);
    assert.match(result.stderr, /--from/);
    assert.doesNotMatch(result.stderr, /ECONNREFUSED/);

    const bulk = runCli(["bulk-delete", "--fromm=a@b.c", "--dry-run"], env);
    assert.equal(bulk.code, 2);
    assert.match(bulk.stderr, /--fromm/);

    // Flags the help text documents must stay accepted.
    const accounts = runCli(["list-accounts", "--checkConnections", "--json"], env);
    assert.notEqual(accounts.code, 2, accounts.stderr);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("numeric flags are strict: 5x, 1.5, -1 and a missing value are usage errors", async () => {
  const { dir, env } = await tempEnv();
  try {
    for (const bad of ["5x", "1.5", "-1", "0", ""]) {
      const result = runCli(["get-logs", `--limit=${bad}`], env);
      assert.equal(result.code, 2, `--limit=${bad}`);
      assert.match(result.stderr, /--limit/);
    }
    const missing = runCli(["get-logs", "--limit"], env);
    assert.equal(missing.code, 2);
    const undo = runCli(["send", "--to=a@b.c", "--subject=s", "--body=b", "--undo-window=10x"], env);
    assert.equal(undo.code, 2);
    const offset = runCli(["emails", "--offset=2x"], env);
    assert.equal(offset.code, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bulk-delete and bulk-move refuse to run without a filter (exit 2, before connecting)", async () => {
  const { dir, env } = await tempEnv();
  try {
    for (const args of [["bulk-delete"], ["bulk-delete", "--folder", "INBOX"], ["bulk-delete", "--from", ""], ["bulk-move", "Trash", "--folder", "INBOX"]]) {
      const result = runCli(args, env);
      assert.equal(result.code, 2, args.join(" "));
      assert.match(result.stderr, /at least one of --from, --subject, --since, --before/);
      assert.doesNotMatch(result.stderr, /ECONNREFUSED|Could not connect/);
    }
    // Control: with a filter the command proceeds to the Bridge (which is unreachable here).
    const withFilter = runCli(["bulk-delete", "--from=a@b.c", "--dry-run"], env);
    assert.equal(withFilter.code, 1);
    assert.match(withFilter.stderr, /connect/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("body text is passed through untrimmed (flag, = form and stdin)", async () => {
  const { dir, env } = await tempEnv();
  try {
    const bodyOf = (result) => {
      assert.equal(result.code, 0, result.stderr);
      return JSON.parse(JSON.parse(result.stdout).content[0].text).body;
    };
    assert.equal(bodyOf(runCli(["draft-create", "--to=a@b.c", "--subject=s", "--body=--- sig", "--json"], env)), "--- sig");
    assert.equal(bodyOf(runCli(["draft-create", "--to=a@b.c", "--subject=s", "--body=a\n  b", "--json"], env)), "a\n  b");
    // Indented lines and the "-- " signature delimiter (trailing space) survive; the one
    // trailing newline of piped input is dropped.
    assert.equal(
      bodyOf(runCli(["draft-create", "--to=a@b.c", "--subject=s", "--json"], env, "first\n    indented\n-- \nsig\n")),
      "first\n    indented\n-- \nsig",
    );
    assert.equal(bodyOf(runCli(["draft-create", "--to=a@b.c", "--subject=s", "--json", "--"], env, "x\n")), "x");
    // All-whitespace stdin is "no body", not an empty draft.
    assert.equal(runCli(["draft-create", "--to=a@b.c", "--subject=s"], env, "  \n\n").code, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the CLI never trims a body itself (leading indentation is data)", async () => {
  // The MCP server still trims the ends of a body it receives (requireString in index.ts),
  // so this cannot be observed end to end; pin the CLI side structurally instead.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(CLI, "utf8");
  assert.doesNotMatch(source, /toString\("utf8"\)\.trim\(\)/);
  assert.match(source, /async function readStdinBody/);
});

test("a closed stdout pipe (| head) exits 0 without logging an uncaught EPIPE", async () => {
  const { dir, env } = await tempEnv();
  try {
    const child = spawn(process.execPath, [CLI, "tools", "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.once("data", () => child.stdout.destroy());
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.doesNotMatch(stderr, /EPIPE|Uncaught/);
    assert.equal(code, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("every dispatched command has help text and a declared flag list", async () => {
  const { readFile } = await import("node:fs/promises");
  const { COMMAND_SPECS, TOOL_ONLY_COMMANDS, commandHelpText } = await import("../dist/cli.js");
  const source = await readFile(CLI, "utf8");
  const mainBody = source.slice(source.indexOf("export async function main"));
  const dispatched = [...mainBody.matchAll(/case "([a-z][a-z-]*)":/g)].map((match) => match[1]).filter((name) => name !== "version" || "version" in COMMAND_SPECS);
  for (const command of new Set([...dispatched, ...TOOL_ONLY_COMMANDS.map((entry) => entry.command)])) {
    const text = commandHelpText(command);
    assert.ok(text, `no help for ${command}`);
    assert.match(text, new RegExp(`Usage: proton-mail-bridge ${command}`));
  }
});
