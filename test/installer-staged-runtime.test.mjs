import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareClaudeDesktopRuntime } from "../dist/scripts/install-claude-desktop.js";

const REPO = new URL("..", import.meta.url).pathname;
const SQLITE = join(REPO, "node_modules", "better-sqlite3");

// Never runs npm: "installing" copies the repo's better-sqlite3 (minus its C sources) into the
// staging dir, so the real verification (native load, in-memory db, imports) still runs.
async function fakeInstall(stagingDir) {
  await cp(SQLITE, join(stagingDir, "node_modules", "better-sqlite3"), {
    recursive: true,
    filter: (src) => !/better-sqlite3[\\/](deps|src)([\\/]|$)/.test(src),
  });
}

async function fixture({ withRuntime = false, dist = "export const ok = 1;\n" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "installer-staged-"));
  const source = join(root, "source");
  await mkdir(join(source, "dist"), { recursive: true });
  await writeFile(join(source, "dist", "index.js"), dist);
  await writeFile(join(source, "dist", "lib.js"), "export const lib = 1;\n");
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "x", version: "9.9.9", type: "module" }));
  const runtimeDir = join(root, "runtime");
  if (withRuntime) {
    await mkdir(join(runtimeDir, "dist"), { recursive: true });
    await writeFile(join(runtimeDir, "dist", "index.js"), "OLD");
    await writeFile(join(runtimeDir, "package.json"), '{"version":"1.0.0"}');
    await writeFile(join(runtimeDir, "mail-index.sqlite"), "user data");
  }
  const options = { cwd: source, runtimeDir, command: process.execPath, installDependencies: fakeInstall };
  return { root, source, runtimeDir, options };
}

const leftovers = async (root) => (await readdir(root)).filter((name) => name.includes(".staging-"));
const oldIntact = async (runtimeDir) => (await readFile(join(runtimeDir, "dist", "index.js"), "utf8")) === "OLD";

test("staged install: success swaps the runtime, keeps .previous and foreign files", async () => {
  const { root, runtimeDir, options } = await fixture({ withRuntime: true });
  const result = await prepareClaudeDesktopRuntime(options);

  assert.equal(result.runtimeDir, runtimeDir);
  assert.match(await readFile(join(runtimeDir, "dist", "index.js"), "utf8"), /ok = 1/);
  assert.ok(existsSync(join(runtimeDir, "node_modules", "better-sqlite3")));
  assert.equal(await readFile(join(runtimeDir, "mail-index.sqlite"), "utf8"), "user data", "foreign files carried over");
  assert.equal(await readFile(join(`${runtimeDir}.previous`, "dist", "index.js"), "utf8"), "OLD");
  assert.deepEqual(await leftovers(root), []);
});

test("staged install: first install works", async () => {
  const { root, runtimeDir, options } = await fixture();
  await prepareClaudeDesktopRuntime(options);
  assert.ok(existsSync(join(runtimeDir, "dist", "index.js")));
  assert.equal(existsSync(`${runtimeDir}.previous`), false);
  assert.deepEqual(await leftovers(root), []);
});

test("staged install: failing dependency install leaves the live runtime untouched", async () => {
  const { root, runtimeDir, options } = await fixture({ withRuntime: true });
  await assert.rejects(
    prepareClaudeDesktopRuntime({ ...options, installDependencies: async () => { throw new Error("npm ci failed"); } }),
    /npm ci failed/,
  );
  assert.ok(await oldIntact(runtimeDir));
  assert.equal(existsSync(`${runtimeDir}.previous`), false);
  assert.deepEqual(await leftovers(root), []);
});

test("staged install: syntax error in dist/index.js is caught before the swap", async () => {
  const { root, runtimeDir, options } = await fixture({ withRuntime: true, dist: "export const = ;\n" });
  await assert.rejects(prepareClaudeDesktopRuntime(options), /verification failed/);
  assert.ok(await oldIntact(runtimeDir));
  assert.deepEqual(await leftovers(root), []);
});

test("staged install: a failed FIRST install with broken dist leaves nothing behind", async () => {
  const { root, runtimeDir, options } = await fixture({ dist: "export const = ;\n" });
  await assert.rejects(prepareClaudeDesktopRuntime(options), /verification failed/);
  assert.equal(existsSync(runtimeDir), false);
  assert.deepEqual(await readdir(root), ["source"]);
});

test("staged install: removed better-sqlite3 prebuilds are caught before the swap", async () => {
  const { root, runtimeDir, options } = await fixture({ withRuntime: true });
  await assert.rejects(
    prepareClaudeDesktopRuntime({
      ...options,
      afterInstall: (dir) => rm(join(dir, "node_modules", "better-sqlite3", "prebuilds"), { recursive: true, force: true }),
    }),
    /verification failed/,
  );
  assert.ok(await oldIntact(runtimeDir));
  assert.deepEqual(await leftovers(root), []);
});

test("staged install: a failing swap rename restores the previous runtime", async () => {
  const { root, runtimeDir, options } = await fixture({ withRuntime: true });
  const { rename } = await import("node:fs/promises");
  await assert.rejects(
    prepareClaudeDesktopRuntime({
      ...options,
      rename: async (from, to) => {
        if (from.includes(".staging-")) throw new Error("EXDEV simulated");
        await rename(from, to);
      },
    }),
    /EXDEV simulated.*previous runtime was restored/s,
  );
  assert.ok(await oldIntact(runtimeDir));
  assert.deepEqual(await leftovers(root), []);
});

test("staged install: a failing post-swap verification restores the previous runtime", async () => {
  const { root, runtimeDir, options } = await fixture({ withRuntime: true });
  const { verifyRuntime } = await import("../dist/scripts/install-claude-desktop.js");
  let calls = 0;
  await assert.rejects(
    prepareClaudeDesktopRuntime({
      ...options,
      verifyRuntime: async (...args) => {
        calls += 1;
        if (calls === 2) throw new Error("post-swap check failed");
        await verifyRuntime(...args);
      },
    }),
    /post-swap check failed/,
  );
  assert.equal(calls, 2);
  assert.ok(await oldIntact(runtimeDir));
  assert.equal(existsSync(`${runtimeDir}.previous`), false);
  assert.deepEqual(await leftovers(root), []);
});

test("staged install: failing post-swap verification on a first install removes the runtime", async () => {
  const { root, runtimeDir, options } = await fixture();
  let calls = 0;
  await assert.rejects(
    prepareClaudeDesktopRuntime({
      ...options,
      verifyRuntime: async () => {
        calls += 1;
        if (calls === 2) throw new Error("post-swap check failed");
      },
    }),
    /Nothing was installed/,
  );
  assert.equal(existsSync(runtimeDir), false);
  assert.deepEqual(await readdir(root), ["source"]);
});
