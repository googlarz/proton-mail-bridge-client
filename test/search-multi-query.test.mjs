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

test("queries: several wordings are searched and fused; a message found by more of them ranks first", needsOpenssl, async () => {
  const dir = await mkdtemp(join(tmpdir(), "multi-query-"));
  const bridge = await startFakeBridge({
    mode: "starttls", certificate,
    folders: { INBOX: { uidValidity: 1, messages: [
      createMessage(1, { subject: "Zwrot kaucji", body: "Dzień dobry, kaucja zostanie zwrócona w tym tygodniu.\r\n" }),
      createMessage(2, { subject: "Rental agreement", body: "Your deposit and the rental terms are attached.\r\n" }),
      createMessage(3, { subject: "Deposit refund", body: "The deposit of the rental will be refunded; the rental agreement is closed.\r\n" }),
      createMessage(4, { subject: "Lunch", body: "Pizza on Friday?\r\n" }),
    ] } },
  });
  const conn = { imap: { host: "127.0.0.1", port: bridge.port, secure: false, username: "owner@example.com", password: "secret" }, smtp: { host: "127.0.0.1", port: 9, secure: false, username: "owner@example.com", password: "secret" } };
  const config = {
    ...conn, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: "owner@example.com", slug: "owner-example-com", ...conn, dataDir: dir }],
    runtime: { readOnly: true, allowSend: false, allowRemoteDraftSync: false, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 50, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: true, allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0 },
  };
  const { server } = createServer(config, { startBackgroundSync: false });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (args) => {
    const result = await client.callTool({ name: "search_indexed_emails", arguments: args });
    const text = result.content.find((c) => c.type === "text").text;
    return result.isError ? { error: text } : JSON.parse(text);
  };
  try {
    const plain = await call({ query: "kaucja" });
    assert.deepEqual(plain.emails.map((e) => e.subject), ["Zwrot kaucji"], "one wording finds one mail");
    assert.equal(plain.matchedBy, undefined);

    const fused = await call({ queries: ["kaucja", "deposit", "rental agreement", "Kaution"] });
    const subjects = fused.emails.map((e) => e.subject);
    assert.equal(subjects[0], "Deposit refund", "found by deposit and by rental agreement: first");
    assert.deepEqual([...subjects].sort(), ["Deposit refund", "Rental agreement", "Zwrot kaucji"]);
    assert.ok(!subjects.includes("Lunch"));
    assert.deepEqual(fused.emails[0].matchedBy, ["deposit", "rental agreement"]);
    assert.equal(fused.emails.find((e) => e.subject === "Zwrot kaucji").matchedBy.join(), "kaucja");
    assert.equal(fused.total, 3);
    assert.equal(fused.queries.length, 4);

    const limited = await call({ queries: ["kaucja", "deposit"], limit: 1 });
    assert.equal(limited.emails.length, 1);
    assert.equal(limited.hasMore, true);
    assert.match((await call({ queries: Array.from({ length: 9 }, (_, i) => `q${i}`) })).error, /At most 8 queries/);
  } finally {
    await client.close(); await server.close(); await closeTrackedIndexes(); await bridge.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
