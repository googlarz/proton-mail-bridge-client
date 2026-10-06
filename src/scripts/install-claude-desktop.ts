import { execFile } from "node:child_process";
import { constants as fsConstants, realpathSync } from "node:fs";
import { access, chmod, copyFile, cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const DEFAULT_SERVER_NAME = "proton-mail-bridge";
const execFileAsync = promisify(execFile);

export interface ClaudeDesktopServerConfig {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export interface InstallOptions {
  configPath?: string;
  serverName?: string;
  cwd?: string;
  runtimeDir?: string;
  command?: string;
  includeEnv?: boolean;
  env?: Record<string, string>;
  useRepoRuntime?: boolean;
  /** Test seams for the staged install; the defaults are the real implementations. */
  installDependencies?: (stagingDir: string, hasLockfile: boolean) => Promise<void>;
  afterInstall?: (stagingDir: string) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  verifyRuntime?: (dir: string, nodeCommand: string, expectedVersion: string) => Promise<void>;
}

function parseCliArgs(argv: string[]): InstallOptions {
  const options: InstallOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    switch (token) {
      case "--config-path":
        if (!next) {
          throw new Error("--config-path requires a value.");
        }
        options.configPath = next;
        index += 1;
        break;
      case "--server-name":
        if (!next) {
          throw new Error("--server-name requires a value.");
        }
        options.serverName = next;
        index += 1;
        break;
      case "--cwd":
        if (!next) {
          throw new Error("--cwd requires a value.");
        }
        options.cwd = next;
        index += 1;
        break;
      case "--runtime-dir":
        if (!next) {
          throw new Error("--runtime-dir requires a value.");
        }
        options.runtimeDir = next;
        index += 1;
        break;
      case "--command":
        if (!next) {
          throw new Error("--command requires a value.");
        }
        options.command = next;
        index += 1;
        break;
      case "--use-repo-build":
        options.useRepoRuntime = true;
        break;
      case "--no-env":
        options.includeEnv = false;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return options;
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: node dist/scripts/install-claude-desktop.js [options]",
      "",
      "Options:",
      "  --config-path <path>  Override Claude Desktop config path",
      "  --server-name <name>  MCP server key to write (default: proton-mail-bridge)",
      "  --cwd <path>          Repo root to stage the MCP runtime from",
      "  --runtime-dir <path>  Stable runtime directory used by Claude Desktop",
      "  --command <path>      Node executable to use (default: current process.execPath, resolved to the stable Homebrew symlink when detected)",
      "  --use-repo-build      Point Claude Desktop at the current repo build instead of a stable runtime copy",
      "  --no-env              Do not copy current PROTONMAIL_* / DEBUG env into config",
    ].join("\n"),
  );
}

function resolveSourceRepoRoot(explicitPath?: string): string {
  return resolve(explicitPath || join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
}

export function resolveClaudeDesktopConfigPath(explicitPath?: string): string {
  if (explicitPath?.trim()) {
    return resolve(explicitPath);
  }

  const fromEnv = process.env.CLAUDE_DESKTOP_CONFIG_PATH?.trim();
  if (fromEnv) {
    return resolve(fromEnv);
  }

  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32":
      return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    default:
      return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
  }
}

export function resolveClaudeDesktopRuntimeDir(explicitPath?: string): string {
  if (explicitPath?.trim()) {
    return resolve(explicitPath);
  }

  const fromEnv = process.env.PROTONMAIL_CLAUDE_RUNTIME_DIR?.trim();
  if (fromEnv) {
    return resolve(fromEnv);
  }

  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "Proton Mail Bridge Client");
    case "win32":
      return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Proton Mail Bridge Client");
    default:
      return join(homedir(), ".local", "share", "proton-mail-bridge-client");
  }
}

export function collectInstallEnv(sourceEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(sourceEnv).filter(
      ([key, value]) =>
        Boolean(value) &&
        (key.startsWith("PROTONMAIL_") || key === "DEBUG") &&
        // The installer's own override; the server never reads it.
        key !== "PROTONMAIL_CLAUDE_RUNTIME_DIR",
    ) as Array<[string, string]>,
  );
}

