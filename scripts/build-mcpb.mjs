#!/usr/bin/env node
// Assembles a Claude Desktop .mcpb bundle for the current platform and packs it.
//
// MCPB bundles are fully self-contained (no install step at extension-install
// time), so this must include production node_modules — including
// better-sqlite3's native binding, which is platform/arch-specific. Run this
// on each target platform (or via the mcpb-release CI matrix) to produce a
// bundle that actually works there. better-sqlite3 ships prebuilds for all
// supported platforms inside the package, so one staging dir can also be stamped
// for sibling targets: pass `--targets darwin-arm64,darwin-x64` (default: this host).
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MCPB_VERSION, bundleFileName, resolveTargets, stampManifest } from "./mcpb-lib.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const targets = resolveTargets(process.argv.slice(2), { platform: process.platform, arch: process.arch });
// On Windows, npm/npx resolve to .cmd shims — execFileSync needs shell:true
// there to find them at all (fails with ENOENT otherwise).
const isWindows = process.platform === "win32";
function run(command, args, options) {
  execFileSync(command, args, { ...options, shell: isWindows });
}

console.log(`Building .mcpb bundle for ${targets.map((t) => t.target).join(", ")} (v${pkg.version})...`);

run("npm", ["run", "build"], { cwd: root, stdio: "inherit" });

const staging = mkdtempSync(join(tmpdir(), "proton-mcpb-"));
const serverDir = join(staging, "server");

try {
  // npm ci doesn't support --prefix the way you'd expect (it still reads
  // package.json/package-lock.json from cwd, not the prefix dir) — stage a
  // copy instead and run npm ci with cwd pointed at it. Strip "prepare" so
  // this doesn't try to run our own build (tsc is a devDependency, omitted
  // here) — dist/ is copied in separately below from the real build.
  const stagedPkg = { ...pkg };
  delete stagedPkg.scripts?.prepare;
  writeFileSync(join(staging, "package.json"), JSON.stringify(stagedPkg, null, 2));
  cpSync(join(root, "package-lock.json"), join(staging, "package-lock.json"));
  run("npm", ["ci", "--omit=dev"], { cwd: staging, stdio: "inherit" });
  cpSync(join(root, "dist"), serverDir, { recursive: true });

  const manifest = JSON.parse(readFileSync(join(root, "mcpb", "manifest.json"), "utf8"));
  for (const target of targets) {
    writeFileSync(
      join(staging, "manifest.json"),
      JSON.stringify(stampManifest(manifest, pkg.version, target.platform), null, 2),
    );

    const outFile = join(root, bundleFileName(target));
    run("npx", ["--yes", `@anthropic-ai/mcpb@${MCPB_VERSION}`, "pack", staging, outFile], {
      cwd: root,
      stdio: "inherit",
    });

    console.log(`Built ${outFile}`);
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}
