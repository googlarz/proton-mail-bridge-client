import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfigFromEnv } from "../dist/index.js";
import { SimpleIMAPService } from "../dist/services/simple-imap-service.js";

function withAccounts(accounts, fn) {
  const keys = ["PROTONMAIL_USERNAME", "PROTONMAIL_PASSWORD", "PROTONMAIL_ACCOUNTS_JSON", "PROTONMAIL_DATA_DIR"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    Object.assign(process.env, {
      PROTONMAIL_USERNAME: "me@proton.me",
      PROTONMAIL_PASSWORD: "x",
      PROTONMAIL_DATA_DIR: "/tmp/multi-account-sync-config-test",
      PROTONMAIL_ACCOUNTS_JSON: JSON.stringify(accounts),
    });
    return fn();
  } finally {
    for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
}

test("an additional account can read its password from a file or a command", () => {
  const file = join(mkdtempSync(join(tmpdir(), "pw-")), "pw.txt");
  writeFileSync(file, "from-file\n");
  withAccounts(
    [
      { address: "a@proton.me", passwordFile: file },
      { address: "b@proton.me", passwordCommand: "echo from-command" },
    ],
    () => {
      const [, a, b] = buildConfigFromEnv().accounts;
      assert.equal(a.imap.password, "from-file");
      assert.equal(a.smtp.password, "from-file");
      assert.equal(b.imap.password, "from-command");
    },
  );
});

test("password sources are exclusive and one is required", () => {
  assert.throws(() => withAccounts([{ address: "a@proton.me", password: "p", passwordCommand: "echo x" }], buildConfigFromEnv), /only one of/);
  assert.throws(() => withAccounts([{ address: "a@proton.me" }], buildConfigFromEnv), /password is required/);
  assert.throws(() => withAccounts([{ address: "a@proton.me", passwordFile: "/nonexistent/pw" }], buildConfigFromEnv), /could not read the password/);
});

test("autoSyncFolder can be set per account", () => {
  withAccounts([{ address: "a@proton.me", password: "p", autoSyncFolder: "INBOX" }, { address: "b@proton.me", password: "p" }], () => {
    const [, a, b] = buildConfigFromEnv().accounts;
    assert.equal(a.autoSyncFolder, "INBOX");
    assert.equal(b.autoSyncFolder, undefined);
  });
});

function serviceWithFolders(paths) {
  const service = new SimpleIMAPService(
    { imap: { host: "h", port: 1, secure: false, username: "u", password: "p" }, smtp: {}, dataDir: "/tmp/x", runtime: {} },
    undefined,
    0,
  );
  service.getFolderStructure = async () => paths.map((path) => ({ path, flags: [] }));
  service.getFolders = async () => [];
  service.collectFolderForIndex = async (folder) => ({ checkpoint: { folder }, emails: [] });
  return service;
}

test("a missing folder in an explicit list is skipped and reported", async () => {
  const snapshot = await serviceWithFolders(["INBOX", "Sent"]).collectEmailsForIndex({ folder: "INBOX,Sent,Gesendet" });
  assert.deepEqual(snapshot.skippedFolders, ["Gesendet"]);
  assert.equal(snapshot.folderStats.length, 2);
  assert.equal(snapshot.complete, true);
});

test("a list where no folder exists is an error", async () => {
  await assert.rejects(serviceWithFolders(["INBOX"]).collectEmailsForIndex({ folder: "A,B" }), /None of the folders exist/);
});
