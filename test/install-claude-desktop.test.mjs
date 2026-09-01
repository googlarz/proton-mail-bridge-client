import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  buildClaudeDesktopServerConfig,
  buildRuntimeInstallArgs,
  collectInstallEnv,
  mergeClaudeDesktopConfig,
  resolveClaudeDesktopConfigPath,
  resolveClaudeDesktopRuntimeDir,
} from "../dist/scripts/install-claude-desktop.js";

test("collectInstallEnv keeps only PROTONMAIL_* and DEBUG keys", () => {
  const env = collectInstallEnv({
    PROTONMAIL_USERNAME_FILE: "/run/secrets/user",
    PROTONMAIL_PASSWORD_COMMAND: "security find-generic-password ...",
    DEBUG: "true",
    HOME: "/Users/example",
  });

  assert.deepEqual(env, {
    PROTONMAIL_USERNAME_FILE: "/run/secrets/user",
    PROTONMAIL_PASSWORD_COMMAND: "security find-generic-password ...",
    DEBUG: "true",
  });
});

test("buildClaudeDesktopServerConfig points Claude Desktop at dist/index.js", () => {
  const { serverName, serverConfig } = buildClaudeDesktopServerConfig({
    cwd: "/tmp/protonmail-pro-mcp",
    command: "/usr/local/bin/node",
    env: { PROTONMAIL_USERNAME_FILE: "/run/secrets/user" },
  });

  assert.equal(serverName, "proton-mail-bridge");
  assert.equal(serverConfig.command, "/usr/local/bin/node");
  assert.deepEqual(serverConfig.args, ["/tmp/protonmail-pro-mcp/dist/index.js"]);
  assert.equal(serverConfig.cwd, "/tmp/protonmail-pro-mcp");
  assert.equal(serverConfig.env.PROTONMAIL_USERNAME_FILE, "/run/secrets/user");
});

test("buildClaudeDesktopServerConfig prefers a dedicated runtime directory when provided", () => {
  const { serverConfig } = buildClaudeDesktopServerConfig({
    cwd: "/tmp/source-repo",
    runtimeDir: "/tmp/proton-runtime",
    command: "/usr/local/bin/node",
  });

  assert.deepEqual(serverConfig.args, ["/tmp/proton-runtime/dist/index.js"]);
  assert.equal(serverConfig.cwd, "/tmp/proton-runtime");
});

test("mergeClaudeDesktopConfig preserves existing servers", () => {
  const merged = mergeClaudeDesktopConfig(
    {
      theme: "dark",
      mcpServers: {
        existing: {
          command: "node",
          args: ["dist/existing.js"],
          cwd: "/tmp/existing",
        },
      },
    },
    "proton-mail-bridge",
    {
      command: "node",
      args: ["dist/index.js"],
      cwd: "/tmp/protonmail-pro-mcp",
    },
  );

  assert.equal(merged.theme, "dark");
  assert.deepEqual(Object.keys(merged.mcpServers).sort(), ["existing", "proton-mail-bridge"]);
});

test("resolveClaudeDesktopConfigPath honors explicit paths", () => {
  const resolved = resolveClaudeDesktopConfigPath(join("/tmp", "claude.json"));
  assert.equal(resolved, "/tmp/claude.json");
});

test("resolveClaudeDesktopRuntimeDir honors explicit paths", () => {
  const resolved = resolveClaudeDesktopRuntimeDir(join("/tmp", "proton-runtime"));
  assert.equal(resolved, "/tmp/proton-runtime");
});

test("buildClaudeDesktopServerConfig keeps explicitly provided env when includeEnv is false", () => {
  // The setup wizard passes includeEnv:false (do not inherit ambient PROTONMAIL_*)
  // together with the answers it collected. Those answers must survive.
  const { serverConfig } = buildClaudeDesktopServerConfig({
    runtimeDir: "/tmp/proton-runtime",
    includeEnv: false,
    env: {
      PROTONMAIL_USERNAME: "user@example.com",
      PROTONMAIL_PASSWORD: "bridge-password",
    },
  });

  assert.equal(serverConfig.env.PROTONMAIL_USERNAME, "user@example.com");
  assert.equal(serverConfig.env.PROTONMAIL_PASSWORD, "bridge-password");
});

test("buildClaudeDesktopServerConfig with includeEnv false still ignores ambient env", () => {
  const previous = process.env.PROTONMAIL_USERNAME;
  process.env.PROTONMAIL_USERNAME = "ambient@example.com";

  try {
    const { serverConfig } = buildClaudeDesktopServerConfig({
      runtimeDir: "/tmp/proton-runtime",
      includeEnv: false,
    });

    assert.equal(serverConfig.env, undefined);
  } finally {
    if (previous === undefined) {
      delete process.env.PROTONMAIL_USERNAME;
    } else {
      process.env.PROTONMAIL_USERNAME = previous;
    }
  }
});

test("buildRuntimeInstallArgs uses npm ci only when a lockfile is present", () => {
  assert.deepEqual(buildRuntimeInstallArgs(true), ["ci", "--omit=dev", "--ignore-scripts"]);
  assert.deepEqual(buildRuntimeInstallArgs(false), [
    "install",
    "--omit=dev",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ]);
});
