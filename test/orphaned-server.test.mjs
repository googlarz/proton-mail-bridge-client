import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER = new URL("../dist/index.js", import.meta.url).pathname;

// Stands in for an MCP client: starts the server on stdio pipes and reports its pid once the server is ready.
const CLIENT = `
import { spawn } from "node:child_process";
const server = spawn(process.execPath, [${JSON.stringify(SERVER)}], { stdio: ["pipe", "pipe", "pipe"] });
server.stdout.resume();
server.stderr.on("data", (chunk) => {
  if (chunk.toString().includes("ProtonMail MCP server ready")) process.send(server.pid);
});
setInterval(() => {}, 1000);
`;

const isRunning = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("the server exits when its client is killed, instead of being left running on dead stdio pipes", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "orphaned-server-"));
  const client = spawn(process.execPath, ["--input-type=module", "-e", CLIENT], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    env: {
      PATH: process.env.PATH,
      HOME: home,
      PROTONMAIL_USERNAME: "test@example.invalid",
      PROTONMAIL_PASSWORD: "test",
      PROTONMAIL_DATA_DIR: join(home, "data"),
      PROTONMAIL_IMAP_PORT: "1",
      PROTONMAIL_SMTP_PORT: "1",
      PROTONMAIL_AUTO_SYNC: "false",
    },
  });
  const serverPid = await new Promise((resolve) => client.once("message", resolve));
  t.after(() => {
    if (isRunning(serverPid)) process.kill(serverPid, "SIGKILL");
    rmSync(home, { recursive: true, force: true });
  });

  client.kill("SIGKILL");

  const deadline = Date.now() + 10_000;
  while (isRunning(serverPid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.equal(isRunning(serverPid), false, "server still running 10 s after its client was killed");
});
