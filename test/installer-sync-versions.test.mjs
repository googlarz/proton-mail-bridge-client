import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });

test("sync-versions stages the files it changes so `npm version` commits them", () => {
  const repo = mkdtempSync(join(tmpdir(), "sync-versions-"));
  mkdirSync(join(repo, "scripts"));
  mkdirSync(join(repo, "mcpb"));
  cpSync(new URL("../scripts/sync-versions.mjs", import.meta.url), join(repo, "scripts", "sync-versions.mjs"));
  writeFileSync(join(repo, "package.json"), '{"version":"2.0.0"}\n');
  writeFileSync(join(repo, "mcpb", "manifest.json"), '{\n  "version": "1.0.0"\n}\n');
  writeFileSync(join(repo, "server.json"), '{\n  "version": "1.0.0",\n  "packages": [{ "version": "1.0.0" }]\n}\n');
  git(repo, "init", "-q");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");

  execFileSync(process.execPath, ["scripts/sync-versions.mjs"], { cwd: repo });

  assert.deepEqual(git(repo, "diff", "--cached", "--name-only").trim().split("\n").sort(), ["mcpb/manifest.json", "server.json"]);
  assert.equal(git(repo, "diff", "--name-only").trim(), "", "nothing left unstaged");
});

test("sync-versions still works outside a git checkout", () => {
  const dir = mkdtempSync(join(tmpdir(), "sync-versions-nogit-"));
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "mcpb"));
  cpSync(new URL("../scripts/sync-versions.mjs", import.meta.url), join(dir, "scripts", "sync-versions.mjs"));
  writeFileSync(join(dir, "package.json"), '{"version":"2.0.0"}\n');
  writeFileSync(join(dir, "mcpb", "manifest.json"), '{"version":"1.0.0"}\n');
  writeFileSync(join(dir, "server.json"), '{"version":"1.0.0"}\n');
  execFileSync(process.execPath, ["scripts/sync-versions.mjs"], { cwd: dir, stdio: "ignore" });
});
