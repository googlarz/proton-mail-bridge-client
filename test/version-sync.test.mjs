import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

// mcpb/manifest.json and server.json (published as-is to the MCP registry) are checked in with their
// own copy of the version; they sat at 1.19.5 through 2.1.43. `npm version` now runs
// scripts/sync-versions.mjs, and this fails the build if anyone bypasses it.
test("mcpb/manifest.json and server.json carry the package.json version", () => {
  const { version } = read("package.json");
  assert.equal(read("mcpb/manifest.json").version, version, "mcpb/manifest.json");
  const server = read("server.json");
  assert.equal(server.version, version, "server.json version");
  for (const entry of server.packages) assert.equal(entry.version, version, `server.json package ${entry.identifier}`);
});

test("the npm version lifecycle runs the sync script", () => {
  assert.equal(read("package.json").scripts.version, "node scripts/sync-versions.mjs");
});