// Homebrew's `node` formula installs into a version-pinned Cellar directory
// (e.g. /opt/homebrew/Cellar/node/25.8.0/bin/node) and symlinks a stable
// `bin/node` on top of it. `process.execPath` always resolves through that
// symlink to the *versioned* path — so writing it verbatim into
// claude_desktop_config.json permanently pins the config to one Node
// version. The next `brew upgrade node && brew cleanup` deletes that exact
// Cellar directory, and Claude Desktop can no longer spawn the server at
// all — it just silently stops working until someone manually re-runs
// setup. Flagged by a contributor in PR #11's description but deliberately
// left out of that PR as a separate concern.
//
// Fix: if execPath sits under a Homebrew Cellar/node/<version>/bin
// directory, prefer the stable sibling bin/node one level above Cellar/,
// but only after confirming (via realpath) that the stable path actually
// resolves back to this exact execPath — i.e. it really is the live
// symlink for the version currently running, not some other stale/
// mismatched install. Any nvm/asdf/system Node, or a Homebrew layout that
// doesn't verify, falls straight through to execPath unchanged — those are
// either already version-managed a different way or we can't safely assume
// a stable alternative exists.
export function resolveStableNodeCommand(
  execPath: string,
  realpath: (path: string) => string = (path) => realpathSync(path),
): string {
  // `node` -> <prefix>/bin/node; versioned formulae (`node@22`) keep their stable
  // link under <prefix>/opt/node@22/bin/node (there is no <prefix>/bin/node for them).
  const cellarMatch = execPath.match(/^(.*)\/Cellar\/(node(?:@\d+)?)\/[^/]+\/bin\/node$/);
  if (!cellarMatch) {
    return execPath;
  }

  const stableCandidate =
    cellarMatch[2] === "node"
      ? join(cellarMatch[1], "bin", "node")
      : join(cellarMatch[1], "opt", cellarMatch[2], "bin", "node");
  try {
    if (realpath(stableCandidate) === execPath) {
      return stableCandidate;
    }
  } catch {
    // Candidate doesn't exist or isn't resolvable — fall through.
  }

  return execPath;
}

/** A version-pinned nvm path stops existing after `nvm uninstall`; the config would silently break. */
export function nodeCommandWarnings(command: string): string[] {
  if (/[\\/]\.nvm[\\/]versions[\\/]node[\\/]v[^\\/]+[\\/]bin[\\/]node$/.test(command)) {
    return [
      `The configured Node (${command}) is a version-pinned nvm path. It disappears after "nvm uninstall"/"nvm install" of another version and Claude Desktop would then fail to start the server. Install Node via Homebrew or pass --command with a stable path.`,
    ];
  }
  return [];
}

