import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuditService } from "../dist/services/audit-service.js";

const config = (dataDir) => ({
  smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "secret" },
  imap: { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "secret" },
  dataDir,
  debug: false,
});
const withDir = async (fn) => {
  const dir = await mkdtemp(join(tmpdir(), "audit-head-"));
  try {
    await fn(dir);
  } finally {
    await chmod(join(dir, "audit.head"), 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
};
const record = (service, i) => service.record({ timestamp: "2026-10-29T12:00:00.000Z", tool: "t", status: "success", durationMs: i, input: { i } });
const entries = async (dir) => (await readFile(join(dir, "audit.log"), "utf8")).split("\n").filter(Boolean);

test("an audit.head that cannot be read is reported, and record() keeps auditing", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  await withDir(async (dir) => {
    const service = new AuditService(config(dir));
    await record(service, 0);
    await chmod(join(dir, "audit.head"), 0o000);
    const verdict = await service.verify();
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "head-unreadable");
    await record(service, 1);
    await record(service, 2);
    assert.equal((await entries(dir)).length, 3, "the log kept growing");
  });
});

test("a directory in place of audit.head is reported, and record() keeps auditing", async () => {
  await withDir(async (dir) => {
    const service = new AuditService(config(dir));
    await record(service, 0);
    await rm(join(dir, "audit.head"));
    await mkdir(join(dir, "audit.head"));
    await writeFile(join(dir, "audit.head", "keep"), "x");
    const verdict = await service.verify();
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "head-unreadable");
    await record(service, 1);
    await record(service, 2);
    assert.equal((await entries(dir)).length, 3);
    assert.equal((await service.verify()).reason, "head-unreadable", "still reported while the head cannot be repaired");
  });
});

test("an unreadable audit.head that can be replaced is repaired by the next record", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  await withDir(async (dir) => {
    const service = new AuditService(config(dir));
    await record(service, 0);
    await chmod(join(dir, "audit.head"), 0o000);
    await record(service, 1);
    const verdict = await service.verify();
    assert.equal(verdict.ok, true, verdict.detail);
    assert.equal(verdict.headSeq, 2);
  });
});
