#!/usr/bin/env node
// Packaging smoke test: does the package that would be published actually work for a user?
//
// Packs the project, installs the tarball into an empty project the way `npm install` would (production
// dependencies only), then starts the installed server over stdio and talks MCP to it, and runs the
// installed CLI. Nothing here uses the repo's own node_modules for the package under test, so a
// dependency that is missing from "dependencies" (the 2.2.0 release: better-sqlite3 had been moved to
// devDependencies, the repo still had it installed, every test passed, and the published package did not
// start) fails here.
//
// Needs `npm run build` to have run. No Proton Bridge and no credentials: the server starts with dummy
// settings, read-only, with background work off, and only tools that touch local state are called.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const MIN_TOOLS = 80;
const REQUIRED_TOOLS = ["send_email", "search_emails", "search_indexed_emails", "get_index_status", "run_doctor"];
const tmp = mkdtempSync(join(tmpdir(), "pack-smoke-"));

function cleanup() {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function fail(message) {
  console.error(`pack-smoke FAILED: ${message}`);
  cleanup();
  process.exit(1);
}

function run(command, args, cwd) {
  try {
    // npm.cmd cannot be spawned without a shell on Windows; node itself can (and its path may contain spaces).
    return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: command.endsWith(".cmd") });
  } catch (error) {
    fail(`\`${command} ${args.join(" ")}\` exited ${error.status}\n${error.stdout ?? ""}${error.stderr ?? ""}`);
  }
}

async function main() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (!existsSync(join(root, "dist", "index.js"))) fail("dist/ is missing, run `npm run build` first");

  const packDir = join(tmp, "pack");
  const project = join(tmp, "project");
  mkdirSync(packDir);
  mkdirSync(project);

  run(npm, ["pack", "--pack-destination", packDir], root);
  const tarball = readdirSync(packDir).find((name) => name.endsWith(".tgz"));
  if (!tarball) fail("npm pack produced no tarball");

  run(npm, ["init", "-y"], project);
  // Production dependencies only, scripts enabled: what `npm install proton-mail-bridge-client` does.
  run(npm, ["install", "--omit=dev", "--no-audit", "--no-fund", join(packDir, tarball)], project);

  const installed = join(project, "node_modules", pkg.name);
  const installedPkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  if (installedPkg.version !== pkg.version) fail(`installed ${installedPkg.version}, expected ${pkg.version}`);

  for (const [name, file] of Object.entries(installedPkg.bin ?? {})) {
    if (!existsSync(join(installed, file))) fail(`bin "${name}" points at ${file}, which is not in the package`);
  }

  // Every runtime dependency must be present in the install (a regression guard for the 2.2.0 class).
  for (const dependency of Object.keys(installedPkg.dependencies ?? {})) {
    if (!existsSync(join(project, "node_modules", dependency, "package.json"))) fail(`dependency ${dependency} was not installed`);
  }

  // The installed CLI runs and reports its own version.
  const cliVersion = run(process.execPath, [join(installed, installedPkg.bin["proton-mail-bridge-client"]), "--version"], project).trim();
  if (!cliVersion.includes(pkg.version)) fail(`CLI --version printed "${cliVersion}", expected it to contain ${pkg.version}`);

  // The installed server starts and answers MCP over stdio.
  const dataDir = join(tmp, "data");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(installed, installedPkg.bin["proton-mail-bridge-mcp"])],
    cwd: project,
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? tmp,
      USERPROFILE: process.env.USERPROFILE ?? tmp,
      SystemRoot: process.env.SystemRoot ?? "",
      PROTONMAIL_USERNAME: "smoke@example.com",
      PROTONMAIL_PASSWORD: "not-a-real-password",
      PROTONMAIL_IMAP_HOST: "127.0.0.1",
      PROTONMAIL_IMAP_PORT: "9",
      PROTONMAIL_SMTP_HOST: "127.0.0.1",
      PROTONMAIL_SMTP_PORT: "9",
      PROTONMAIL_DATA_DIR: dataDir,
      PROTONMAIL_READ_ONLY: "true",
      PROTONMAIL_AUTO_SYNC: "false",
      PROTONMAIL_IDLE_WATCH: "false",
      PROTONMAIL_STARTUP_SYNC: "false",
    },
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk; });
  const client = new Client({ name: "pack-smoke", version: "0.0.0" });
  const timer = setTimeout(() => fail(`timed out talking to the installed server\n${stderr}`), 60_000);
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    if (tools.length < MIN_TOOLS) fail(`only ${tools.length} tools listed, expected at least ${MIN_TOOLS}`);
    const names = new Set(tools.map((tool) => tool.name));
    for (const required of REQUIRED_TOOLS) if (!names.has(required)) fail(`tool ${required} is missing`);

    // A tool that opens the local SQLite index: this loads the native better-sqlite3 binding.
    const status = await client.callTool({ name: "get_index_status", arguments: {} });
    if (status.isError) fail(`get_index_status failed: ${JSON.stringify(status.content)}`);
    const text = status.content.find((part) => part.type === "text")?.text ?? "";
    if (!text.includes("mail-index.sqlite")) fail(`get_index_status did not report the index path: ${text.slice(0, 200)}`);

    console.log(`pack-smoke OK: ${pkg.name}@${pkg.version} installed from the tarball, ${tools.length} tools, local index opens, CLI runs`);
  } catch (error) {
    fail(`${error instanceof Error ? error.stack : String(error)}\n${stderr}`);
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
  cleanup();
}

main().catch((error) => fail(error instanceof Error ? error.stack : String(error)));
