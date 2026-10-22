import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { buildProfile, styleHints, summarise } from "../dist/utils/style-profile.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";
import { createMessage, makeCertificate, startFakeBridge } from "./helpers/fake-bridge.mjs";

const polish = (name) => ({ to: ["pat@client.example"], text: `Dzień dobry ${name},\n\nDziękuję za wiadomość. Proszę o przesłanie umowy, to jest dla nas ważne i nie chcemy tego opóźniać.\n\nPozdrawiam\nDawid\n` });
const english = (name) => ({ to: ["friend@gmail.com"], text: `Hi ${name},\n\nThanks for the note, I will send the file and you can check it with the team for sure!\n\nCheers\nDawid\n` });

test("greeting, closing, language and tone are read from sent mail, without keeping names", () => {
  const samples = [polish("Pat"), polish("Anna"), polish("Marek"), english("Sam"), english("Lee")];
  const summary = summarise(samples);
  assert.equal(summary.messages, 5);
  assert.equal(summary.languages[0].text, "pl");
  assert.deepEqual(summary.greetings[0], { text: "Dzień dobry {name},", count: 3 });
  assert.deepEqual(summary.closings.map((c) => c.text).sort(), ["Cheers", "Pozdrawiam"]);
  assert.equal(summary.formality, "mixed");
  assert.equal(summary.exclamationRate, 0.4);
  assert.ok(!JSON.stringify(summary).match(/Pat|Anna|Marek|Sam|Lee/), "no names in the profile");
});

test("hints follow the recipient: a company's habits, a person's, or the overall ones", () => {
  const samples = [polish("Pat"), polish("Anna"), polish("Marek"), english("Sam"), english("Lee")];
  const profile = buildProfile(samples, new Date("2026-10-22T10:00:00Z"));
  assert.ok(profile.byRecipient["pat@client.example"], "three mails to the same person");
  assert.ok(profile.byDomain["client.example"]);
  assert.ok(!profile.byDomain["gmail.com"], "a free mail provider is not a company");
  const forPat = styleHints(profile, "pat@client.example");
  assert.match(forPat.join(" "), /in Polish/);
  assert.match(forPat.join(" "), /Dzień dobry \{name\},/);
  assert.match(forPat.join(" "), /Tone is formal/);
  const forUnknown = styleHints(profile, "new@elsewhere.example");
  assert.match(forUnknown[0], /You mostly write in Polish/);
  assert.deepEqual(styleHints(buildProfile([])), []);
});

const certificate = makeCertificate();
const needsOpenssl = certificate ? {} : { skip: "openssl is not available to make a test certificate" };

test("get_style_profile builds from the Sent folder, caches the profile and rebuilds on request", needsOpenssl, async () => {
  const dir = await mkdtemp(join(tmpdir(), "style-"));
  const sent = (uid, body, to) => createMessage(uid, { subject: `Re: ${uid}`, from: "owner@example.com", to, flags: ["\\Seen"], body });
  const bridge = await startFakeBridge({
    mode: "starttls", certificate,
    folders: {
      INBOX: { uidValidity: 1, messages: [] },
      Sent: { uidValidity: 2, specialUse: "\\Sent", messages: [
        sent(1, polish("Pat").text, "pat@client.example"), sent(2, polish("Pat").text, "pat@client.example"), sent(3, english("Sam").text, "sam@elsewhere.example"),
      ] },
    },
  });
  const conn = { imap: { host: "127.0.0.1", port: bridge.port, secure: false, username: "owner@example.com", password: "secret" }, smtp: { host: "127.0.0.1", port: 9, secure: false, username: "owner@example.com", password: "secret" } };
  const config = {
    ...conn, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: "owner@example.com", slug: "owner-example-com", ...conn, dataDir: dir }],
    runtime: { readOnly: true, allowSend: false, allowRemoteDraftSync: false, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX,Sent", autoSyncFull: false, autoSyncLimitPerFolder: 50, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: true, allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0 },
  };
  const { server } = createServer(config, { startBackgroundSync: false });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (args) => {
    const result = await client.callTool({ name: "get_style_profile", arguments: args });
    assert.ok(!result.isError, result.content?.[0]?.text);
    return JSON.parse(result.content.find((c) => c.type === "text").text);
  };
  try {
    const first = await call({ recipient: "pat@client.example" });
    assert.equal(first.rebuilt, true);
    assert.equal(first.basedOn, 3);
    assert.match(first.hints.join(" "), /to pat@client.example in Polish/);
    const cached = await call({});
    assert.equal(cached.rebuilt, false, "the second call uses the cache");
    const refreshed = await call({ refresh: true });
    assert.equal(refreshed.rebuilt, true);
    const onDisk = await readFile(join(dir, "style-profile.json"), "utf8");
    assert.ok(!/Pat\b|Sam\b/.test(onDisk.replace(/pat@client|sam@elsewhere/g, "")), "no names on disk");
  } finally {
    await client.close(); await server.close(); await closeTrackedIndexes(); await bridge.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
