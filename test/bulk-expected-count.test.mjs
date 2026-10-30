import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { createMessage, makeCertificate, startFakeBridge } from "./helpers/fake-bridge.mjs";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";
import { throwOnToolError } from "./helpers/throw-on-tool-error.mjs";

const certificate = makeCertificate();
const needsOpenssl = certificate ? {} : { skip: "openssl is not available to make a test certificate" };

// expectedCount: the caller previews with dryRun, reads the count and passes it back. A different count refuses
// the call before anything changes. Driven through the real server against the fake Bridge so "nothing changed"
// is checked on the mailbox itself.

function folders() {
  return {
    INBOX: { uidValidity: 7, messages: [1, 2, 3].map((uid) => createMessage(uid)).concat(createMessage(4, { flags: ["\\Seen"] })) },
    Archive: { uidValidity: 8, messages: [] },
    Trash: { uidValidity: 9, specialUse: "\\Trash", messages: [] },
  };
}

async function withServer(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), "bulk-expected-"));
  const bridge = await startFakeBridge({ folders: folders(), mode: "starttls", certificate });
  const imap = { host: "127.0.0.1", port: bridge.port, secure: false, username: "owner@example.com", password: "secret" };
  const smtp = { ...imap, port: 9 };
  const config = {
    smtp, imap, dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: "owner@example.com", slug: "owner-example-com", imap, smtp, dataDir }],
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: ["move", "delete", "trash", "star", "mark_read"], startupSync: false,
      autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30,
      confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0 },
  };
  const { server, imapService } = createServer(config, { startBackgroundSync: false });
  const client = new Client({ name: "t", version: "0" });
  throwOnToolError(client);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const inbox = () => bridge.state.folders.INBOX.messages.map((m) => m.uid).sort();
  const flagged = () => bridge.state.folders.INBOX.messages.filter((m) => m.flags.has("\\Flagged")).length;
  try { await fn({ client, inbox, flagged }); } finally {
    await client.close(); await server.close(); await imapService.disconnect().catch(() => {}); await bridge.close(); await closeTrackedIndexes();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

const match = { isRead: false }; // the fake Bridge answers UNSEEN searches: uids 1 to 3
const CALLS = {
  bulk_move: { targetFolder: "Archive" },
  bulk_delete: { permanent: true },
  bulk_update_flags: { flagsToAdd: ["\\Flagged"] },
};
const call = (client, name, extra) => client.callTool({ name, arguments: { folder: "INBOX", match, ...CALLS[name], ...extra } });

for (const name of Object.keys(CALLS)) {
  test(`${name}: a wrong expectedCount is refused and the mailbox is unchanged`, needsOpenssl, async () => {
    await withServer(async ({ client, inbox, flagged }) => {
      await assert.rejects(call(client, name, { expectedCount: 2 }), (e) => /matched 3 messages \(0 not found\), expected 2; nothing was changed\. Run dryRun again\./.test(e.message));
      assert.deepEqual(inbox(), [1, 2, 3, 4]);
      assert.equal(flagged(), 0);
    });
  });

  test(`${name}: a matching expectedCount runs, and an absent one behaves as before`, needsOpenssl, async () => {
    for (const extra of [{ expectedCount: 3 }, {}]) {
      await withServer(async ({ client, inbox, flagged }) => {
        const result = await call(client, name, extra);
        assert.notEqual(result.isError, true);
        if (name === "bulk_update_flags") assert.equal(flagged(), 3);
        else assert.deepEqual(inbox(), [4]);
      });
    }
  });

  test(`${name}: dryRun with a wrong expectedCount does not throw and reports the count`, needsOpenssl, async () => {
    await withServer(async ({ client, inbox, flagged }) => {
      const result = await call(client, name, { expectedCount: 99, dryRun: true });
      assert.notEqual(result.isError, true);
      assert.equal(JSON.parse(result.content[0].text).total, 3);
      assert.deepEqual(inbox(), [1, 2, 3, 4]);
      assert.equal(flagged(), 0);
    });
  });

  test(`${name}: an invalid expectedCount is rejected with InvalidParams`, needsOpenssl, async () => {
    await withServer(async ({ client, inbox }) => {
      for (const expectedCount of [-1, 1.5, "3", true, {}]) {
        await assert.rejects(call(client, name, { expectedCount }), (e) => /expectedCount must be a non-negative integer/.test(e.message), JSON.stringify(expectedCount));
      }
      assert.deepEqual(inbox(), [1, 2, 3, 4]);
    });
  });
}

test("bulk_update_labels: a wrong expectedCount is refused, an invalid one is rejected", needsOpenssl, async () => {
  await withServer(async ({ client, inbox }) => {
    const args = { folder: "INBOX", match, labelsToAdd: ["Labels/Work"] };
    await assert.rejects(client.callTool({ name: "bulk_update_labels", arguments: { ...args, expectedCount: 0 } }), /matched 3 messages \(0 not found\), expected 0; nothing was changed/);
    await assert.rejects(client.callTool({ name: "bulk_update_labels", arguments: { ...args, expectedCount: -2 } }), /non-negative integer/);
    assert.deepEqual(inbox(), [1, 2, 3, 4]);
  });
});

test("expectedCount counts resolved emailIds too", needsOpenssl, async () => {
  await withServer(async ({ client, inbox }) => {
    const emailIds = ["INBOX::1", "INBOX::2"];
    await assert.rejects(client.callTool({ name: "bulk_move", arguments: { emailIds, targetFolder: "Archive", expectedCount: 5 } }), /matched 2 messages \(0 not found\), expected 5; nothing was changed/);
    assert.deepEqual(inbox(), [1, 2, 3, 4]);
  });
});

test("a not-found id counts: the total a dryRun reports is accepted by the real call, and only found ids change", needsOpenssl, async () => {
  await withServer(async ({ client, inbox }) => {
    const emailIds = ["INBOX::1", "INBOX::2", "garbage"];
    const args = { emailIds, targetFolder: "Archive" };
    const preview = JSON.parse((await client.callTool({ name: "bulk_move", arguments: { ...args, dryRun: true } })).content[0].text);
    assert.equal(preview.total, 3);
    assert.equal(preview.notFound, 1);
    await assert.rejects(client.callTool({ name: "bulk_move", arguments: { ...args, expectedCount: 2 } }), /matched 3 messages \(1 not found\), expected 2; nothing was changed/);
    assert.deepEqual(inbox(), [1, 2, 3, 4]);
    const result = await client.callTool({ name: "bulk_move", arguments: { ...args, expectedCount: preview.total } });
    assert.notEqual(result.isError, true);
    assert.deepEqual(inbox(), [3, 4]);
  });
});

test("bulk_update_labels: dryRun with a wrong expectedCount reports the total without throwing", needsOpenssl, async () => {
  await withServer(async ({ client, inbox }) => {
    const result = await client.callTool({ name: "bulk_update_labels", arguments: { folder: "INBOX", match, labelsToAdd: ["Labels/Work"], expectedCount: 99, dryRun: true } });
    assert.equal(JSON.parse(result.content[0].text).total, 3);
    assert.deepEqual(inbox(), [1, 2, 3, 4]);
  });
});
