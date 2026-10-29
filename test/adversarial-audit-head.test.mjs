import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
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
  const dir = await mkdtemp(join(tmpdir(), "adv-audit-"));
  try {
    await fn(dir);
  } finally {
    await chmod(join(dir, "audit.head"), 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
};
const rec = (s, i) => s.record({ timestamp: "2026-10-29T12:00:00.000Z", tool: "t", status: "success", durationMs: i, input: { i } });
const lines = async (dir) => (await readFile(join(dir, "audit.log"), "utf8")).split("\n").filter(Boolean);
const within = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`HANG: ${label}`)), ms))]);

const variants = {
  directory: async (head) => { await unlink(head); await mkdir(head); },
  "symlink to /dev/null": async (head) => { await unlink(head); await symlink("/dev/null", head); },
  "symlink loop": async (head) => { await unlink(head); await symlink(head, head); },
  empty: async (head) => { await writeFile(head, ""); },
  garbage: async (head) => { await writeFile(head, "\u0000\u0001garbage{{{"); },
  "json null": async (head) => { await writeFile(head, "null\n"); },
  "huge garbage 20MB": async (head) => { await writeFile(head, "x".repeat(20 * 1024 * 1024)); },
  chmod000: async (head) => { await chmod(head, 0o000); },
};

for (const [name, mutate] of Object.entries(variants)) {
  test(`audit.head = ${name}: verify reports ok:false, record still appends, no hang`, { skip: process.platform === "win32" || (name === "chmod000" && process.getuid?.() === 0), timeout: 30000 }, async () => {
    await withDir(async (dir) => {
      const s = new AuditService(config(dir));
      for (let i = 0; i < 3; i++) await rec(s, i);
      await mutate(join(dir, "audit.head"));
      const v = await within(s.verify(), 8000, "verify");
      console.log(name, "->", JSON.stringify({ ok: v.ok, reason: v.reason }));
      assert.equal(v.ok, false, "must not report ok");
      const before = (await lines(dir)).length;
      await within(rec(s, 99), 8000, "record");
      await within(rec(s, 100), 8000, "record2");
      assert.equal((await lines(dir)).length, before + 2, "entries appended");
      const v2 = await within(new AuditService(config(dir)).verify(), 8000, "verify fresh process");
      console.log(name, "fresh-process verify after two records ->", JSON.stringify({ ok: v2.ok, reason: v2.reason }));
    });
  });
}

// A FIFO in place of audit.head must not hang (readFile on one blocks a thread forever); fixed by readRegularFile.
test("audit.head = FIFO must not hang verify or record", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  await withDir(async (dir) => {
    const s = new AuditService(config(dir));
    await rec(s, 0);
    await unlink(join(dir, "audit.head"));
    execFileSync("mkfifo", [join(dir, "audit.head")]);
    const v = await within(s.verify(), 5000, "verify on FIFO");
    assert.equal(v.ok, false);
    await within(rec(s, 1), 5000, "record on FIFO");
  });
});

test("unreadable head -> reason is head-unreadable (chmod 000 and directory)", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  await withDir(async (dir) => {
    const s = new AuditService(config(dir));
    await rec(s, 0);
    await chmod(join(dir, "audit.head"), 0o000);
    assert.equal((await s.verify()).reason, "head-unreadable");
    await chmod(join(dir, "audit.head"), 0o600);
    // repaired: head readable again but behind/ahead -> verify must recover on next record, not loop
    await rec(s, 1);
    const v = await s.verify();
    console.log("after chmod restore + record:", JSON.stringify({ ok: v.ok, reason: v.reason }));
  });
});

test("restoring the head after unreadable: chain eventually verifies ok (no permanent break)", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  await withDir(async (dir) => {
    const s = new AuditService(config(dir));
    await rec(s, 0);
    const head = join(dir, "audit.head");
    await unlink(head);
    await mkdir(head);
    await rec(s, 1);
    await rec(s, 2);
    await rm(head, { recursive: true });
    await rec(s, 3);
    const v = await new AuditService(config(dir)).verify();
    console.log("after dir removed + record:", JSON.stringify({ ok: v.ok, reason: v.reason }));
    assert.equal(v.ok, true);
  });
});

test("concurrent processes recording while head is unreadable: no lost entries, no fork", { skip: process.platform === "win32" || process.getuid?.() === 0, timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    const s = new AuditService(config(dir));
    await rec(s, 0);
    await chmod(join(dir, "audit.head"), 0o000);
    const child = `
      import { AuditService } from ${JSON.stringify(new URL("../dist/services/audit-service.js", import.meta.url).href)};
      const cfg = ${JSON.stringify(config(dir))};
      const s = new AuditService(cfg);
      for (let i = 0; i < 25; i++) await s.record({ timestamp: "2026-10-29T12:00:00.000Z", tool: "t", status: "success", durationMs: i, input: { i } });
    `;
    const run = () => new Promise((res, rej) => { const p = spawn(process.execPath, ["--input-type=module", "-e", child], { stdio: "inherit" }); p.on("exit", (c) => (c === 0 ? res() : rej(new Error("exit " + c)))); });
    await Promise.all([run(), run(), run()]);
    const all = (await lines(dir)).map((l) => JSON.parse(l));
    assert.equal(all.length, 76);
    const seqs = all.map((e) => e.seq);
    assert.equal(new Set(seqs).size, seqs.length, "forked chain: duplicate seq");
    const v = await new AuditService(config(dir)).verify();
    assert.equal(v.ok, true, "the last writer's head replaced the unreadable one");
  });
});
