// Child process used by test/delegation-grants.test.mjs: another server process on the same data directory spending a grant.
//   claim <dataDir> <attempts>                 spend uses of the grant that covers send_email to bob@example.com, all at once
//   send  <dataDir> <attempts> <sendsFile>     run a whole server (delegation on) and call send_email that many times, all at once;
//                                              every send that reaches "SMTP" appends a line to <sendsFile>
// It prints one JSON line: how many were claimed / sent and how many were refused.
import { appendFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../dist/index.js";
import { GrantService } from "../../dist/services/grant-service.js";

const [, , mode, dataDir, attemptsText, sendsFile] = process.argv;
const attempts = Number(attemptsText);
const ADDRESS = "owner@example.com";

if (mode === "claim") {
  const grants = new GrantService({ dataDir, smtp: { username: ADDRESS } }, ADDRESS);
  const results = await Promise.all(Array.from({ length: attempts }, () => grants.claim({ tool: "send_email", recipients: ["bob@example.com"] })));
  console.log(JSON.stringify({ claimed: results.filter(Boolean).length, refused: results.filter((r) => !r).length }));
  process.exit(0);
}

const conn = { host: "127.0.0.1", port: 9, secure: false, username: ADDRESS, password: "x" };
const config = {
  smtp: conn, imap: conn, dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
  accounts: [{ address: ADDRESS, slug: "owner-example-com", imap: conn, smtp: conn, dataDir }],
  runtime: {
    readOnly: false, allowSend: true, allowRemoteDraftSync: false, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX",
    autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: true,
    allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0, delegation: "on",
  },
};
const { server, accountManager } = createServer(config, { startBackgroundSync: false });
accountManager.primary().smtpService.sendEmail = async (payload) => {
  await appendFile(sendsFile, `${payload.to.join(",")}\n`);
  return { messageId: "<m@example.com>", accepted: payload.to, rejected: [], response: "250" };
};
const client = new Client({ name: "child", version: "0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);
const results = await Promise.all(
  Array.from({ length: attempts }, () => client.callTool({ name: "send_email", arguments: { to: "bob@example.com", subject: "s", body: "b" } })),
);
console.log(JSON.stringify({ sent: results.filter((r) => !r.isError).length, refused: results.filter((r) => r.isError).length }));
process.exit(0);
