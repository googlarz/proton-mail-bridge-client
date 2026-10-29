import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, copyFile, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
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
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-audit-integrity-"));
  try {
    await fn(dataDir, join(dataDir, "audit.log"), join(dataDir, "audit.head"));
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function recordMany(service, count, tool = "move_email") {
  for (let i = 0; i < count; i++) {
    await service.record({ timestamp: `2026-10-29T12:00:0${i}.000Z`, tool, status: "success", durationMs: i, input: { emailId: `INBOX::${i}` } });
  }
}

const readLines = async (path) => (await readFile(path, "utf8")).split("\n").filter(Boolean);
const writeLines = (path, lines) => writeFile(path, lines.length ? `${lines.join("\n")}\n` : "");

test("a log that ends in a torn line: the next entry starts on its own line and the chain stays intact", async () => {
  await withDataDir(async (dataDir, logPath) => {
    const service = new AuditService(createConfig(dataDir));
    await recordMany(service, 2);
    // A crash in the middle of an append: half an entry, no newline.
    await appendFile(logPath, '{"timestamp":"2026-10-29T12:00:09.000Z","tool":"mo');
    await recordMany(new AuditService(createConfig(dataDir)), 1, "trash_email");

    const lines = await readLines(logPath);
    assert.equal(lines.length, 4);
    const last = JSON.parse(lines[3]);
    assert.equal(last.tool, "trash_email");
    assert.equal(last.seq, 3);

    const result = await new AuditService(createConfig(dataDir)).verify();
    assert.equal(result.ok, true);
    assert.equal(result.checked, 3);
    assert.equal(result.headSeq, 3);
    assert.match(result.detail ?? "", /^1 incomplete line/);
  });
});

test("a torn line is reported once, however many entries follow it", async () => {
  await withDataDir(async (dataDir, logPath) => {
    const service = new AuditService(createConfig(dataDir));
    await recordMany(service, 1);
    await appendFile(logPath, '{"timestamp":"2026-10-29T12:00:09.000Z","tool":"mo');
    await recordMany(service, 3);
    const result = await service.verify();
    assert.equal(result.ok, true);
    assert.equal(result.checked, 4);
    assert.match(result.detail ?? "", /^1 incomplete line/);
  });
});

test("an entry written normally leaves no detail and a newline-terminated log is not padded", async () => {
  await withDataDir(async (dataDir, logPath) => {
    const service = new AuditService(createConfig(dataDir));
    await recordMany(service, 3);
    assert.equal((await readFile(logPath, "utf8")).includes("\n\n"), false);
    const result = await service.verify();
    assert.equal(result.ok, true);
    assert.equal(result.detail, undefined);
  });
});

test("a deleted audit.log is caught once the chain head has been recorded", async () => {
  await withDataDir(async (dataDir, logPath) => {
    const service = new AuditService(createConfig(dataDir));
    await recordMany(service, 3);
    await unlink(logPath);
    const result = await new AuditService(createConfig(dataDir)).verify();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "deleted");
    assert.match(result.detail ?? "", /audit\.head|seq 3/);
  });
});

test("an emptied audit.log is caught", async () => {
  await withDataDir(async (dataDir, logPath) => {
    await recordMany(new AuditService(createConfig(dataDir)), 3);
    await writeFile(logPath, "");
    const result = await new AuditService(createConfig(dataDir)).verify();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "deleted");
  });
});

test("a truncated tail is caught even though the remaining chain is valid", async () => {
  await withDataDir(async (dataDir, logPath) => {
    await recordMany(new AuditService(createConfig(dataDir)), 5);
    await writeLines(logPath, (await readLines(logPath)).slice(0, 3));
    const result = await new AuditService(createConfig(dataDir)).verify();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "deleted");
    assert.equal(result.brokenSeq, 4);
  });
});

test("stripping the chain fields from every line is caught (it used to verify as ok with checked 0)", async () => {
  await withDataDir(async (dataDir, logPath) => {
    await recordMany(new AuditService(createConfig(dataDir)), 4);
    const stripped = (await readLines(logPath)).map((line) => {
      const { seq: _s, prevHash: _p, hash: _h, chainStart: _c, ...rest } = JSON.parse(line);
      return JSON.stringify(rest);
    });
    await writeLines(logPath, stripped);
    const result = await new AuditService(createConfig(dataDir)).verify();
    assert.equal(result.ok, false);
    assert.equal(result.checked, 0);
    assert.equal(result.legacyEntries, 4);
    assert.match(result.detail ?? "", /chain/i);
  });
});

test("a different but internally valid chain with the same head seq is caught", async () => {
  await withDataDir(async (dataDir, logPath) => {
    await recordMany(new AuditService(createConfig(dataDir)), 3, "move_email");
    await withDataDir(async (otherDir, otherLog) => {
      await recordMany(new AuditService(createConfig(otherDir)), 3, "send_email");
      await copyFile(otherLog, logPath);
    });
    const result = await new AuditService(createConfig(dataDir)).verify();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "edited");
    assert.equal(result.brokenSeq, 3);
  });
});

test("without audit.head nothing is claimed about the head: an empty log verifies as before", async () => {
  await withDataDir(async (dataDir, logPath, headPath) => {
    await recordMany(new AuditService(createConfig(dataDir)), 3);
    await unlink(headPath);
    await unlink(logPath);
    const result = await new AuditService(createConfig(dataDir)).verify();
    assert.deepEqual(result, { ok: true, checked: 0, legacyEntries: 0, headSeq: null, headHash: null });
  });
});

test("an old log (no audit.head yet) verifies, and the first new entry creates audit.head", async () => {
  await withDataDir(async (dataDir, logPath, headPath) => {
    await recordMany(new AuditService(createConfig(dataDir)), 2);
    await unlink(headPath);
    const service = new AuditService(createConfig(dataDir));
    assert.equal((await service.verify()).ok, true);
    await recordMany(service, 1);
    const head = JSON.parse(await readFile(headPath, "utf8"));
    const last = JSON.parse((await readLines(logPath)).at(-1));
    assert.deepEqual(head, { seq: 3, hash: last.hash });
  });
});

test("a head file one entry behind the log (crash between the append and the head write) is not tampering", async () => {
  await withDataDir(async (dataDir, logPath, headPath) => {
    await recordMany(new AuditService(createConfig(dataDir)), 3);
    const second = JSON.parse((await readLines(logPath))[1]);
    await writeFile(headPath, JSON.stringify({ seq: 2, hash: second.hash }));
    const result = await new AuditService(createConfig(dataDir)).verify();
    assert.equal(result.ok, true);
    assert.equal(result.headSeq, 3);
  });
});

test("writing after audit.log was deleted does not erase the evidence", async () => {
  await withDataDir(async (dataDir, logPath) => {
    await recordMany(new AuditService(createConfig(dataDir)), 3);
    await unlink(logPath);
    const service = new AuditService(createConfig(dataDir));
    await recordMany(service, 1);
    const result = await service.verify();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "deleted");
  });
});

test("audit.head is owner-only", { skip: process.platform === "win32" }, async () => {
  await withDataDir(async (dataDir, _logPath, headPath) => {
    await recordMany(new AuditService(createConfig(dataDir)), 1);
    assert.equal((await stat(headPath)).mode & 0o777, 0o600);
  });
});
