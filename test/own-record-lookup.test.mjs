import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TemplateService } from "../dist/services/template-service.js";
import { DraftStoreService } from "../dist/services/draft-store-service.js";
import { ownRecord } from "../dist/utils/own-record.js";

// A record is looked up by an id the caller types. On a plain object "constructor" and "__proto__" name inherited
// things, not records: get_template used to hand back a function, delete_template reported a deletion that never
// happened.

const PROTOTYPE_KEYS = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"];

function config(dataDir) {
  return {
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "o@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "o@example.com", password: "x" },
    dataDir, debug: false, runtime: {},
  };
}

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "own-record-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}

test("ownRecord sees own keys only", () => {
  const map = { a: { id: "a" } };
  assert.deepEqual(ownRecord(map, "a"), { id: "a" });
  for (const key of PROTOTYPE_KEYS) assert.equal(ownRecord(map, key), undefined, key);
});

test("templates: an inherited name is not a template", async () => {
  await withDir(async (dir) => {
    const templates = new TemplateService(config(dir));
    const created = await templates.create({ name: "welcome", subject: "Hi {{name}}", body: "Hello {{name}}" });
    assert.equal((await templates.get(created.id)).name, "welcome");
    for (const key of PROTOTYPE_KEYS) {
      await assert.rejects(templates.get(key), /Template not found/, key);
      assert.deepEqual(await templates.delete(key), { id: key, deleted: false }, key);
    }
    assert.equal((await templates.list()).length, 1, "the real template is untouched");
  });
});

test("drafts: an inherited name is not a draft", async () => {
  await withDir(async (dir) => {
    const drafts = new DraftStoreService(config(dir));
    const draft = await drafts.createDraft({ to: ["x@example.com"], subject: "s", body: "b" });
    assert.equal((await drafts.getDraft(draft.id)).subject, "s");
    for (const key of PROTOTYPE_KEYS) {
      await assert.rejects(drafts.getDraft(key), /not found|Draft/i, key);
    }
  });
});
