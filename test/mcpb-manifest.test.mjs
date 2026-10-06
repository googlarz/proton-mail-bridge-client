import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "mcpb", "manifest.json"), "utf8"));
const env = manifest.server.mcp_config.env;
const userConfig = manifest.user_config;

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "scripts" ? [] : sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}
const serverVars = new Set(
  sourceFiles(join(root, "src")).flatMap((file) => readFileSync(file, "utf8").match(/\bPROTONMAIL_[A-Z0-9_]+\b/g) ?? []),
);

// Types in the MCPB manifest spec (anthropics/mcpb MANIFEST.md, "User Configuration").
const SPEC_TYPES = new Set(["string", "number", "boolean", "directory", "file"]);

test("every env var the manifest wires is one the server reads", () => {
  for (const name of Object.keys(env)) {
    assert.ok(serverVars.has(name), `${name} is wired in the manifest but never referenced in src/`);
  }
});

test("every user_config key is wired into the server env, and every ${user_config.x} exists", () => {
  const referenced = Object.values(env).flatMap((value) => [...value.matchAll(/\$\{user_config\.([a-z_]+)\}/g)].map((m) => m[1]));
  assert.deepEqual([...new Set(referenced)].sort(), Object.keys(userConfig).sort());
});

test("user_config entries have the required fields and spec types", () => {
  for (const [key, spec] of Object.entries(userConfig)) {
    assert.ok(SPEC_TYPES.has(spec.type), `${key}: type ${spec.type}`);
    assert.ok(spec.title && spec.description, `${key}: title and description`);
    if (spec.sensitive) assert.equal(spec.type, "string", `${key}: sensitive is for strings`);
  }
  assert.equal(userConfig.protonmail_username.required, true);
  assert.equal(userConfig.protonmail_password.required, true);
  assert.equal(userConfig.protonmail_password.sensitive, true);
  assert.equal(userConfig.accounts_json.sensitive, true);
});

test("the new settings are exposed", () => {
  for (const name of [
    "PROTONMAIL_IMAP_HOST", "PROTONMAIL_IMAP_PORT", "PROTONMAIL_SMTP_HOST", "PROTONMAIL_SMTP_PORT",
    "PROTONMAIL_READ_ONLY", "PROTONMAIL_ALLOW_SEND", "PROTONMAIL_SIGNATURE", "PROTONMAIL_ACCOUNTS_JSON",
    "PROTONMAIL_DATA_DIR", "PROTONMAIL_ALLOW_FILE_DOWNLOAD_DIR", "PROTONMAIL_TOOL_TIER",
  ]) assert.ok(name in env, name);
  assert.equal(userConfig.download_dir.type, "directory");
  assert.equal(userConfig.data_dir.type, "directory");
});

test("defaults reproduce the behaviour of an untouched install", () => {
  assert.equal(userConfig.imap_host.default, "127.0.0.1");
  assert.equal(userConfig.imap_port.default, 1143);
  assert.equal(userConfig.smtp_host.default, "127.0.0.1");
  assert.equal(userConfig.smtp_port.default, 1025);
  assert.equal(userConfig.read_only.default, false);
  assert.equal(userConfig.allow_send.default, true);
  assert.equal(userConfig.tool_tier.default, "full");
  assert.equal(userConfig.data_dir.default, "${HOME}/.proton-mail-bridge-client");
  for (const key of ["signature", "accounts_json", "download_dir"]) {
    assert.equal(userConfig[key].default, undefined, `${key} must default to unset`);
    assert.notEqual(userConfig[key].required, true);
  }
});
