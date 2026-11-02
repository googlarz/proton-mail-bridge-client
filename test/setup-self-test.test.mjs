import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { setupFollowUp } from "../dist/scripts/bridge-self-test.js";
import { buildWizardEnv } from "../dist/scripts/setup-claude-desktop.js";
import { diagnoseConnectionFailure } from "../dist/cli.js";
import { createMessage, makeCertificate, startFakeBridge } from "./helpers/fake-bridge.mjs";

const certificate = makeCertificate();
const needsOpenssl = certificate ? {} : { skip: "openssl is not available to make a test certificate" };

const folders = () => ({
  INBOX: { uidValidity: 7, messages: [createMessage(1), createMessage(2), createMessage(3)] },
});

function envFor(port, password = "bridge-secret") {
  return buildWizardEnv({ username: "owner@example.com", password, imapPort: port, smtpPort: 9, dataDir: "/nonexistent/should-not-be-created" });
}

async function freePort() {
  return await new Promise((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test("setup self-test reports the account and INBOX count, then the next steps", needsOpenssl, async () => {
  const bridge = await startFakeBridge({ folders: folders(), mode: "starttls", certificate, accounts: { "owner@example.com": "bridge-secret" } });
  try {
    const text = await setupFollowUp(envFor(bridge.port), { diagnose: diagnoseConnectionFailure });
    assert.match(text, /Bridge reachable, signed in as owner@example\.com, INBOX has 3 messages\./);
    assert.match(text, /Quit Claude Desktop completely/);
    assert.match(text, /Summarise my unread emails/);
    assert.match(text, /Claude Desktop's own\s+safety check/);
    assert.doesNotMatch(text, /bridge-secret/);
  } finally {
    await bridge.close();
  }
});

test("setup self-test names the Bridge password when the login is refused", needsOpenssl, async () => {
  const bridge = await startFakeBridge({ folders: folders(), mode: "starttls", certificate, accounts: { "owner@example.com": "bridge-secret" } });
  try {
    const text = await setupFollowUp(envFor(bridge.port, "proton-account-password"), { diagnose: diagnoseConnectionFailure });
    assert.match(text, /authentication_failed/);
    assert.match(text, /Bridge password/);
    assert.doesNotMatch(text, /proton-account-password/);
    assert.match(text, /Quit Claude Desktop completely/);
  } finally {
    await bridge.close();
  }
});

test("setup self-test says Bridge is unreachable when nothing listens on the port", async () => {
  const text = await setupFollowUp(envFor(await freePort()), { diagnose: diagnoseConnectionFailure, timeoutMs: 5000 });
  assert.match(text, /bridge_unreachable/);
  assert.match(text, /Bridge is not reachable/);
});

test("setup self-test gives up within its timeout when Bridge never answers", async () => {
  const held = [];
  const silent = net.createServer((socket) => held.push(socket)).listen(0, "127.0.0.1");
  await new Promise((resolve) => silent.once("listening", resolve));
  try {
    const started = Date.now();
    const text = await setupFollowUp(envFor(silent.address().port), { diagnose: diagnoseConnectionFailure, timeoutMs: 500 });
    assert.ok(Date.now() - started < 3000);
    assert.match(text, /Could not reach your mailbox/);
  } finally {
    for (const socket of held) socket.destroy();
    silent.close();
  }
});

test("--no-check skips the self-test and never contacts Bridge", async () => {
  let connections = 0;
  const spy = net.createServer((socket) => { connections += 1; socket.destroy(); }).listen(0, "127.0.0.1");
  await new Promise((resolve) => spy.once("listening", resolve));
  try {
    const text = await setupFollowUp(envFor(spy.address().port), { skipCheck: true });
    assert.doesNotMatch(text, /Checking your mailbox/);
    assert.match(text, /Quit Claude Desktop completely/);
    assert.equal(connections, 0);
  } finally {
    spy.close();
  }
});
