import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolResultExitCode } from "../dist/cli.js";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;

function runCli(args, dir) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      PROTONMAIL_USERNAME: "user@example.com",
      PROTONMAIL_PASSWORD: "dummy",
      PROTONMAIL_IMAP_PORT: "9",
      PROTONMAIL_SMTP_PORT: "9",
      PROTONMAIL_DATA_DIR: dir,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("health commands exit 1 when Bridge is unreachable, with their JSON unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pmbc-cli-exit-"));
  try {
    const doctor = runCli(["doctor", "--json"], dir);
    assert.equal(doctor.code, 1);
    assert.equal(JSON.parse(doctor.stdout).ok, false);

    const connection = runCli(["connection-status", "--json"], dir);
    assert.equal(connection.code, 1);
    assert.equal(JSON.parse(connection.stdout).imap.ok, false);

    for (const args of [["tool", "get_connection_status"], ["get-connection-status"], ["run-doctor"]]) {
      const result = runCli([...args, "--json"], dir);
      assert.equal(result.code, 1, args.join(" "));
      assert.equal(JSON.parse(result.stdout).structuredContent.imap.ok, false);
    }

    // Commands where a partial/empty result is normal keep exiting 0.
    assert.equal(runCli(["runtime-status", "--json"], dir).code, 0);
    assert.equal(runCli(["status", "--json"], dir).code, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("toolResultExitCode: failed items, error results and failed health checks are non-zero", () => {
  const ok = (structuredContent) => ({ structuredContent });
  assert.equal(toolResultExitCode("batch_email_action", ok({ total: 3, succeeded: 3, failed: 0 })), 0);
  assert.equal(toolResultExitCode("batch_email_action", ok({ total: 3, succeeded: 2, failed: 1 })), 1);
  assert.equal(toolResultExitCode("bulk_delete", ok({ total: 2, succeeded: 0, failed: 2 })), 1);
  assert.equal(toolResultExitCode("bulk_delete", ok({ dryRun: true, total: 2, succeeded: 2, failed: 0 })), 0);
  assert.equal(toolResultExitCode("anything", { isError: true, content: [] }), 1);
  assert.equal(toolResultExitCode("get_connection_status", ok({ smtp: { ok: true }, imap: { ok: false } })), 1);
  assert.equal(toolResultExitCode("get_connection_status", ok({ smtp: { ok: true }, imap: { ok: true } })), 0);
  assert.equal(toolResultExitCode("run_doctor", ok({ smtp: { ok: false }, imap: { ok: true } })), 1);
  assert.equal(toolResultExitCode("get_folders", ok({ folders: [] })), 0);
  assert.equal(toolResultExitCode("get_logs", {}), 0);
});
