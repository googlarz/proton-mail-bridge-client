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
  resolveStableNodeCommand,
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

test("mergeClaudeDesktopConfig keeps an existing env block when the new run has none to contribute", () => {
  // Reproduces a live incident: re-running the installer from a shell with no
  // PROTONMAIL_* vars exported used to wipe a working, hand-added env block
  // outright, breaking the server until the config was repaired by hand.
  const merged = mergeClaudeDesktopConfig(
    {
      mcpServers: {
        "proton-mail-bridge": {
          command: "node",
          args: ["/old/dist/index.js"],
          cwd: "/old",
          env: {
            PROTONMAIL_USERNAME: "user@proton.me",
            PROTONMAIL_PASSWORD: "secret",
          },
        },
      },
    },
    "proton-mail-bridge",
    {
      command: "node",
      args: ["/new/dist/index.js"],
      cwd: "/new",
    },
  );

  const server = merged.mcpServers["proton-mail-bridge"];
  assert.equal(server.cwd, "/new", "new runtime path still takes effect");
  assert.deepEqual(server.env, {
    PROTONMAIL_USERNAME: "user@proton.me",
    PROTONMAIL_PASSWORD: "secret",
  });
});

test("mergeClaudeDesktopConfig lets a freshly-collected env override the old one", () => {
  const merged = mergeClaudeDesktopConfig(
    {
      mcpServers: {
        "proton-mail-bridge": {
          command: "node",
          args: ["/old/dist/index.js"],
          cwd: "/old",
          env: { PROTONMAIL_USERNAME: "stale@proton.me" },
        },
      },
    },
    "proton-mail-bridge",
    {
      command: "node",
      args: ["/new/dist/index.js"],
      cwd: "/new",
      env: { PROTONMAIL_USERNAME: "fresh@proton.me" },
    },
  );

  assert.deepEqual(merged.mcpServers["proton-mail-bridge"].env, { PROTONMAIL_USERNAME: "fresh@proton.me" });
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

test("resolveStableNodeCommand swaps a Homebrew Cellar path for its verified stable symlink", () => {
  // Reproduces the real bug: writing process.execPath verbatim into
  // claude_desktop_config.json pins it to a version-specific Cellar path
  // that `brew upgrade node && brew cleanup` deletes, silently breaking the
  // server until setup is manually re-run.
  const execPath = "/opt/homebrew/Cellar/node/25.8.0/bin/node";
  const resolved = resolveStableNodeCommand(execPath, (path) => {
    assert.equal(path, "/opt/homebrew/bin/node");
    return execPath; // the stable symlink currently resolves back to this exact binary
  });

  assert.equal(resolved, "/opt/homebrew/bin/node");
});

test("resolveStableNodeCommand leaves non-Homebrew paths (nvm, system) untouched", () => {
  assert.equal(
    resolveStableNodeCommand("/Users/example/.nvm/versions/node/v24.13.1/bin/node"),
    "/Users/example/.nvm/versions/node/v24.13.1/bin/node",
  );
  assert.equal(resolveStableNodeCommand("/usr/bin/node"), "/usr/bin/node");
});

test("resolveStableNodeCommand falls back to execPath when the stable symlink doesn't verify", () => {
  const execPath = "/opt/homebrew/Cellar/node/25.8.0/bin/node";

  // Symlink exists but currently points at a different (already-upgraded) version —
  // trusting it blindly would silently swap in the wrong binary.
  assert.equal(
    resolveStableNodeCommand(execPath, () => "/opt/homebrew/Cellar/node/26.0.0/bin/node"),
    execPath,
  );

  // Symlink doesn't exist at all (e.g. mid-upgrade, or already cleaned up).
  assert.equal(
    resolveStableNodeCommand(execPath, () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }),
    execPath,
  );
});

test("buildClaudeDesktopServerConfig resolves a stable Node command by default", () => {
  const previousExecPath = process.execPath;
  Object.defineProperty(process, "execPath", {
    value: "/opt/homebrew/Cellar/node/25.8.0/bin/node",
    configurable: true,
  });

  try {
    const { serverConfig } = buildClaudeDesktopServerConfig({ runtimeDir: "/tmp/proton-runtime" });
    // No `command` override supplied, so it goes through resolveStableNodeCommand
    // against the real filesystem — on a machine without that exact Cellar path,
    // realpathSync throws and it falls straight back to execPath unchanged. Either
    // outcome proves the code path runs without crashing and never produces a
    // path other than the (possibly-resolved) execPath.
    assert.ok(
      serverConfig.command === "/opt/homebrew/Cellar/node/25.8.0/bin/node" ||
        serverConfig.command === "/opt/homebrew/bin/node",
    );
  } finally {
    Object.defineProperty(process, "execPath", { value: previousExecPath, configurable: true });
  }
});
