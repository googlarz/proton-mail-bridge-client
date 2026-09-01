import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
      "  --command <path>      Node executable to use (default: current process.execPath)",
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
      ([key, value]) => Boolean(value) && (key.startsWith("PROTONMAIL_") || key === "DEBUG"),
    ) as Array<[string, string]>,
  );
}

export function buildClaudeDesktopServerConfig(
  options: InstallOptions = {},
): { serverName: string; serverConfig: ClaudeDesktopServerConfig } {
  const cwd = resolve(options.runtimeDir || options.cwd || resolveSourceRepoRoot());
  const command = options.command || process.execPath;
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

  await mkdir(runtimeDir, { recursive: true });
  await rm(join(runtimeDir, "dist"), { recursive: true, force: true });
  await cp(join(sourceCwd, "dist"), join(runtimeDir, "dist"), { recursive: true, force: true });
  await copyFile(join(sourceCwd, "package.json"), join(runtimeDir, "package.json"));

  // Only present when installing from a git checkout; published tarballs never contain it.
  const lockfilePath = join(sourceCwd, "package-lock.json");
  const hasLockfile = await pathExists(lockfilePath);
  if (hasLockfile) {
    await copyFile(lockfilePath, join(runtimeDir, "package-lock.json"));
  } else {
    await rm(join(runtimeDir, "package-lock.json"), { force: true });
  }

  await installRuntimeDependencies(runtimeDir, hasLockfile);

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

  return {
    ...existing,
    mcpServers: {
      ...existingServers,
      [serverName]: serverConfig,
    },
  };
}

async function readExistingConfig(configPath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Claude Desktop config at ${configPath} must contain a JSON object.`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function backupConfigIfPresent(configPath: string): Promise<string | undefined> {
  try {
    await access(configPath, fsConstants.F_OK);
    const backupPath = `${configPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(configPath, backupPath);
    return backupPath;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function installClaudeDesktopConfig(options: InstallOptions = {}): Promise<{
  configPath: string;
  backupPath?: string;
  serverName: string;
  serverConfig: ClaudeDesktopServerConfig;
  runtimeDir: string;
  sourceCwd: string;
  usedRepoRuntime: boolean;
}> {
  const configPath = resolveClaudeDesktopConfigPath(options.configPath);
  const existing = await readExistingConfig(configPath);
  const runtime = await prepareClaudeDesktopRuntime(options);
  const { serverName, serverConfig } = buildClaudeDesktopServerConfig({
    ...options,
    runtimeDir: runtime.runtimeDir,
  });
  const merged = mergeClaudeDesktopConfig(existing, serverName, serverConfig);

  await mkdir(dirname(configPath), { recursive: true });
  const backupPath = await backupConfigIfPresent(configPath);
  await writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

  return {
    configPath,
    backupPath,
    serverName,
    serverConfig,
    runtimeDir: runtime.runtimeDir,
    sourceCwd: runtime.sourceCwd,
    usedRepoRuntime: runtime.usedRepoRuntime,
  };
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const result = await installClaudeDesktopConfig(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isDirectExecution =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
