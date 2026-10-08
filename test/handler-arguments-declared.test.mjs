import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createUnconfiguredServer } from "../dist/index.js";

// A result carries a note about arguments a tool does not declare. That is only honest if no handler reads an
// argument its schema leaves out. This reads the handler source (a static scan, so it cannot see a read hidden
// behind a helper, which is why the helpers that read `account` and `undoWindowSeconds` are listed below).

const source = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
const HELPER_READS = [
  [/resolveAccountArg\(args\)/, "account"],
  [/resolveUndoWindowSeconds\(args\)/, "undoWindowSeconds"],
];

test("no tool handler reads an argument that its schema does not declare", async () => {
  const server = createUnconfiguredServer();
  const client = new Client({ name: "scan", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();

  const body = source.slice(source.indexOf("withIgnoredArgumentsNote(async (request) => {"));
  const cases = [...body.matchAll(/\n        case "([a-z_]+)":/g)];
  assert.ok(cases.length >= 90, `found only ${cases.length} cases`);
  const problems = [];
  for (let i = 0; i < cases.length; i += 1) {
    const name = cases[i][1];
    const segment = body.slice(cases[i].index, (cases[i + 1] ?? { index: body.length }).index);
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) continue;
    const declared = new Set(Object.keys(tool.inputSchema.properties ?? {}));
    const used = new Set();
    for (const m of segment.matchAll(/\bargs\??\.([A-Za-z_][A-Za-z0-9_]*)/g)) used.add(m[1]);
    for (const m of segment.matchAll(/\b(?:optional|require)[A-Za-z]*\(\s*args\s*,\s*"([A-Za-z0-9_]+)"/g)) used.add(m[1]);
    for (const m of segment.matchAll(/\bargs\[\s*"([A-Za-z0-9_]+)"\s*\]/g)) used.add(m[1]);
    for (const [pattern, key] of HELPER_READS) if (pattern.test(segment)) used.add(key);
    for (const key of used) if (!declared.has(key)) problems.push(`${name} reads "${key}" without declaring it`);
  }
  assert.deepEqual(problems, []);
});
