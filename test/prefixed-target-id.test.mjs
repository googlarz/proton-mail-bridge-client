import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";
import { createMessage, makeCertificate, startFakeBridge } from "./helpers/fake-bridge.mjs";

const certificate = makeCertificate();
const needsOpenssl = certificate ? {} : { skip: "openssl is not available to make a test certificate" };

test("moving or trashing a mail of a second account returns a target id with the account prefix exactly once", needsOpenssl, async () => {
  const dir = await mkdtemp(join(tmpdir(), "prefixed-target-"));
  const bridge = await startFakeBridge({
    mode: "starttls", certificate, accounts: { "second@example.com": "x" },
    folders: {
      INBOX: { uidValidity: 1, messages: [createMessage(1), createMessage(2)] },
      Trash: { uidValidity: 4, specialUse: "\\Trash", messages: [] },
      Archive: { uidValidity: 3, specialUse: "\\Archive", messages: [] },
    },
  });
  const conn = (port, user) => ({ imap: { host: "127.0.0.1", port, secure: false, username: user, password: "x" }, smtp: { host: "127.0.0.1", port: 9, secure: false, username: user, password: "x" } });
  const first = conn(9, "first@example.com");
  const second = conn(bridge.port, "second@example.com");
  const config = {
    ...first, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [
      { address: "first@example.com", slug: "first-example-com", ...first, dataDir: join(dir, "first") },
      { address: "second@example.com", slug: "second-example-com", ...second, dataDir: join(dir, "second") },
    ],
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: ["mark_read", "archive", "move", "trash", "delete"], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 50, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: true, allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0 },
  };
  const { server, accountManager } = createServer(config, { startBackgroundSync: false });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    const [, secondBundle] = accountManager.all();
    const snapshot = await secondBundle.imapService.collectEmailsForIndex({ folder: "INBOX", limitPerFolder: 10 });
    const ids = snapshot.emails.map((e) => `second-example-com::${e.id}`);
    assert.ok(ids.length >= 2 && ids.every((id) => id.startsWith("second-example-com::")), `ids: ${ids}`);
    for (const [tool, id, extra] of [["trash_email", ids[0], {}], ["move_email", ids[1], { targetFolder: "Archive" }]]) {
      const result = await client.callTool({ name: tool, arguments: { emailId: id, ...extra } });
      assert.ok(!result.isError, result.content?.[0]?.text);
      const body = JSON.parse(result.content.find((c) => c.type === "text").text);
      assert.ok(body.targetEmailId.startsWith("second-example-com::"), body.targetEmailId);
      assert.ok(!body.targetEmailId.startsWith("second-example-com::second-example-com::"), `doubled prefix in ${body.targetEmailId}`);
      assert.ok(body.emailId.startsWith("second-example-com::") && !body.emailId.includes("second-example-com::second-example-com"));
    }
  } finally {
    await client.close(); await server.close(); await closeTrackedIndexes(); await bridge.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
