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

test("Dependabot does not offer an @types/node major that would outrun the supported Node range", async () => {
  // @types/node should describe the OLDEST supported Node (engines.node), not the newest, or code
  // can call APIs the minimum lacks and still compile. Keep its majors ignored until engines is raised.
  const config = await read(".github/dependabot.yml");
  assert.match(config, /dependency-name:\s*"@types\/node"\s*\n\s*update-types:\s*\["version-update:semver-major"\]/);
});

test("the Node floor is the same in package.json, the .mcpb manifest, the Dockerfile and the CI matrix", async () => {
  const pkg = JSON.parse(await read("package.json"));
  const manifest = JSON.parse(await read("mcpb/manifest.json"));
  const floor = pkg.engines.node;
  assert.equal(manifest.compatibility.runtimes.node, floor);
  const major = /(\d+)/.exec(floor)[1];
  assert.match(await read("Dockerfile"), new RegExp(`^FROM node:${major}-`, "m"));
  assert.match(await read(".github/workflows/ci.yml"), new RegExp(`node-version: \\[${major}\\]`));
  // The .mcpb bundles native better-sqlite3 binaries, which are built per Node ABI: build on the floor.
  assert.match(await read(".github/workflows/mcpb-release.yml"), new RegExp(`node-version: '${major}'`));
});

test("the allowScripts pin names the better-sqlite3 version that is actually installed", async () => {
  const pkg = JSON.parse(await read("package.json"));
  const lock = JSON.parse(await read("package-lock.json"));
  const installed = lock.packages["node_modules/better-sqlite3"].version;
  assert.equal(pkg.allowScripts?.[`better-sqlite3@${installed}`], true, `allowScripts must pin better-sqlite3@${installed}`);
});

test("every package the source imports is a runtime dependency, not a devDependency", async () => {
  // The installed runtime and the .mcpb bundles are built with --omit=dev. A package that src/
  // imports but package.json lists under devDependencies is present in the repo, so tests pass,
  // and missing everywhere users run it. (`npm install --save-dev a b` moves BOTH packages.)
  const pkg = JSON.parse(await read("package.json"));
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(rel);
      else if (rel.endsWith(".ts")) files.push(rel);
    }
  };
  await walk("src");
  const imported = new Set();
  for (const file of files) {
    const code = await read(file);
    const specs = [
      ...code.matchAll(/^\s*(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']/gm),
      ...code.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
      ...code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
    ];
    for (const m of specs) {
      const spec = m[1];
      if (spec.startsWith("node:") || spec.startsWith(".")) continue;
      imported.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
    }
  }
  assert.ok(imported.has("better-sqlite3"), "scan should see better-sqlite3 (guards the regex itself)");
  const builtins = new Set((await import("node:module")).builtinModules);
  for (const name of [...imported].filter((n) => !builtins.has(n))) {
    assert.ok(pkg.dependencies?.[name], `${name} is imported by src/ but is not in "dependencies"`);
  }
});
