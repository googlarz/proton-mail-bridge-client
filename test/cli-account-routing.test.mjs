import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slugifyAccountAddress } from "../dist/utils/helpers.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

// A listener that only counts connections: whichever IMAP port the CLI dials tells us
// which account the command was routed to, without needing an IMAP implementation.
function listener() {
  return new Promise((resolve) => {
    const state = { connections: 0 };
    const server = createServer((socket) => { state.connections += 1; socket.destroy(); });
    server.listen(0, "127.0.0.1", () => resolve({ state, port: server.address().port, close: () => new Promise((done) => server.close(done)) }));
  });
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const SHORTCUTS = (id) => [
  ["move", id, "Trash"],
  ["archive", id],
  ["trash", id],
  ["restore", id],
  ["mark-read", id],
  ["star", id],
  ["delete", id, "--confirmed"],
  ["read", id],
  ["attachments", id],
];

test("single-message CLI shortcuts route a <slug>:: id to that account, like the MCP handlers", async () => {
  const primary = await listener();
  const secondary = await listener();
  const dir = await mkdtemp(join(tmpdir(), "pmbc-cli-routing-"));
  const slug = slugifyAccountAddress("work@example.com");
  const env = {
    ...process.env,
    PROTONMAIL_USERNAME: "user@example.com",
    PROTONMAIL_PASSWORD: "dummy",
    PROTONMAIL_IMAP_PORT: String(primary.port),
    PROTONMAIL_SMTP_PORT: "9",
    PROTONMAIL_DATA_DIR: dir,
    // The server opens an IDLE connection per account at startup unless told not to, which
    // would make both listeners look "touched" for every command.
    PROTONMAIL_IDLE_WATCH: "false",
    PROTONMAIL_AUTO_SYNC: "false",
    PROTONMAIL_ACCOUNTS_JSON: JSON.stringify([
      { address: "work@example.com", password: "dummy", imapPort: secondary.port, smtpPort: 9 },
    ]),
  };
  try {
    for (const args of SHORTCUTS(`${slug}::INBOX::1`)) {
      primary.state.connections = 0;
      secondary.state.connections = 0;
      const result = await runCli(args, env);
      assert.equal(result.code, 1, `${args[0]} should fail (no Bridge): ${result.stderr}`);
      assert.equal(primary.state.connections, 0, `${args[0]} must not touch the primary account for a ${slug}:: id`);
      assert.ok(secondary.state.connections > 0, `${args[0]} must reach the ${slug} account`);
    }
    // Control: an unprefixed id still means the primary account.
    for (const args of SHORTCUTS("INBOX::1")) {
      primary.state.connections = 0;
      secondary.state.connections = 0;
      await runCli(args, env);
      assert.ok(primary.state.connections > 0, `${args[0]} with a plain id must reach the primary account`);
      assert.equal(secondary.state.connections, 0, `${args[0]} with a plain id must not reach ${slug}`);
    }
  } finally {
    await Promise.all([primary.close(), secondary.close(), rm(dir, { recursive: true, force: true })]);
  }
});

test("runtime policy still gates the shortcuts after routing through the tool handlers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pmbc-cli-policy-"));
  const env = {
    ...process.env,
    PROTONMAIL_USERNAME: "user@example.com",
    PROTONMAIL_PASSWORD: "dummy",
    PROTONMAIL_IMAP_PORT: "9",
    PROTONMAIL_SMTP_PORT: "9",
    PROTONMAIL_DATA_DIR: dir,
    PROTONMAIL_ALLOWED_ACTIONS: "archive",
    PROTONMAIL_CONFIRM_DESTRUCTIVE: "true",
  };
  try {
    for (const args of [["move", "INBOX::1", "Trash"], ["trash", "INBOX::1"], ["delete", "INBOX::1", "--confirmed"]]) {
      const result = await runCli(args, env);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /disabled by the current runtime policy/, args[0]);
    }
    const unconfirmed = await runCli(["delete", "INBOX::1"], { ...env, PROTONMAIL_ALLOWED_ACTIONS: "delete" });
    assert.equal(unconfirmed.code, 1);
    assert.match(unconfirmed.stderr, /confirm/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
