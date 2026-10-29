import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditService } from "../dist/services/audit-service.js";

function createConfig(dataDir) {
  return {
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "secret" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "secret" },
    dataDir,
    debug: false,
  };
}

async function withDataDir(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-audit-chain-"));
  try {
    await fn(dataDir, join(dataDir, "audit.log"));
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function recordMany(service, count, tool = "move_email") {
  for (let i = 0; i < count; i++) {
    await service.record({ timestamp: `2026-10-29T12:00:0${i}.000Z`, tool, status: "success", durationMs: i, input: { emailId: `INBOX::${i}` } });
  }
}

async function readLines(path) {
  return (await readFile(path, "utf8")).split("\n").filter(Boolean);
}

async function writeLines(path, lines) {
  await writeFile(path, lines.length ? `${lines.join("\n")}\n` : "");
}

test("a fresh log forms a valid chain and verify returns its head hash", async () => {
  await withDataDir(async (dataDir, logPath) => {
    const service = new AuditService(createConfig(dataDir));
    // Chain fields supplied by a caller are ignored.
    await service.record({ timestamp: "2026-10-29T12:00:00.000Z", tool: "send_email", status: "success", seq: 99, hash: "x", prevHash: "y" });
    await recordMany(service, 3);

    const entries = (await readLines(logPath)).map((line) => JSON.parse(line));
    assert.deepEqual(entries.map((entry) => entry.seq), [1, 2, 3, 4]);
    assert.equal(entries[0].chainStart, true);
    assert.equal(entries[0].prevHash, "0".repeat(64));
    assert.equal(entries.filter((entry) => entry.chainStart).length, 1);
    for (let i = 1; i < entries.length; i++) assert.equal(entries[i].prevHash, entries[i - 1].hash);

    const result = await new AuditService(createConfig(dataDir)).verify();
    assert.equal(result.ok, true);
    assert.equal(result.checked, 4);
    assert.equal(result.legacyEntries, 0);
    assert.equal(result.headSeq, 4);
    assert.equal(result.headHash, entries[3].hash);
    assert.match(result.headHash, /^[0-9a-f]{64}$/);
  });
});

test("an empty log verifies with no head", async () => {
  await withDataDir(async (dataDir) => {
    const result = await new AuditService(createConfig(dataDir)).verify();
    assert.deepEqual(result, { ok: true, checked: 0, legacyEntries: 0, headSeq: null, headHash: null });
  });
});

test("an edited entry is reported as edited at its seq", async () => {
  await withDataDir(async (dataDir, logPath) => {
    const service = new AuditService(createConfig(dataDir));
    await recordMany(service, 4);
    const lines = await readLines(logPath);
    const entry = JSON.parse(lines[2]);
    entry.tool = "delete_email";
    lines[2] = JSON.stringify(entry);
    await writeLines(logPath, lines);

    const result = await service.verify();
    assert.equal(result.ok, false);
    assert.equal(result.brokenSeq, 3);
    assert.equal(result.reason, "edited");
    assert.equal(result.checked, 2);
    assert.equal(result.headHash, null);
  });
});

test("an edited entry whose own hash was recomputed still breaks the link to the next one", async () => {
  await withDataDir(async (dataDir, logPath) => {
    const service = new AuditService(createConfig(dataDir));
    await recordMany(service, 3);
    const { createHash } = await import("node:crypto");
    const lines = await readLines(logPath);
    const entry = JSON.parse(lines[1]);
    entry.status = "error";
    delete entry.hash;
    const canonical = (value) => Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : value && typeof value === "object"
        ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
        : JSON.stringify(value);
    entry.hash = createHash("sha256").update(entry.prevHash + canonical(entry)).digest("hex");
    lines[1] = JSON.stringify(entry);
    await writeLines(logPath, lines);

    const result = await service.verify();
    assert.equal(result.ok, false);
    assert.equal(result.brokenSeq, 3);
    assert.equal(result.reason, "edited");
  });
});

test("a deleted entry is reported as deleted at the missing seq", async () => {
  await withDataDir(async (dataDir, logPath) => {
    const service = new AuditService(createConfig(dataDir));
    await recordMany(service, 5);
    const lines = await readLines(logPath);
    lines.splice(2, 1);
    await writeLines(logPath, lines);

    const result = await service.verify();
    assert.equal(result.ok, false);
    assert.equal(result.brokenSeq, 3);
    assert.equal(result.reason, "deleted");
  });
});

test("deleting the first entry is caught when no archive was rotated away", async () => {
  await withDataDir(async (dataDir, logPath) => {
    const service = new AuditService(createConfig(dataDir));
    await recordMany(service, 3);
    await writeLines(logPath, (await readLines(logPath)).slice(1));

    const result = await service.verify();
    assert.equal(result.ok, false);
    assert.equal(result.brokenSeq, 1);
    assert.equal(result.reason, "deleted");
  });
});

test("reordered entries are reported as reordered", async () => {
  await withDataDir(async (dataDir, logPath) => {
    const service = new AuditService(createConfig(dataDir));
    await recordMany(service, 5);
    const lines = await readLines(logPath);
    [lines[2], lines[3]] = [lines[3], lines[2]];
    await writeLines(logPath, lines);

    const result = await service.verify();
    assert.equal(result.ok, false);
    assert.equal(result.brokenSeq, 3);
    assert.equal(result.reason, "reordered");
  });
});

test("legacy entries without a hash stay valid and the chain starts at the first new entry", async () => {
  await withDataDir(async (dataDir, logPath) => {
    const legacy = [
      { timestamp: "2026-01-01T00:00:00.000Z", tool: "send_email", status: "success", durationMs: 3 },
      { timestamp: "2026-01-01T00:00:01.000Z", tool: "trash_email", status: "error", durationMs: 1, error: "blocked" },
    ];
    await writeLines(logPath, legacy.map((entry) => JSON.stringify(entry)));
    const service = new AuditService(createConfig(dataDir));
    await recordMany(service, 2);

    const lines = (await readLines(logPath)).map((line) => JSON.parse(line));
    assert.equal(lines.length, 4);
    assert.equal(lines[2].seq, 1);
    assert.equal(lines[2].chainStart, true);
    assert.equal(lines[3].seq, 2);
    assert.equal(lines[3].chainStart, undefined);

    const result = await service.verify();
    assert.equal(result.ok, true);
    assert.equal(result.legacyEntries, 2);
    assert.equal(result.checked, 2);
    assert.equal(result.headSeq, 2);

    const listed = await service.list(10);
    assert.deepEqual(listed.map((entry) => entry.tool), ["send_email", "trash_email", "move_email", "move_email"]);
  });
});

test("an unhashed line inserted after the chain started breaks it", async () => {
  await withDataDir(async (dataDir, logPath) => {
    const service = new AuditService(createConfig(dataDir));
    await recordMany(service, 3);
    const lines = await readLines(logPath);
    lines.splice(2, 0, JSON.stringify({ timestamp: "2026-10-29T12:00:00.000Z", tool: "send_email", status: "success" }));
    await writeLines(logPath, lines);

    const result = await service.verify();
    assert.equal(result.ok, false);
    assert.equal(result.brokenSeq, 3);
    assert.equal(result.reason, "edited");
  });
});

test("entries rotated out of the oldest archive do not break the chain", async () => {
  await withDataDir(async (dataDir, logPath) => {
    const service = new AuditService(createConfig(dataDir));
    await recordMany(service, 4);
    const lines = await readLines(logPath);
    // As after two rotations evicted the archive that held seq 1: .2 holds seq 2-3, audit.log holds seq 4.
    await writeLines(`${logPath}.2`, lines.slice(1, 3));
    await writeLines(logPath, lines.slice(3));

    const result = await service.verify();
    assert.equal(result.ok, true);
    assert.equal(result.rotatedBeforeSeq, 2);
    assert.equal(result.checked, 3);
    assert.equal(result.headSeq, 4);

    // The next write continues from the head, read back from disk by a fresh instance.
    await recordMany(new AuditService(createConfig(dataDir)), 1);
    const after = await service.verify();
    assert.equal(after.ok, true);
    assert.equal(after.headSeq, 5);
  });
});

// Two server processes, each with its own AuditService: two instances in one process happen not to interleave,
// so only separate processes show whether the file lock prevents a fork (without it this test forks the chain).
test("concurrent writes from AuditService instances in two processes do not fork the chain", async () => {
  await withDataDir(async (dataDir, logPath) => {
    const serviceUrl = new URL("../dist/services/audit-service.js", import.meta.url).href;
    const script = `
      const { AuditService } = await import(${JSON.stringify(serviceUrl)});
      const service = new AuditService({ smtp: { username: "owner@example.com" }, dataDir: process.argv[1] });
      // The account identity check takes its own lock; done first so it cannot stagger the two writers.
      await service.list();
      while (Date.now() < Number(process.argv[3])) await new Promise((resolve) => setTimeout(resolve, 1));
      for (let i = 0; i < 100; i++) {
        await service.record({ timestamp: new Date().toISOString(), tool: process.argv[2], status: "success", input: { i } });
      }`;
    // Without a shared start time the first writer finishes before the second has started.
    const startAt = Date.now() + 1000;
    const run = (tool) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, dataDir, tool, String(startAt)], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer ${tool} exited ${code}: ${stderr}`))));
    });
    await new AuditService(createConfig(dataDir)).list();
    await Promise.all([run("a"), run("b")]);

    const entries = (await readLines(logPath)).map((line) => JSON.parse(line));
    assert.equal(entries.length, 200);
    assert.deepEqual(entries.map((entry) => entry.seq), Array.from({ length: 200 }, (_, i) => i + 1));
    assert.equal(entries.filter((entry) => entry.chainStart).length, 1);

    const result = await new AuditService(createConfig(dataDir)).verify();
    assert.equal(result.ok, true);
    assert.equal(result.checked, 200);
  });
});
