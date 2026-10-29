import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, link, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInsideServerState } from "../dist/utils/server-state-paths.js";

async function layout() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ssp-")));
  const data = join(root, "data");
  const other = join(root, "other-account");
  await mkdir(join(data, "attachments"), { recursive: true });
  await mkdir(other, { recursive: true });
  await writeFile(join(data, "audit.log"), "x");
  await writeFile(join(other, "grants.json"), "x");
  await writeFile(join(root, "ca.pem"), "x");
  const config = { dataDir: data, accounts: [{ dataDir: data }, { dataDir: other }], runtime: { tlsCaFile: join(root, "ca.pem") } };
  return { root, data, other, config };
}

test("state paths: refused", async () => {
  const { root, data, other, config } = await layout();
  try {
    const bad = {
      "audit log": join(data, "audit.log"),
      "new file in data dir": join(data, "new.json"),
      "new file in new subdir of data dir": join(data, "sub", "deeper", "new.json"),
      "dotdot": join(data, "attachments", "..", "audit.log"),
      "other account": join(other, "grants.json"),
      "new file in other account": join(other, "x.json"),
      "ca file": join(root, "ca.pem"),
      "ca file via dotdot": join(root, "data", "..", "ca.pem"),
    };
    for (const [label, path] of Object.entries(bad)) assert.equal(isInsideServerState(path, config), true, label);
    await symlink(data, join(root, "link-to-data"));
    assert.equal(isInsideServerState(join(await realpath(join(root, "link-to-data")), "x"), config), true, "real path of symlink");
    await link(join(data, "audit.log"), join(root, "hard.log"));
    // A hard link to a file inside the data dir is not recognised (only directories and the CA file are matched by inode);
    // harmless in practice because the writer opens with "wx" and never overwrites an existing name.
    assert.equal(isInsideServerState(join(root, "hard.log"), config), false);
    await link(join(root, "ca.pem"), join(root, "ca-hard.pem"));
    assert.equal(isInsideServerState(join(root, "ca-hard.pem"), config), true, "hard link to ca");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("state paths: allowed", async () => {
  const { root, data, config } = await layout();
  try {
    assert.equal(isInsideServerState(join(data, "attachments", "a.pdf"), config), false);
    assert.equal(isInsideServerState(join(root, "downloads", "a.pdf"), config), false);
    assert.equal(isInsideServerState(join(root, "data-extra", "a.pdf"), config), false, "sibling with the same prefix");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("state paths: data dir of an account whose dir does not exist yet", async () => {
  const { root, config } = await layout();
  try {
    const later = join(root, "later-account");
    config.accounts.push({ dataDir: later });
    assert.equal(isInsideServerState(join(later, "grants.json"), config), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("state paths: attachments folder replaced by a symlink to the data dir is not a free pass", async () => {
  const { root, data, config } = await layout();
  try {
    await rm(join(data, "attachments"), { recursive: true });
    await symlink(data, join(data, "attachments"));
    assert.equal(isInsideServerState(await realpath(join(data, "attachments", "audit.log")), config), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("state paths: case variants (case-insensitive filesystems)", async () => {
  const { root, config } = await layout();
  try {
    const upper = join(root, "DATA", "audit.log");
    const insensitive = await import("node:fs").then((fs) => fs.existsSync(upper));
    if (!insensitive) return; // case-sensitive volume: nothing to test
    assert.equal(isInsideServerState(upper, config), true);
    assert.equal(isInsideServerState(join(root, "DATA", "new.json"), config), true, "new file under a case variant of the data dir");
  } finally { await rm(root, { recursive: true, force: true }); }
});
