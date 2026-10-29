import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditService } from "../dist/services/audit-service.js";

const cfg = (dataDir) => ({
  smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "o@example.com", password: "s" },
  imap: { host: "127.0.0.1", port: 1143, secure: false, username: "o@example.com", password: "s" },
  dataDir, debug: false,
});
async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "adv-audit-"));
  try { await fn(dir, join(dir, "audit.log")); } finally { await rm(dir, { recursive: true, force: true }); }
}
const rec = (s, i, extra = {}) => s.record({ timestamp: `2026-10-29T12:00:00.${String(i).padStart(3, "0")}Z`, tool: "t", status: "success", durationMs: i, input: { i }, ...extra });
const lines = async (p) => (await readFile(p, "utf8")).split("\n").filter(Boolean);

test("caller-supplied chain fields are ignored", async () => {
  await withDir(async (dir) => {
    const s = new AuditService(cfg(dir));
    await rec(s, 0, { seq: 99, prevHash: "x", hash: "y", chainStart: true });
    await rec(s, 1, { seq: 1, chainStart: true });
    const v = await s.verify();
    assert.equal(v.ok, true);
    assert.equal(v.checked, 2);
  });
});

test("__proto__ key in input still verifies", async () => {
  await withDir(async (dir) => {
    const s = new AuditService(cfg(dir));
    await s.record({ timestamp: "t", tool: "t", status: "success", input: JSON.parse('{"__proto__":{"a":1},"z":1}') });
    await rec(s, 1);
    assert.equal((await s.verify()).ok, true);
  });
});

test("DEFECT? crash mid-write (partial line, no newline) then next record", async () => {
  await withDir(async (dir, path) => {
    const s = new AuditService(cfg(dir));
    await rec(s, 0); await rec(s, 1);
    const l = await lines(path);
    await appendFile(path, l[1].slice(0, 40)); // partial line from a crashed writer, no trailing newline
    const s2 = new AuditService(cfg(dir)); // new process
    await rec(s2, 2);
    await rec(s2, 3);
    const v = await s2.verify();
    const all = await s2.list(100);
    // Expected: healed or at least not poisoning later entries. Observed: see assertion messages.
    assert.equal(v.ok, false, "partial line should be flagged");
    const survived = all.filter((e) => e.durationMs === 2 || e.durationMs === 3).length;
    assert.equal(survived, 2, `entries written after the crash must stay readable (survived ${survived}/2)`);
  });
});

test("tail truncation is undetected by design but headSeq reveals it", async () => {
  await withDir(async (dir, path) => {
    const s = new AuditService(cfg(dir));
    for (let i = 0; i < 5; i++) await rec(s, i);
    const l = await lines(path);
    await writeFile(path, l.slice(0, 3).join("\n") + "\n");
    const v = await s.verify();
    assert.equal(v.ok, true); // documents the limitation
    assert.equal(v.headSeq, 3);
  });
});

test("DEFECT? stripping chain fields from every line yields ok:true", async () => {
  await withDir(async (dir, path) => {
    const s = new AuditService(cfg(dir));
    for (let i = 0; i < 4; i++) await rec(s, i);
    const l = (await lines(path)).map((x) => { const o = JSON.parse(x); delete o.hash; delete o.seq; delete o.prevHash; delete o.chainStart; o.input = { forged: true }; return JSON.stringify(o); });
    await writeFile(path, l.join("\n") + "\n");
    const v = await s.verify();
    assert.equal(v.ok, false, `forged log verified ok (checked=${v.checked}, legacy=${v.legacyEntries})`);
  });
});

test("DEFECT? deleting audit.log entirely yields ok:true", async () => {
  await withDir(async (dir, path) => {
    const s = new AuditService(cfg(dir));
    for (let i = 0; i < 4; i++) await rec(s, i);
    await rm(path);
    const v = await s.verify();
    assert.equal(v.ok, false, `empty log verified ok (checked=${v.checked})`);
  });
});

test("duplicate, reorder, middle delete, edit are all caught", async () => {
  await withDir(async (dir, path) => {
    const s = new AuditService(cfg(dir));
    for (let i = 0; i < 6; i++) await rec(s, i);
    const orig = await lines(path);
    const cases = {
      dup: [...orig.slice(0, 3), orig[2], ...orig.slice(3)],
      swap: [orig[0], orig[2], orig[1], ...orig.slice(3)],
      del: [...orig.slice(0, 2), ...orig.slice(3)],
      delLast2Mid: [...orig.slice(0, 2), ...orig.slice(4)],
      edit: orig.map((x, i) => (i === 3 ? x.replace('"status":"success"', '"status":"error"') : x)),
      dupLast: [...orig, orig[5]],
      blankAndCRLF: [orig.join("\r\n"), ""], // benign
    };
    for (const [name, ls] of Object.entries(cases)) {
      await writeFile(path, ls.join("\n") + "\n");
      const v = await s.verify();
      assert.equal(v.ok, name === "blankAndCRLF", `${name}: ${JSON.stringify(v)}`);
    }
  });
});

test("truncated last line is flagged", async () => {
  await withDir(async (dir, path) => {
    const s = new AuditService(cfg(dir));
    for (let i = 0; i < 3; i++) await rec(s, i);
    const raw = await readFile(path, "utf8");
    await writeFile(path, raw.slice(0, raw.length - 30));
    assert.equal((await s.verify()).ok, false);
  });
});

test("three processes writing concurrently keep one linear chain", async () => {
  await withDir(async (dir) => {
    const code = `
      import { AuditService } from ${JSON.stringify(new URL("../dist/services/audit-service.js", import.meta.url).href)};
      const s = new AuditService(${JSON.stringify(cfg(dir))});
      for (let i = 0; i < 40; i++) await s.record({ timestamp: "t", tool: "p" + process.pid, status: "success", durationMs: i, input: { i } });
    `;
    await Promise.all([1, 2, 3].map(() => new Promise((res, rej) => {
      const c = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "inherit" });
      c.on("exit", (n) => (n === 0 ? res() : rej(new Error("exit " + n))));
    })));
    const v = await new AuditService(cfg(dir)).verify();
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(v.checked, 120);
  });
});

test("huge entries force rotation; chain stays verifiable across 4 rotations", async () => {
  await withDir(async (dir) => {
    const s = new AuditService(cfg(dir));
    const big = "x".repeat(3 * 1024 * 1024);
    for (let i = 0; i < 9; i++) await rec(s, i, { input: { big } });
    const v = await s.verify();
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(v.headSeq, 9);
  });
});

test("unicode separators / NUL / lone surrogate in fields round-trip", async () => {
  await withDir(async (dir) => {
    const s = new AuditService(cfg(dir));
    await rec(s, 0, { input: { a: "  \u0000\ud800\r\n", "k ": 1e21, n: -0, big: 2 ** 70 } });
    await rec(s, 1);
    assert.equal((await s.verify()).ok, true);
  });
});
