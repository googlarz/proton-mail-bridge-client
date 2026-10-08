import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// A registry or client that starts the server without a login must still get its tool list, and a call must
// say what is missing. Before, the process exited at once and the client only saw "Connection closed".

const entry = resolve(fileURLToPath(new URL("../dist/index.js", import.meta.url)));

async function withServer(extraEnv, fn) {
  const home = await mkdtemp(join(tmpdir(), "unconfigured-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, SystemRoot: process.env.SystemRoot ?? "", ...extraEnv },
  });
  const client = new Client({ name: "unconfigured-test", version: "0" });
  try {
    await fn(client, transport, home);
  } finally {
    await client.close().catch(() => {});
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

test("without a login the server lists its tools", async () => {
  await withServer({}, async (client, transport) => {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 90, `only ${tools.length} tools`);
    assert.ok(tools.some((tool) => tool.name === "send_email"));
  });
});

test("without a login every call fails with a message that says what to set", async () => {
  await withServer({}, async (client, transport) => {
    await client.connect(transport);
    for (const name of ["get_runtime_status", "search_emails", "send_email"]) {
      const result = await client.callTool({ name, arguments: {} });
      assert.equal(result.isError, true, name);
      assert.match(result.content[0].text, /PROTONMAIL_USERNAME and PROTONMAIL_PASSWORD are not set/, name);
    }
  });
});

test("the core tool tier applies without a login too", async () => {
  await withServer({ PROTONMAIL_TOOL_TIER: "core" }, async (client, transport) => {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(tools.length > 0 && tools.length < 40, `${tools.length} tools in the core tier`);
  });
});

test("without a login nothing is created on disk", async () => {
  await withServer({}, async (client, transport, home) => {
    await client.connect(transport);
    await client.listTools();
    await client.callTool({ name: "get_runtime_status", arguments: {} });
    assert.deepEqual(await readdir(home), []);
  });
});

test("another configuration mistake still stops the server at start", async () => {
  await withServer({ PROTONMAIL_USERNAME: "u@example.com", PROTONMAIL_PASSWORD: "x", PROTONMAIL_SMTP_PORT: "not-a-port" }, async (client, transport) => {
    await assert.rejects(() => client.connect(transport));
  });
});
