import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";

// skills/send-with-identity tells the agent which tool takes `from` / `appendSignature`.
// Those claims are pinned to the real tool schemas so the skill cannot drift again.
test("send-with-identity skill matches the tool schemas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-text-"));
  const account = {
    address: "o@example.com", slug: "o", dataDir: dir,
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "o@example.com", password: "x" },
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "o@example.com", password: "x" },
  };
  const config = {
    smtp: account.smtp, imap: account.imap, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true,
    autoSync: false, syncInterval: 5,
    runtime: {
      readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: ["mark_read"], startupSync: false,
      autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30,
      confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0, sendDelaySeconds: 0,
    },
    accounts: [account],
  };
  const { server } = createServer(config, { startBackgroundSync: false });
  const client = new Client({ name: "test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const { tools } = await client.listTools();
    const props = (name) => tools.find((t) => t.name === name).inputSchema.properties;
    const withProp = (prop) => tools.filter((t) => prop in (t.inputSchema.properties ?? {})).map((t) => t.name);

    const appendSignature = withProp("appendSignature").sort();
    assert.deepEqual(appendSignature, ["forward_email", "reply_all_email", "reply_to_email", "send_email"]);
    assert.ok(!("from" in props("send_draft")) && !("from" in props("schedule_draft")));
    assert.match(props("create_reply_draft").from.description, /Store this draft under/);
    assert.match(props("create_draft").from.description, /when the draft is sent/);

    const skill = readFileSync(new URL("../skills/send-with-identity/SKILL.md", import.meta.url), "utf8");
    assert.ok(skill.includes("send_email, reply_to_email, reply_all_email, forward_email"));
    assert.match(skill, /only tools with `appendSignature`/);
    assert.match(skill, /send_draft, schedule_draft\): neither takes `from`/);
    assert.match(skill, /isHtml: true/);
  } finally {
    await client.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
