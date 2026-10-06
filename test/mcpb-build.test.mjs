import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MCPB_VERSION,
  SUPPORTED_TARGETS,
  bundleFileName,
  parseTarget,
  resolveTargets,
  stampManifest,
} from "../scripts/mcpb-lib.mjs";

const root = new URL("..", import.meta.url).pathname;
const read = (path) => readFileSync(join(root, path), "utf8");

test("resolveTargets defaults to the host and accepts a list", () => {
  assert.deepEqual(resolveTargets([], { platform: "darwin", arch: "arm64" }).map((t) => t.target), ["darwin-arm64"]);
  assert.deepEqual(
    resolveTargets(["--targets", "darwin-arm64,darwin-x64,darwin-x64"], { platform: "linux", arch: "x64" }),
    [parseTarget("darwin-arm64"), parseTarget("darwin-x64")],
  );
  assert.throws(() => resolveTargets(["--targets", "sunos-sparc"], { platform: "linux", arch: "x64" }), /Unsupported target/);
  assert.throws(() => resolveTargets(["--targets"], { platform: "linux", arch: "x64" }), /requires/);
});

test("stampManifest sets version and one platform without mutating the source", () => {
  const source = { version: "0.0.0", compatibility: { claude_desktop: ">=0.10.0", platforms: ["darwin", "win32"] } };
  const stamped = stampManifest(source, "2.3.2", "linux");
  assert.equal(stamped.version, "2.3.2");
  assert.deepEqual(stamped.compatibility.platforms, ["linux"]);
  assert.equal(stamped.compatibility.claude_desktop, ">=0.10.0");
  assert.deepEqual(source.compatibility.platforms, ["darwin", "win32"]);
  assert.deepEqual(stampManifest({}, "1.0.0", "win32").compatibility, { platforms: ["win32"] });
});

test("bundle file names are per platform and arch", () => {
  assert.equal(bundleFileName(parseTarget("linux-arm64")), "proton-mail-bridge-client-linux-arm64.mcpb");
});

test("better-sqlite3 ships a prebuild for every supported target", (t) => {
  const dir = join(root, "node_modules", "better-sqlite3", "prebuilds");
  if (!existsSync(dir)) return t.skip("better-sqlite3 not installed");
  for (const target of SUPPORTED_TARGETS) assert.ok(existsSync(join(dir, `${target}.node`)), `${target}.node`);
});

test("the release workflow builds every supported target on existing runner types", () => {
  const workflow = read(".github/workflows/mcpb-release.yml");
  const listed = [...workflow.matchAll(/targets: ([a-z0-9,-]+)/g)].flatMap((m) => m[1].split(","));
  assert.deepEqual([...listed].sort(), [...SUPPORTED_TARGETS].sort());
  for (const runner of [...workflow.matchAll(/- os: ([a-z0-9-]+)/g)].map((m) => m[1])) {
    assert.ok(["macos-latest", "ubuntu-latest", "windows-latest"].includes(runner), runner);
  }
});

test("@anthropic-ai/mcpb is pinned to an exact version", () => {
  assert.match(MCPB_VERSION, /^\d+\.\d+\.\d+$/);
  const build = read("scripts/build-mcpb.mjs");
  assert.ok(!/@anthropic-ai\/mcpb["'\s]/.test(build), "no unpinned reference in the build script");
  assert.ok(build.includes("MCPB_VERSION"));
});
