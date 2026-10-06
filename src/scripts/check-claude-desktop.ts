import { constants as fsConstants } from "node:fs";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  nodeCommandWarnings,
  parseClaudeDesktopConfig,
  resolveClaudeDesktopConfigPath,
  verifyRuntime,
} from "./install-claude-desktop.js";

const execFileAsync = promisify(execFile);

const DEFAULT_SERVER_NAME = "proton-mail-bridge";

export interface ClaudeDesktopInstallStatus {
  configPath: string;
  serverName: string;
  configExists: boolean;
  installed: boolean;
  runtimeDir?: string;
  entryCommand?: string;
  entryArgs?: string[];
  runtimeEntryExists: boolean;
  runtimeNodeModulesExists: boolean;
  hasEnvConfig: boolean;
}

function parseCliArgs(argv: string[]): { configPath?: string; serverName?: string; json?: boolean } {
  const options: { configPath?: string; serverName?: string; json?: boolean } = {};

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
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          [
            "Usage: node dist/scripts/check-claude-desktop.js [options]",
            "",
            "Options:",
            "  --config-path <path>  Override Claude Desktop config path",
            "  --server-name <name>  MCP server key to inspect (default: proton-mail-bridge)",
            "  --json                Print machine-readable JSON output",
          ].join("\n"),
        );
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return options;
}

async function pathExists(targetPath: string | undefined): Promise<boolean> {
  if (!targetPath) {
    return false;
  }

  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function getClaudeDesktopInstallStatus(options: {
  configPath?: string;
  serverName?: string;
} = {}): Promise<ClaudeDesktopInstallStatus> {
  const configPath = resolveClaudeDesktopConfigPath(options.configPath);
  const serverName = options.serverName || DEFAULT_SERVER_NAME;

  let configExists = false;
  let parsed: Record<string, unknown> = {};

  try {
    parsed = parseClaudeDesktopConfig(await readFile(configPath, "utf8"), configPath);
    configExists = true;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT")) {
      throw error;
    }
  }

  const servers =
    parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)
      ? (parsed.mcpServers as Record<string, unknown>)
      : {};
  const entry =
    servers[serverName] && typeof servers[serverName] === "object" && !Array.isArray(servers[serverName])
      ? (servers[serverName] as Record<string, unknown>)
      : undefined;

  const runtimeDir = typeof entry?.cwd === "string" ? entry.cwd : undefined;
  const entryArgs = Array.isArray(entry?.args) ? entry.args.filter((value) => typeof value === "string") as string[] : [];
  const runtimeEntry = entryArgs[0];

  return {
    configPath,
    serverName,
    configExists,
    installed: Boolean(entry),
    runtimeDir,
    entryCommand: typeof entry?.command === "string" ? entry.command : undefined,
    entryArgs,
    runtimeEntryExists: await pathExists(runtimeEntry),
    runtimeNodeModulesExists: await pathExists(runtimeDir ? resolve(runtimeDir, "node_modules") : undefined),
    hasEnvConfig: Boolean(entry?.env && typeof entry.env === "object" && !Array.isArray(entry.env)),
  };
}

export interface ClaudeDesktopHealth {
  status: ClaudeDesktopInstallStatus;
  ok: boolean;
  problems: string[];
  warnings: string[];
  runtimeVersion?: string;
  sourceVersion?: string;
}

async function readVersion(packageJsonPath: string): Promise<string | undefined> {
  try {
    const version = (JSON.parse(await readFile(packageJsonPath, "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Presence checks are not enough: a bumped Node, a half-installed runtime or a broken dist all
 * leave the files in place while Claude Desktop cannot start the server. Run what Claude Desktop
 * will run, with the configured command.
 */
export async function checkClaudeDesktopInstall(
  options: { configPath?: string; serverName?: string; sourceVersion?: string } = {},
): Promise<ClaudeDesktopHealth> {
  const status = await getClaudeDesktopInstallStatus(options);
  const problems: string[] = [];
  const warnings: string[] = [];
  const health: ClaudeDesktopHealth = { status, ok: false, problems, warnings };

  if (!status.configExists) {
    problems.push(`Claude Desktop config not found at ${status.configPath}. Run npm run setup:claude-desktop.`);
    return health;
  }
  if (!status.installed) {
    problems.push(`"${status.serverName}" is not registered in ${status.configPath}. Run npm run setup:claude-desktop.`);
    return health;
  }

  const { runtimeDir, entryCommand } = status;
  if (!runtimeDir) problems.push("The config entry has no cwd (runtime directory).");
  if (!status.runtimeEntryExists) problems.push("Runtime entry (args[0], dist/index.js) does not exist.");
  if (!status.runtimeNodeModulesExists) problems.push("Runtime dependencies (node_modules) are missing.");
  if (!entryCommand) problems.push("The config entry has no command.");

  let commandRuns = false;
  if (entryCommand) {
    try {
      await execFileAsync(entryCommand, ["--version"], { timeout: 10_000 });
      commandRuns = true;
    } catch (error) {
      problems.push(
        `Configured command "${entryCommand}" does not run (${error instanceof Error ? error.message.split("\n")[0] : String(error)}). Re-run npm run setup:claude-desktop.`,
      );
    }
    warnings.push(...nodeCommandWarnings(entryCommand));
  }

  if (runtimeDir) {
    health.runtimeVersion = await readVersion(join(runtimeDir, "package.json"));
    health.sourceVersion =
      options.sourceVersion ?? (await readVersion(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json")));
    if (!health.runtimeVersion) {
      problems.push(`Runtime package.json is missing or unreadable in ${runtimeDir}.`);
    } else if (health.sourceVersion && health.runtimeVersion !== health.sourceVersion) {
      problems.push(
        `Runtime is version ${health.runtimeVersion} but this package is ${health.sourceVersion}. Re-run npm run setup:claude-desktop to update it.`,
      );
    }
    if (commandRuns && health.runtimeVersion && status.runtimeEntryExists && status.runtimeNodeModulesExists) {
      try {
        await verifyRuntime(runtimeDir, entryCommand as string, health.runtimeVersion);
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  health.ok = problems.length === 0;
  return health;
}

function renderHealth(health: ClaudeDesktopHealth): string {
  const { status } = health;
  const lines = health.ok
    ? ["Claude Desktop install is healthy (command runs, better-sqlite3 loads, dist imports)."]
    : ["Claude Desktop install has problems:", ...health.problems.map((problem) => `  - ${problem}`)];
  if (health.warnings.length > 0) lines.push(...health.warnings.map((warning) => `Warning: ${warning}`));
  if (status.installed) {
    lines.push(
      `Config path: ${status.configPath}`,
      `Server key: ${status.serverName}`,
      `Runtime dir: ${status.runtimeDir || "unknown"}`,
      `Runtime version: ${health.runtimeVersion ?? "unknown"}${health.sourceVersion ? ` (package ${health.sourceVersion})` : ""}`,
      `Env config present: ${status.hasEnvConfig ? "yes" : "no"}`,
    );
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const health = await checkClaudeDesktopInstall(options);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderHealth(health)}\n`);
  }
  if (!health.ok) {
    process.exitCode = 1;
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
