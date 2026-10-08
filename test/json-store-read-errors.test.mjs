import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryQueueService } from "../dist/services/delivery-queue-service.js";
import { SnoozeService } from "../dist/services/snooze-service.js";
import { TemplateService } from "../dist/services/template-service.js";
import { DraftStoreService } from "../dist/services/draft-store-service.js";
import { setAsideCorruptStore } from "../dist/utils/corrupt-store.js";

// The four JSON stores must treat a file they cannot READ differently from a file they cannot PARSE:
// only invalid JSON is backed up and replaced by an empty store. Any other read error says nothing
// about the contents, and starting empty would let the next save() erase pending scheduled mail,
// snoozes, templates or drafts. (Fixed for drafts in 2.1.48; the other three were missed.)

function config(dataDir) {
  return {
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "x" },
    dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false,
      autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 100, idleWatchEnabled: false, idleMaxSeconds: 30, sendDelaySeconds: 0 },
  };
}

const STORES = [
  { name: "delivery-queue", file: "delivery-queue.json", make: (c) => new DeliveryQueueService(c, {}), read: (s) => s.list(), valid: '{"version":1,"items":{}}' },
  { name: "snooze", file: "snoozed.json", make: (c) => new SnoozeService(c, {}), read: (s) => s.list(), valid: '{"version":1,"items":{}}' },
  { name: "templates", file: "templates.json", make: (c) => new TemplateService(c), read: (s) => s.list(), valid: '{"version":1,"templates":{}}' },
  { name: "drafts", file: "drafts.json", make: (c) => new DraftStoreService(c), read: (s) => s.listDrafts(), valid: '{"version":1,"drafts":{}}' },
];

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "protonmail-json-store-"));
  try {
    await fn(dir);
  } finally {
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const POSIX_USER = process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;

for (const store of STORES) {
  test(`${store.name}: a file that cannot be read is an error and is left untouched`, { skip: !POSIX_USER && "needs POSIX permissions and a non-root user" }, async () => {
    await withDir(async (dir) => {
      const path = join(dir, store.file);
      await writeFile(path, store.valid);
      await chmod(path, 0o000);
      const service = store.make(config(dir));
      await assert.rejects(store.read(service), /EACCES/);
      await chmod(path, 0o600);
      assert.equal(await readFile(path, "utf8"), store.valid);
      assert.deepEqual((await readdir(dir)).filter((f) => f.includes(".corrupt")), [], "nothing is set aside for an error that is not a parse error");
    });
  });

  test(`${store.name}: invalid JSON is backed up and replaced by an empty store`, async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, store.file), "{not json");
      const service = store.make(config(dir));
      assert.deepEqual(await store.read(service), []);
      assert.equal(await readFile(join(dir, `${store.file}.corrupt`), "utf8"), "{not json");
    });
  });

  test(`${store.name}: a second corruption does not overwrite the first backup`, async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, store.file), "{first");
      await store.read(store.make(config(dir)));
      await writeFile(join(dir, store.file), "{second");
      await store.read(store.make(config(dir)));
      assert.equal(await readFile(join(dir, `${store.file}.corrupt`), "utf8"), "{first");
      const extra = (await readdir(dir)).filter((f) => f.startsWith(`${store.file}.corrupt-`));
      assert.equal(extra.length, 1);
      assert.equal(await readFile(join(dir, extra[0]), "utf8"), "{second");
    });
  });

  test(`${store.name}: a missing file is an empty store`, async () => {
    await withDir(async (dir) => {
      assert.deepEqual(await store.read(store.make(config(dir))), []);
    });
  });
}

test("templates: a failed read does not let the next create() overwrite the saved templates", { skip: !POSIX_USER && "needs POSIX permissions and a non-root user" }, async () => {
  await withDir(async (dir) => {
    const first = new TemplateService(config(dir));
    await first.create({ name: "keep", subject: "s", body: "b" });
    const path = join(dir, "templates.json");
    await chmod(path, 0o000);
    await assert.rejects(new TemplateService(config(dir)).create({ name: "other", subject: "s", body: "b" }), /EACCES/);
    await chmod(path, 0o600);
    assert.deepEqual((await new TemplateService(config(dir)).list()).map((t) => t.name), ["keep"]);
  });
});

const silentLog = { error() {}, warn() {}, info() {}, debug() {} };

test("setAsideCorruptStore rethrows anything that is not a parse error", () => {
  for (const error of [Object.assign(new Error("denied"), { code: "EACCES" }), new TypeError("odd"), Object.assign(new Error("io"), { code: "EIO" })]) {
    assert.throws(() => setAsideCorruptStore("/nonexistent/file.json", error, silentLog, "test"), (thrown) => thrown === error);
  }
});

test("setAsideCorruptStore fails, instead of carrying on, when the backup cannot be written", async () => {
  await withDir(async (dir) => {
    // The file to back up does not exist, so the copy fails: the caller must see that, not an empty store.
    assert.throws(() => setAsideCorruptStore(join(dir, "missing.json"), new SyntaxError("bad"), silentLog, "test"), /ENOENT/);
    assert.deepEqual(await readdir(dir), []);
  });
});

test("setAsideCorruptStore keeps the file's content in the backup", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "x.json");
    await writeFile(path, "{oops");
    setAsideCorruptStore(path, new SyntaxError("bad"), silentLog, "test");
    assert.equal(await readFile(`${path}.corrupt`, "utf8"), "{oops");
    assert.equal(await readFile(path, "utf8"), "{oops", "the original is left in place; the store replaces it on the next save");
  });
});
