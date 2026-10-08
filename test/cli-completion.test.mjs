import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_SPECS, COMPLETION_SHELLS, TOOL_ONLY_COMMANDS, completionCommands, completionScript } from "../dist/cli.js";

// `completion <shell>` prints a tab-completion script generated from the CLI's own command and flag tables.

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const have = (binary) => spawnSync(binary, ["--version"], { stdio: "ignore" }).status !== null;
const names = () => [...new Set([...Object.keys(COMMAND_SPECS), ...TOOL_ONLY_COMMANDS.map((entry) => entry.command)])];

test("every command is offered, with the flags it accepts, in all three scripts", () => {
  const commands = completionCommands();
  assert.deepEqual(commands.map((command) => command.name).sort(), names().sort());
  for (const shell of COMPLETION_SHELLS) {
    const script = completionScript(shell);
    for (const command of commands) {
      assert.ok(script.includes(command.name), `${shell}: ${command.name}`);
      for (const flag of command.flags) assert.ok(script.includes(shell === "fish" ? `-l ${flag}` : `--${flag}`), `${shell}: ${command.name} --${flag}`);
    }
  }
  const sync = commands.find((command) => command.name === "sync");
  assert.ok(["folder", "limit", "full", "json", "help"].every((flag) => sync.flags.includes(flag)));
  assert.ok(commands.find((command) => command.name === "respond-to-invite").flags.includes("args"));
});

test("both binary names are covered", () => {
  for (const shell of COMPLETION_SHELLS) {
    const script = completionScript(shell);
    assert.ok(script.includes("proton-mail-bridge-client") && /proton-mail-bridge(?!-)/.test(script), shell);
  }
});

test("an unknown or missing shell is a usage error that lists the shells", () => {
  for (const shell of ["tcsh", ""]) {
    assert.throws(() => completionScript(shell), /completion needs a shell: zsh, bash, fish/);
  }
  const result = spawnSync(process.execPath, [CLI, "completion", "tcsh"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /completion needs a shell/);
});

test("the command prints a script on stdout and exits 0", () => {
  for (const shell of COMPLETION_SHELLS) {
    const result = spawnSync(process.execPath, [CLI, "completion", shell], { encoding: "utf8" });
    assert.equal(result.status, 0, shell);
    assert.ok(result.stdout.length > 500, shell);
    assert.equal(result.stdout, completionScript(shell), shell);
  }
});

test("the scripts are valid for the shells that are installed (quotes and apostrophes in descriptions do not break them)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "completion-"));
  try {
    for (const [shell, flag] of [["bash", "-n"], ["zsh", "-n"], ["fish", "-n"]]) {
      if (!have(shell)) { t.diagnostic(`${shell} is not installed, syntax not checked`); continue; }
      const file = join(dir, `completion.${shell}`);
      await writeFile(file, completionScript(shell));
      const result = spawnSync(shell, [flag, file], { encoding: "utf8" });
      assert.equal(result.status, 0, `${shell}: ${result.stderr}`);
    }
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("bash completes command names and then that command's flags", { skip: process.platform === "win32" || !have("bash") }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "completion-"));
  try {
    const file = join(dir, "completion.bash");
    await writeFile(file, completionScript("bash"));
    const run = (words, cword) => spawnSync("bash", ["-c", `source ${JSON.stringify(file)}; COMP_WORDS=(${words}); COMP_CWORD=${cword}; _proton_mail_bridge_client; echo "\${COMPREPLY[*]}"`], { encoding: "utf8" }).stdout.trim();
    assert.ok(run("proton-mail-bridge-client respond-to-i", 1).split(" ").includes("respond-to-invite"));
    assert.equal(run("proton-mail-bridge-client sync --fo", 2), "--folder");
    assert.ok(run("proton-mail-bridge-client list-reply-reminders --", 2).split(" ").includes("--args"));
    assert.equal(run("proton-mail-bridge-client no-such-command --x", 2), "");
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("zsh loads the script under compinit and registers it", { skip: process.platform === "win32" || !have("zsh") }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "completion-"));
  try {
    const file = join(dir, "completion.zsh");
    await writeFile(file, completionScript("zsh"));
    const result = spawnSync("zsh", ["-c", `autoload -Uz compinit; compinit -u -d ${JSON.stringify(join(dir, "zcompdump"))}; source ${JSON.stringify(file)} && print "\${_comps[proton-mail-bridge-client]}"`], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "_proton_mail_bridge_client");
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