export function buildClaudeDesktopServerConfig(
  options: InstallOptions = {},
): { serverName: string; serverConfig: ClaudeDesktopServerConfig } {
  const cwd = resolve(options.runtimeDir || options.cwd || resolveSourceRepoRoot());
  const command = options.command || resolveStableNodeCommand(process.execPath);
  const env = {
    ...(options.includeEnv === false ? {} : collectInstallEnv()),
    ...(options.env ?? {}),
  };

  return {
    serverName: options.serverName || DEFAULT_SERVER_NAME,
    serverConfig: {
      command,
      args: [join(cwd, "dist", "index.js")],
      cwd,
      ...(env && Object.keys(env).length > 0 ? { env } : {}),
    },
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function getNpmExecutable(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function buildRuntimeInstallArgs(hasLockfile: boolean): string[] {
  // `npm ci` requires a lockfile. npm never ships package-lock.json inside a published
  // tarball, so a global/npx install has none and must fall back to `npm install`.
  return hasLockfile
    ? ["ci", "--omit=dev", "--ignore-scripts"]
    : ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"];
}

async function installRuntimeDependencies(runtimeDir: string, hasLockfile: boolean): Promise<void> {
  // On Windows, .cmd files (npm.cmd) require shell: true — execFile cannot run them directly.
  const shellOpts = process.platform === "win32" ? { shell: true } : {};

  await execFileAsync(getNpmExecutable(), buildRuntimeInstallArgs(hasLockfile), {
    cwd: runtimeDir,
    env: process.env,
    ...shellOpts,
  });

  // better-sqlite3 is native; rebuild it in the staged runtime so Claude Desktop
  // gets the correct binary for the current machine instead of whatever was built elsewhere.
  await execFileAsync(getNpmExecutable(), ["rebuild", "better-sqlite3"], {
    cwd: runtimeDir,
    env: process.env,
    ...shellOpts,
  });
}

// Runs in the runtime dir with the node Claude Desktop will use. Exits non-zero (stderr says why)
// unless the native module works, the version matches and both entry points import.
const VERIFY_SCRIPT = [
  'const { createRequire } = require("node:module");',
  'const path = require("node:path");',
  'const req = createRequire(path.join(process.cwd(), "package.json"));',
  'const Database = req("better-sqlite3");',
  'const db = new Database(":memory:");',
  'db.prepare("select 1").get();',
  "db.close();",
  'const version = req("./package.json").version;',
  'if (version !== process.argv[1]) throw new Error("runtime package.json is " + version + ", expected " + process.argv[1]);',
  'Promise.all([import("./dist/index.js"), import("./dist/lib.js")]).then(() => process.exit(0), (error) => { console.error(error && error.stack || String(error)); process.exit(1); });',
].join("\n");

export async function verifyRuntime(dir: string, nodeCommand: string, expectedVersion: string): Promise<void> {
  try {
    await execFileAsync(nodeCommand, ["-e", VERIFY_SCRIPT, expectedVersion], { cwd: dir, timeout: 60_000 });
  } catch (error) {
    const detail =
      (error as { stderr?: string }).stderr?.trim() || (error instanceof Error ? error.message : String(error));
    throw new Error(`Runtime verification failed in ${dir}: ${detail}`);
  }
}

// Entries the installer owns inside the runtime dir; anything else is the user's and is carried over.
const MANAGED_RUNTIME_ENTRIES = new Set(["dist", "node_modules", "package.json", "package-lock.json"]);

export async function prepareClaudeDesktopRuntime(options: InstallOptions = {}): Promise<{
  runtimeDir: string;
  sourceCwd: string;
  usedRepoRuntime: boolean;
}> {
  const sourceCwd = resolveSourceRepoRoot(options.cwd);
  const runtimeDir = options.useRepoRuntime ? sourceCwd : resolveClaudeDesktopRuntimeDir(options.runtimeDir);

  if (options.useRepoRuntime || runtimeDir === sourceCwd) {
    return {
      runtimeDir,
      sourceCwd,
      usedRepoRuntime: true,
    };
  }

  // Build and verify a complete runtime next to the live one, then swap by rename. The live
  // runtime is never touched until the replacement is known to work, and the old one is kept
  // as <runtimeDir>.previous (release 2.2.0 broke a machine by deleting dist and running
  // `npm ci` in place).
  const stagingDir = `${runtimeDir}.staging-${process.pid}`;
  const previousDir = `${runtimeDir}.previous`;
  const nodeCommand = options.command || resolveStableNodeCommand(process.execPath);
  const verify = options.verifyRuntime ?? verifyRuntime;
  const move = options.rename ?? rename;
  const install = options.installDependencies ?? installRuntimeDependencies;
  const { version } = JSON.parse(await readFile(join(sourceCwd, "package.json"), "utf8")) as { version: string };

  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(dirname(runtimeDir), { recursive: true });
  await mkdir(stagingDir);

  try {
    await cp(join(sourceCwd, "dist"), join(stagingDir, "dist"), { recursive: true });
    await copyFile(join(sourceCwd, "package.json"), join(stagingDir, "package.json"));

    // Only present when installing from a git checkout; published tarballs never contain it.
    const hasLockfile = await pathExists(join(sourceCwd, "package-lock.json"));
    if (hasLockfile) {
      await copyFile(join(sourceCwd, "package-lock.json"), join(stagingDir, "package-lock.json"));
    }

    await install(stagingDir, hasLockfile);
    await options.afterInstall?.(stagingDir);
    await verify(stagingDir, nodeCommand, version);

    const hadPrevious = await pathExists(runtimeDir);
    if (hadPrevious) {
      for (const entry of await readdir(runtimeDir)) {
        if (!MANAGED_RUNTIME_ENTRIES.has(entry)) {
          await cp(join(runtimeDir, entry), join(stagingDir, entry), { recursive: true });
        }
      }
      await rm(previousDir, { recursive: true, force: true });
      await move(runtimeDir, previousDir);
    }

    try {
      await move(stagingDir, runtimeDir);
      await verify(runtimeDir, nodeCommand, version);
    } catch (error) {
      await rm(runtimeDir, { recursive: true, force: true });
      if (hadPrevious) {
        await move(previousDir, runtimeDir);
      }
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${
          hadPrevious ? "The previous runtime was restored." : "Nothing was installed."
        }`,
      );
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }

  return {
    runtimeDir,
    sourceCwd,
    usedRepoRuntime: false,
  };
}

export function mergeClaudeDesktopConfig(
  existing: Record<string, unknown>,
  serverName: string,
  serverConfig: ClaudeDesktopServerConfig,
): Record<string, unknown> {
  const existingServers =
    existing.mcpServers && typeof existing.mcpServers === "object" && !Array.isArray(existing.mcpServers)
      ? (existing.mcpServers as Record<string, unknown>)
      : {};

  // collectInstallEnv() only sees PROTONMAIL_*/DEBUG vars exported in the shell running this
  // installer; it cannot see keys that were hand-added to the config (accounts, signature, ...).
  // Replacing the env wholesale dropped them: with only PROTONMAIL_PASSWORD exported, the
  // existing PROTONMAIL_ACCOUNTS_JSON vanished. Merge instead, new values winning per key.
  const existingServerConfig = existingServers[serverName];
  const existingEnv =
    existingServerConfig &&
    typeof existingServerConfig === "object" &&
    !Array.isArray(existingServerConfig) &&
    (existingServerConfig as { env?: unknown }).env &&
    typeof (existingServerConfig as { env?: unknown }).env === "object"
      ? ((existingServerConfig as { env: Record<string, string> }).env)
      : undefined;
  const env = { ...existingEnv, ...serverConfig.env };

  return {
    ...existing,
    mcpServers: {
      ...existingServers,
      [serverName]: {
        ...serverConfig,
        ...(Object.keys(env).length > 0 ? { env } : {}),
      },
    },
  };
}

function lineOf(raw: string, message: string): string {
  const line = message.match(/\(line (\d+)/)?.[1];
  if (line) return line;
  const position = message.match(/position (\d+)/)?.[1];
  if (position) return String(raw.slice(0, Number(position)).split("\n").length);
  return "unknown";
}

export function parseClaudeDesktopConfig(raw: string, configPath: string): Record<string, unknown> {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${basename(configPath)} is not valid JSON at line ${lineOf(text, message)}: ${message} — Claude Desktop does not accept comments or trailing commas. The file was not changed.`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Claude Desktop config at ${configPath} must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

async function readExistingConfig(configPath: string): Promise<Record<string, unknown>> {
  try {
    return parseClaudeDesktopConfig(await readFile(configPath, "utf8"), configPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

// Fail before the runtime is replaced, not after: a read-only config used to surface only at
// the final write, with the new runtime already in place and a stray backup left behind.
async function assertConfigWritable(configPath: string): Promise<void> {
  try {
    await access(configPath, fsConstants.W_OK);
    return;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT")) {
      throw new Error(`Claude Desktop config ${configPath} is not writable: ${(error as Error).message}`);
    }
  }
  // Not there yet: the first existing ancestor must be writable.
  let dir = dirname(configPath);
  while (!(await pathExists(dir)) && dirname(dir) !== dir) dir = dirname(dir);
  try {
    await access(dir, fsConstants.W_OK);
  } catch (error) {
    throw new Error(`Cannot create ${configPath}: ${(error as Error).message}`);
  }
}

const MAX_CONFIG_BACKUPS = 5;

async function pruneConfigBackups(configPath: string): Promise<void> {
  const prefix = `${basename(configPath)}.bak-`;
  // The names embed an ISO timestamp, so lexical order is chronological.
  const backups = (await readdir(dirname(configPath))).filter((name) => name.startsWith(prefix)).sort();
  for (const name of backups.slice(0, Math.max(0, backups.length - MAX_CONFIG_BACKUPS))) {
    await rm(join(dirname(configPath), name), { force: true });
  }
}

async function backupConfigIfPresent(configPath: string): Promise<string | undefined> {
  try {
    await access(configPath, fsConstants.F_OK);
    const backupPath = `${configPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    // configPath holds live Bridge credentials (PROTONMAIL_ACCOUNTS_JSON etc.) —
    // copyFile inherits the umask like a plain write, so without this the backup
    // could land world/group-readable even though the file it's copied from is
    // tightened below. Matches the 0o600 convention used everywhere else in this
    // codebase that persists secrets (audit log, draft store, delivery queue).
    await copyFile(configPath, backupPath);
    await chmod(backupPath, 0o600);
    await pruneConfigBackups(configPath);
    return backupPath;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

const SECRET_KEY = /password|secret|token/i;
const REDACTED = "[redacted]";

function redactAccountsJson(value: string): string {
  try {
    const parsed = JSON.parse(value);
    const scrub = (node: unknown): unknown =>
      Array.isArray(node)
        ? node.map(scrub)
        : node && typeof node === "object"
          ? Object.fromEntries(
              Object.entries(node).map(([key, inner]) => [key, SECRET_KEY.test(key) ? REDACTED : scrub(inner)]),
            )
          : node;
    return JSON.stringify(scrub(parsed));
  } catch {
    return REDACTED;
  }
}

/** Copy of an env map that is safe to print: secret values hidden, key names kept. */
export function redactEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      key === "PROTONMAIL_ACCOUNTS_JSON" ? redactAccountsJson(value) : SECRET_KEY.test(key) ? REDACTED : value,
    ]),
  );
}

export async function installClaudeDesktopConfig(options: InstallOptions = {}): Promise<{
  configPath: string;
  backupPath?: string;
  serverName: string;
  serverConfig: ClaudeDesktopServerConfig;
  runtimeDir: string;
  sourceCwd: string;
  usedRepoRuntime: boolean;
  warnings: string[];
}> {
  const configPath = resolveClaudeDesktopConfigPath(options.configPath);
  // Validate first (bad JSON, read-only) so nothing has been replaced when we refuse.
  await readExistingConfig(configPath);
  await assertConfigWritable(configPath);

  const runtime = await prepareClaudeDesktopRuntime(options);
  const { serverName, serverConfig } = buildClaudeDesktopServerConfig({
    ...options,
    runtimeDir: runtime.runtimeDir,
  });

  // Read again now: Claude Desktop or the user may have edited the file while the runtime installed.
  const existing = await readExistingConfig(configPath);
  const merged = mergeClaudeDesktopConfig(existing, serverName, serverConfig);

  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const backupPath = await backupConfigIfPresent(configPath);
  // Temp file in the same directory + rename, so a crash never leaves a half-written config.
  // See backupConfigIfPresent's comment: this file holds live Bridge credentials.
  const tempPath = `${configPath}.tmp-${process.pid}`;
  try {
    await writeFile(tempPath, `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, configPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }

  return {
    configPath,
    backupPath,
    serverName,
    serverConfig,
    runtimeDir: runtime.runtimeDir,
    sourceCwd: runtime.sourceCwd,
    usedRepoRuntime: runtime.usedRepoRuntime,
    warnings: nodeCommandWarnings(serverConfig.command),
  };
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const result = await installClaudeDesktopConfig(options);
  const printable = {
    ...result,
    serverConfig: {
      ...result.serverConfig,
      ...(result.serverConfig.env ? { env: redactEnv(result.serverConfig.env) } : {}),
    },
  };
  process.stdout.write(`${JSON.stringify(printable, null, 2)}\n`);
  for (const warning of result.warnings) {
    process.stderr.write(`Warning: ${warning}\n`);
  }
}

const isDirectExecution =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
