import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectInstallEnv,
  installClaudeDesktopConfig,
  mergeClaudeDesktopConfig,
  nodeCommandWarnings,
  redactEnv,
  resolveStableNodeCommand,
  verifyRuntime,
} from "../dist/scripts/install-claude-desktop.js";

const POSIX = { skip: process.platform === "win32" ? "POSIX-only" : false };
const serverConfig = (env) => ({ command: "node", args: ["/new/dist/index.js"], cwd: "/new", ...(env ? { env } : {}) });
const tmp = () => mkdtemp(join(tmpdir(), "installer-config-"));

test("merge keeps existing env keys that the shell did not export", () => {
  const merged = mergeClaudeDesktopConfig(
    { mcpServers: { "proton-mail-bridge": { env: { PROTONMAIL_ACCOUNTS_JSON: "[]", PROTONMAIL_SIGNATURE: "-- me", PROTONMAIL_PASSWORD: "old" } } } },
    "proton-mail-bridge",
    serverConfig({ PROTONMAIL_PASSWORD: "new", PROTONMAIL_DEBUG: "1" }),
  );
  assert.deepEqual(merged.mcpServers["proton-mail-bridge"].env, {
    PROTONMAIL_ACCOUNTS_JSON: "[]",
    PROTONMAIL_SIGNATURE: "-- me",
    PROTONMAIL_PASSWORD: "new",
    PROTONMAIL_DEBUG: "1",
  });
});

test("collectInstallEnv does not copy the installer's own runtime-dir override", () => {
  assert.deepEqual(collectInstallEnv({ PROTONMAIL_CLAUDE_RUNTIME_DIR: "/x", PROTONMAIL_USERNAME: "u" }), {
    PROTONMAIL_USERNAME: "u",
  });
});

test("redactEnv hides secret values and passwords inside ACCOUNTS_JSON but keeps key names", () => {
  const out = redactEnv({
    PROTONMAIL_USERNAME: "me@proton.me",
    PROTONMAIL_PASSWORD: "hunter2",
    PROTONMAIL_API_TOKEN: "tok",
    PROTONMAIL_ACCOUNTS_JSON: JSON.stringify([{ address: "a@proton.me", password: "pw-a" }]),
  });
  assert.equal(out.PROTONMAIL_USERNAME, "me@proton.me");
  assert.ok(!JSON.stringify(out).includes("hunter2"));
  assert.ok(!JSON.stringify(out).includes("pw-a"));
  assert.ok(!JSON.stringify(out).includes("tok\""));
  assert.match(out.PROTONMAIL_ACCOUNTS_JSON, /a@proton\.me/);
  assert.deepEqual(Object.keys(out).sort(), [
    "PROTONMAIL_ACCOUNTS_JSON",
    "PROTONMAIL_API_TOKEN",
    "PROTONMAIL_PASSWORD",
    "PROTONMAIL_USERNAME",
  ]);
  assert.equal(redactEnv({ PROTONMAIL_ACCOUNTS_JSON: "{not json" }).PROTONMAIL_ACCOUNTS_JSON, "[redacted]");
});

test("resolveStableNodeCommand handles versioned Homebrew formulae", POSIX, () => {
  const execPath = "/opt/homebrew/Cellar/node@22/22.5.0/bin/node";
  assert.equal(
    resolveStableNodeCommand(execPath, (p) => {
      assert.equal(p, "/opt/homebrew/opt/node@22/bin/node");
      return execPath;
    }),
    "/opt/homebrew/opt/node@22/bin/node",
  );
});

test("nodeCommandWarnings flags a version-pinned nvm path only", () => {
  assert.equal(nodeCommandWarnings("/Users/x/.nvm/versions/node/v24.13.1/bin/node").length, 1);
  assert.deepEqual(nodeCommandWarnings("/opt/homebrew/bin/node"), []);
});

async function configFixture(raw) {
  const dir = await tmp();
  const configPath = join(dir, "claude_desktop_config.json");
  if (raw !== undefined) await writeFile(configPath, raw, { mode: 0o600 });
  return { dir, configPath };
}
const opts = (configPath, extra = {}) => ({ configPath, useRepoRuntime: true, includeEnv: false, command: "node", ...extra });

