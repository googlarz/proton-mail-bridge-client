import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Guards for build and CI settings that fail silently if someone removes them.

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFile(join(root, rel), "utf8");

test("tsc reports unused locals and parameters", async () => {
  // Without these flags dead imports and ignored parameters compile without a word: this
  // is how folder_stats came to advertise a `scanLimit` its implementation ignored.
  const { compilerOptions } = JSON.parse(await read("tsconfig.json"));
  assert.equal(compilerOptions.noUnusedLocals, true);
  assert.equal(compilerOptions.noUnusedParameters, true);
});

test("every third-party GitHub Action is pinned to a full commit SHA", async () => {
  // A tag such as @v4 can be moved to different code after the fact; a commit SHA cannot.
  // The publish job holds the OIDC identity that npm trusts, so what runs there matters most.
  const dir = join(root, ".github", "workflows");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".yml"));
  assert.ok(files.length >= 3);
  const unpinned = [];
  for (const file of files) {
    const text = await readFile(join(dir, file), "utf8");
    for (const match of text.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm)) {
      const ref = match[1];
      if (ref.startsWith("./")) continue;
      if (!/@[0-9a-f]{40}$/.test(ref)) unpinned.push(`${file}: ${ref}`);
    }
  }
  assert.deepEqual(unpinned, []);
});

test("the test workflow runs with read-only repository permissions", async () => {
  const ci = await read(".github/workflows/ci.yml");
  assert.match(ci, /^permissions:\s*\n\s+contents:\s*read\s*$/m);
});

test("Dependabot keeps both the npm dependencies and the pinned actions current", async () => {
  const config = await read(".github/dependabot.yml");
  assert.match(config, /package-ecosystem:\s*github-actions/);
  assert.match(config, /package-ecosystem:\s*npm/);
});

test("Dependabot does not offer major bumps that would break the supported Node range", async () => {
  // better-sqlite3 13 needs Node >=22 and crashes on 20; @types/node 26 would let code use
  // APIs Node 20 lacks. Both must stay ignored for major updates until `engines.node` is raised.
  const config = await read(".github/dependabot.yml");
  for (const name of ["better-sqlite3", "@types/node"]) {
    assert.match(config, new RegExp(`dependency-name:\\s*"${name}"\\s*\\n\\s*update-types:\\s*\\["version-update:semver-major"\\]`), `${name} majors must be ignored`);
  }
});

test("the allowScripts pin names the better-sqlite3 version that is actually installed", async () => {
  const pkg = JSON.parse(await read("package.json"));
  const lock = JSON.parse(await read("package-lock.json"));
  const installed = lock.packages["node_modules/better-sqlite3"].version;
  assert.equal(pkg.allowScripts?.[`better-sqlite3@${installed}`], true, `allowScripts must pin better-sqlite3@${installed}`);
});
