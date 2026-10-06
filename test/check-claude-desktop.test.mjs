import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getClaudeDesktopInstallStatus } from "../dist/scripts/check-claude-desktop.js";

test("getClaudeDesktopInstallStatus reports not installed when config is missing", async () => {
  const configPath = join(tmpdir(), `claude-missing-${Date.now()}.json`);
  const status = await getClaudeDesktopInstallStatus({ configPath });

  assert.equal(status.configExists, false);
  assert.equal(status.installed, false);
});

test("getClaudeDesktopInstallStatus reports installed runtime details", async () => {
  const baseDir = join(tmpdir(), `claude-install-${Date.now()}`);
  const runtimeDir = join(baseDir, "runtime");
  const distDir = join(runtimeDir, "dist");
  const nodeModulesDir = join(runtimeDir, "node_modules");
  const configPath = join(baseDir, "claude.json");

  await mkdir(distDir, { recursive: true });
  await mkdir(nodeModulesDir, { recursive: true });
  await writeFile(join(distDir, "index.js"), "console.log('ok');\n", "utf8");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        mcpServers: {
          "proton-mail-bridge": {
            command: "node",
            args: [join(runtimeDir, "dist", "index.js")],
            cwd: runtimeDir,
            env: {
              PROTONMAIL_USERNAME: "user@proton.me",
            },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const status = await getClaudeDesktopInstallStatus({ configPath });

  assert.equal(status.configExists, true);
  assert.equal(status.installed, true);
  assert.equal(status.runtimeDir, runtimeDir);
  assert.equal(status.runtimeEntryExists, true);
  assert.equal(status.runtimeNodeModulesExists, true);
  assert.equal(status.hasEnvConfig, true);
});

// ---- health checks (not just file presence) ----
import { mkdtemp, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { checkClaudeDesktopInstall } from "../dist/scripts/check-claude-desktop.js";

async function healthFixture({ command, distSource = "export const x = 1;\n", version = "1.2.3" }) {
  const dir = await mkdtemp(join(tmpdir(), "check-health-"));
  const runtimeDir = join(dir, "runtime");
  await mkdir(join(runtimeDir, "dist"), { recursive: true });
  await writeFile(join(runtimeDir, "dist", "index.js"), distSource);
  await writeFile(join(runtimeDir, "dist", "lib.js"), "export const y = 1;\n");
  await writeFile(join(runtimeDir, "package.json"), JSON.stringify({ version, type: "module" }));
  // Read-only link to the repo's modules: lets the real better-sqlite3 load without copying 26 MB.
  await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(runtimeDir, "node_modules"));
  const configPath = join(dir, "claude.json");
  await writeFile(
    configPath,
    JSON.stringify({ mcpServers: { "proton-mail-bridge": { command, args: [join(runtimeDir, "dist", "index.js")], cwd: runtimeDir } } }),
  );
  return { configPath };
}

test("check fails when the configured command does not exist, even though files are present", async () => {
  const { configPath } = await healthFixture({ command: "/nonexistent/node" });
  const health = await checkClaudeDesktopInstall({ configPath, sourceVersion: "1.2.3" });
  assert.equal(health.ok, false);
  assert.match(health.problems.join("\n"), /does not run/);
});

test("check fails on a garbage dist/index.js", async () => {
  const { configPath } = await healthFixture({ command: process.execPath, distSource: "this is ( not javascript" });
  const health = await checkClaudeDesktopInstall({ configPath, sourceVersion: "1.2.3" });
  assert.equal(health.ok, false);
  assert.match(health.problems.join("\n"), /verification failed/);
});

test("check fails when the runtime version differs from the installed package", async () => {
  const { configPath } = await healthFixture({ command: process.execPath });
  const health = await checkClaudeDesktopInstall({ configPath, sourceVersion: "9.9.9" });
  assert.equal(health.ok, false);
  assert.match(health.problems.join("\n"), /Runtime is version 1\.2\.3 but this package is 9\.9\.9/);
});

test("check passes for a working runtime", async () => {
  const { configPath } = await healthFixture({ command: process.execPath });
  const health = await checkClaudeDesktopInstall({ configPath, sourceVersion: "1.2.3" });
  assert.deepEqual(health.problems, []);
  assert.equal(health.ok, true);
});

test("check reports a missing config or registration as a failure", async () => {
  const missing = await checkClaudeDesktopInstall({ configPath: join(tmpdir(), `nope-${Date.now()}.json`) });
  assert.equal(missing.ok, false);
});

test("the CLI exits non-zero when a check fails", async () => {
  const { configPath } = await healthFixture({ command: "/nonexistent/node" });
  const script = fileURLToPath(new URL("../dist/scripts/check-claude-desktop.js", import.meta.url));
  await assert.rejects(promisify(execFile)(process.execPath, [script, "--config-path", configPath]), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /does not run/);
    return true;
  });
});
