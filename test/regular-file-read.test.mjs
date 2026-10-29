import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuditService } from "../dist/services/audit-service.js";
import { CategoryService } from "../dist/services/category-service.js";
import { ContactService } from "../dist/services/contact-service.js";
import { EventLogService } from "../dist/services/event-log-service.js";
import { GrantService } from "../dist/services/grant-service.js";
import { readRegularFile } from "../dist/utils/regular-file.js";

const skip = process.platform === "win32";
const within = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`HANG: ${label}`)), ms).unref())]);
const withDir = async (fn) => {
  const dir = await mkdtemp(join(tmpdir(), "regfile-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
const fifo = (path) => execFileSync("mkfifo", [path]);
const config = (dataDir) => ({
  smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "secret" },
  imap: { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "secret" },
  dataDir,
  debug: false,
});
const entry = (i) => ({ timestamp: "2026-10-29T12:00:00.000Z", tool: "t", status: "success", durationMs: i, input: { i } });

test("readRegularFile: regular file, missing file, size cap, symlink to a regular file", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "a"), "hello");
    assert.equal(await readRegularFile(join(dir, "a")), "hello");
    assert.equal((await readRegularFile(join(dir, "a"), { binary: true })).length, 5);
    await assert.rejects(readRegularFile(join(dir, "none")), { code: "ENOENT" });
    await assert.rejects(readRegularFile(join(dir, "a"), { maxBytes: 3 }), { code: "EFBIG" });
    await symlink(join(dir, "a"), join(dir, "ok-link"));
    assert.equal(await readRegularFile(join(dir, "ok-link")), "hello");
  });
});

test("readRegularFile: FIFO, directory, dangling symlink and symlink to a FIFO are rejected (never ENOENT, never a hang)", { skip }, async () => {
  await withDir(async (dir) => {
    fifo(join(dir, "f"));
    await mkdir(join(dir, "d"));
    await symlink(join(dir, "missing"), join(dir, "dangling"));
    await symlink(join(dir, "f"), join(dir, "to-fifo"));
    for (const name of ["f", "d", "dangling", "to-fifo"]) {
      await assert.rejects(within(readRegularFile(join(dir, name)), 3000, name), (e) => e.code !== "ENOENT" && !/HANG/.test(e.message), name);
    }
  });
});

test("audit.head dangling symlink -> head-unreadable", { skip }, async () => {
  await withDir(async (dir) => {
    const s = new AuditService(config(dir));
    await s.record(entry(1));
    await rm(join(dir, "audit.head"));
    await symlink(join(dir, "nowhere"), join(dir, "audit.head"));
    const v = await s.verify();
    assert.equal(v.ok, false);
    assert.equal(v.reason, "head-unreadable");
  });
});

test("audit.head is a directory: the failed write leaves no audit.head.tmp", { skip }, async () => {
  await withDir(async (dir) => {
    const s = new AuditService(config(dir));
    await s.record(entry(1));
    await rm(join(dir, "audit.head"));
    await mkdir(join(dir, "audit.head"));
    await s.record(entry(2));
    await assert.rejects(readFile(join(dir, "audit.head.tmp")), { code: "ENOENT" });
  });
});

test("FIFO planted as audit.head does not hang verify or record", { skip }, async () => {
  await withDir(async (dir) => {
    const s = new AuditService(config(dir));
    await s.record(entry(1));
    await rm(join(dir, "audit.head"));
    fifo(join(dir, "audit.head"));
    const v = await within(s.verify(), 5000, "verify");
    assert.equal(v.ok, false);
    assert.equal(v.reason, "head-unreadable");
    await within(s.record(entry(2)), 5000, "record");
    await within(new AuditService(config(dir)).record(entry(3)), 5000, "record in a fresh process state");
  });
});

test("FIFO planted at a store path does not hang loading", { skip }, async () => {
  const cases = [
    ["grants.json", (d) => new GrantService(config(d), "owner@example.com").list()],
    ["contacts.json", (d) => new ContactService(config(d)).list()],
    ["categories.json", (d) => new CategoryService({ dataDir: d }).list()],
    ["events.jsonl", (d) => new EventLogService(config(d)).readAll()],
    ["events.1.jsonl", (d) => new EventLogService(config(d)).readAll()],
  ];
  for (const [file, load] of cases) {
    await withDir(async (dir) => {
      fifo(join(dir, file));
      // Rejecting is fine (the store is left alone); hanging is not.
      await within(Promise.resolve().then(() => load(dir)).catch(() => undefined), 5000, file);
    });
  }
});