test("config with a UTF-8 BOM is accepted", async () => {
  const { configPath } = await configFixture('﻿{"theme":"dark"}');
  await installClaudeDesktopConfig(opts(configPath));
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).theme, "dark");
});

test("config with comments or trailing commas fails clearly and is left untouched", async () => {
  for (const raw of ['{\n  // note\n  "a": 1\n}', '{\n  "a": 1,\n}']) {
    const { dir, configPath } = await configFixture(raw);
    await assert.rejects(
      installClaudeDesktopConfig(opts(configPath)),
      /claude_desktop_config\.json is not valid JSON at line [23]: .*does not accept comments/s,
    );
    assert.equal(await readFile(configPath, "utf8"), raw);
    assert.deepEqual(await readdir(dir), ["claude_desktop_config.json"], "no backup or temp file");
  }
});

test("a read-only config fails before the runtime step and leaves no backup", POSIX, async (t) => {
  const { dir, configPath } = await configFixture("{}");
  await chmod(configPath, 0o444);
  if (process.getuid?.() === 0) return t.skip("root bypasses file modes");
  let runtimeTouched = false;
  await assert.rejects(
    installClaudeDesktopConfig({
      ...opts(configPath, { useRepoRuntime: false }),
      cwd: dir,
      runtimeDir: join(dir, "runtime"),
      installDependencies: async () => { runtimeTouched = true; },
    }),
    /not writable/,
  );
  assert.equal(runtimeTouched, false);
  assert.deepEqual(await readdir(dir), ["claude_desktop_config.json"]);
});

test("config edits made during the runtime step are not lost", async () => {
  const { dir, configPath } = await configFixture('{"before":1}');
  await mkdir(join(dir, "src", "dist"), { recursive: true });
  await writeFile(join(dir, "src", "dist", "index.js"), "");
  await writeFile(join(dir, "src", "package.json"), '{"version":"1.0.0"}');
  await installClaudeDesktopConfig({
    ...opts(configPath, { useRepoRuntime: false }),
    cwd: join(dir, "src"),
    runtimeDir: join(dir, "runtime"),
    installDependencies: async () => writeFile(configPath, '{"before":1,"during":2}'),
    verifyRuntime: async () => {},
  });
  const written = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(written.during, 2);
  assert.ok(written.mcpServers["proton-mail-bridge"]);
});

test("the config is written atomically with mode 0600 and no temp file remains", POSIX, async () => {
  const { dir, configPath } = await configFixture('{"a":1}');
  await installClaudeDesktopConfig(opts(configPath));
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  assert.ok(!(await readdir(dir)).some((name) => name.includes(".tmp-")));
});

test("only the 5 newest config backups are kept", POSIX, async () => {
  const { dir, configPath } = await configFixture("{}");
  for (let i = 1; i <= 7; i += 1) {
    await writeFile(`${configPath}.bak-2020-01-0${i}T00-00-00-000Z`, "{}", { mode: 0o600 });
  }
  const { backupPath } = await installClaudeDesktopConfig(opts(configPath));
  const backups = (await readdir(dir)).filter((name) => name.includes(".bak-")).sort();
  assert.equal(backups.length, 5);
  assert.ok(backups.includes(backupPath.split("/").pop()), "the new backup survives");
  assert.ok(!backups.includes("claude_desktop_config.json.bak-2020-01-01T00-00-00-000Z"), "oldest pruned");
});

test("installClaudeDesktopConfig returns warnings for a version-pinned nvm node", async () => {
  const { configPath } = await configFixture("{}");
  const result = await installClaudeDesktopConfig(opts(configPath, { command: "/h/.nvm/versions/node/v24.1.0/bin/node" }));
  assert.equal(result.warnings.length, 1);
});

test("verifyRuntime rejects a version mismatch", async () => {
  const dir = await tmp();
  await writeFile(join(dir, "package.json"), '{"version":"1.0.0"}');
  await symlink(new URL("../node_modules", import.meta.url).pathname, join(dir, "node_modules"));
  await assert.rejects(verifyRuntime(dir, process.execPath, "2.0.0"), /is 1\.0\.0, expected 2\.0\.0/);
});
