import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildConfigFromEnv, createServer } from "../dist/index.js";
import { parseEmbeddingsEnv } from "../dist/config-env.js";
import { EmbeddingService } from "../dist/services/embedding-service.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";
import { createMessage, makeCertificate, startFakeBridge } from "./helpers/fake-bridge.mjs";

// Semantic search runs against a mock embedding endpoint whose vectors are made up: a few hand-picked words share a
// direction ("deposit", "kaucja", "Kaution", "refund"...), every other word adds a little noise. That proves the
// plumbing (build, storage, fusion, fallbacks), not the quality of any real model.

const certificate = makeCertificate();
const needsOpenssl = certificate ? {} : { skip: "openssl is not available to make a test certificate" };

const CONCEPTS = [
  ["deposit", "kaucja", "kaucji", "kaution", "refund", "zwrot"],
  ["lunch", "pizza", "dinner"],
  ["invoice", "faktura", "rechnung"],
];

function fakeVector(text, dims) {
  const vector = new Array(dims).fill(0);
  for (const word of text.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean)) {
    const concept = CONCEPTS.findIndex((words) => words.includes(word));
    if (concept >= 0) vector[concept] += 1;
    else vector[3 + ([...word].reduce((sum, char) => sum + char.charCodeAt(0), 0) % (dims - 3))] += 0.2;
  }
  return vector;
}

async function startEmbedder() {
  const state = { requests: [], dims: undefined };
  const server = createHttpServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const { model, input } = JSON.parse(body);
      state.requests.push({ path: request.url, model, input });
      const dims = state.dims ?? (model === "fake-24" ? 24 : 16);
      const vectors = input.map((text) => fakeVector(text, dims));
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/embed") response.end(JSON.stringify({ model, embeddings: vectors }));
      // Out of order on purpose: the index field says which input each vector belongs to.
      else if (request.url === "/v1/embeddings") response.end(JSON.stringify({ data: vectors.map((embedding, index) => ({ index, embedding })).reverse() }));
      else { response.statusCode = 404; response.end("{}"); }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { state, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

const MESSAGES = [
  createMessage(1, { subject: "Zwrot kaucji", body: "Dzień dobry, kaucja zostanie zwrócona w tym tygodniu.\r\n" }),
  createMessage(2, { subject: "Rental agreement", body: "Your deposit and the rental terms are attached.\r\n" }),
  createMessage(3, { subject: "Deposit refund", body: "The deposit of the flat will be refunded this week.\r\n" }),
  createMessage(4, { subject: "Lunch", body: "Pizza on Friday?\r\n" }),
];

async function startServer(dir, bridge, embeddings) {
  const conn = { imap: { host: "127.0.0.1", port: bridge.port, secure: false, username: "owner@example.com", password: "secret" }, smtp: { host: "127.0.0.1", port: 9, secure: false, username: "owner@example.com", password: "secret" } };
  const config = {
    ...conn, dataDir: dir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: "owner@example.com", slug: "owner-example-com", ...conn, dataDir: dir }],
    runtime: { readOnly: true, allowSend: false, allowRemoteDraftSync: false, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 50, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: true, allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0, ...(embeddings ? { embeddings } : {}) },
  };
  const { server } = createServer(config, { startBackgroundSync: false });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content.find((c) => c.type === "text").text;
    return result.isError ? { error: text } : JSON.parse(text);
  };
  const search = (args) => call("search_indexed_emails", args);
  const embeddingsStatus = async () => (await call("get_index_status")).embeddings;
  const waitFor = async (check, label) => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const status = await embeddingsStatus();
      if (check(status)) return status;
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}: ${JSON.stringify(status)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const close = async () => { await client.close(); await server.close(); await closeTrackedIndexes(); };
  return { search, embeddingsStatus, waitFor, close };
}

const builtAll = (dims) => (status) => status.vectors === MESSAGES.length && status.pending === 0 && !status.building && (dims === undefined || status.dimensions === dims);
const subjects = (result) => result.emails.map((email) => email.subject);

async function withSetup(prefix, fn) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const bridge = await startFakeBridge({ mode: "starttls", certificate, folders: { INBOX: { uidValidity: 1, messages: MESSAGES } } });
  const embedder = await startEmbedder();
  try {
    await fn({ dir, bridge, embedder });
  } finally {
    await closeTrackedIndexes();
    await bridge.close();
    await embedder.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("unset PROTONMAIL_EMBEDDINGS_URL: nothing runs, no file, the search result is the plain one", needsOpenssl, async () => {
  await withSetup("semantic-inert-", async ({ dir, bridge, embedder }) => {
    const app = await startServer(dir, bridge, undefined);
    try {
      const plain = await app.search({ query: "deposit" });
      assert.deepEqual(subjects(plain).sort(), ["Deposit refund", "Rental agreement"]);
      assert.equal(plain.mode, undefined);
      assert.equal(plain.semanticNotes, undefined);
      assert.ok(plain.emails.every((email) => email.similarity === undefined));
      assert.deepEqual(await app.embeddingsStatus(), { configured: false });

      const asked = await app.search({ query: "deposit", mode: "semantic" });
      assert.equal(asked.mode, "lexical");
      assert.match(asked.semanticNotes[0], /not set up/);
      assert.deepEqual(subjects(asked).sort(), ["Deposit refund", "Rental agreement"]);
      assert.match((await app.search({ query: "deposit", mode: "fuzzy" })).error, /mode must be/);

      assert.equal(embedder.state.requests.length, 0);
      assert.deepEqual((await readdir(dir)).filter((name) => name.includes("embeddings")), []);
    } finally {
      await app.close();
    }
  });
});

test("a non-loopback embedding endpoint is refused unless PROTONMAIL_EMBEDDINGS_ALLOW_REMOTE=true", needsOpenssl, async () => {
  const keys = ["PROTONMAIL_EMBEDDINGS_URL", "PROTONMAIL_EMBEDDINGS_MODEL", "PROTONMAIL_EMBEDDINGS_ALLOW_REMOTE", "PROTONMAIL_USERNAME", "PROTONMAIL_PASSWORD"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(parseEmbeddingsEnv(), undefined);

    process.env.PROTONMAIL_EMBEDDINGS_URL = "http://embeddings.example.com/api/embed";
    assert.throws(() => parseEmbeddingsEnv(), /embeddings\.example\.com, which is not this computer.*mail text would leave this machine.*PROTONMAIL_EMBEDDINGS_ALLOW_REMOTE=true/s);
    process.env.PROTONMAIL_USERNAME = "owner@example.com";
    process.env.PROTONMAIL_PASSWORD = "test-password";
    assert.throws(() => buildConfigFromEnv(), /mail text would leave this machine/, "refused at startup, not later");
    process.env.PROTONMAIL_EMBEDDINGS_URL = "http://10.0.0.5:11434/api/embed";
    assert.throws(() => parseEmbeddingsEnv(), /would leave this machine/);

    process.env.PROTONMAIL_EMBEDDINGS_ALLOW_REMOTE = "true";
    assert.deepEqual(parseEmbeddingsEnv(), { url: "http://10.0.0.5:11434/api/embed", api: "ollama", model: "nomic-embed-text", allowRemote: true });
    delete process.env.PROTONMAIL_EMBEDDINGS_ALLOW_REMOTE;

    process.env.PROTONMAIL_EMBEDDINGS_MODEL = "bge-m3";
    for (const [url, api] of [["http://localhost:11434/api/embed", "ollama"], ["http://127.0.0.1:8080/v1/embeddings", "openai"], ["http://[::1]:11434/api/embed/", "ollama"]]) {
      process.env.PROTONMAIL_EMBEDDINGS_URL = url;
      const parsed = parseEmbeddingsEnv();
      assert.equal(parsed.api, api, url);
      assert.equal(parsed.model, "bge-m3");
    }
    assert.equal(buildConfigFromEnv().runtime.embeddings.api, "ollama");
    process.env.PROTONMAIL_EMBEDDINGS_URL = "http://127.0.0.1:11434/";
    assert.throws(() => parseEmbeddingsEnv(), /must end with \/api\/embed \(Ollama\) or \/v1\/embeddings/);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }

  // A configuration built without the env check is refused by the service too: no request is ever made.
  await withSetup("semantic-remote-", async ({ dir, bridge }) => {
    const app = await startServer(dir, bridge, { url: "http://192.0.2.10/api/embed", api: "ollama", model: "fake-16", allowRemote: false });
    try {
      const result = await app.search({ query: "deposit" });
      assert.equal(result.mode, "lexical");
      assert.match(result.semanticNotes[0], /would leave this machine/);
      const status = await app.embeddingsStatus();
      assert.equal(status.vectors, 0);
      assert.equal(status.building, false);
      assert.match(status.lastError, /would leave this machine/);
    } finally {
      await app.close();
    }
  });
});

test("vectors are built in the background; hybrid finds a message that shares no word with the query", needsOpenssl, async () => {
  await withSetup("semantic-hybrid-", async ({ dir, bridge, embedder }) => {
    const app = await startServer(dir, bridge, { url: `http://127.0.0.1:${embedder.port}/api/embed`, api: "ollama", model: "fake-16", allowRemote: false });
    try {
      await app.search({ query: "deposit" });
      const status = await app.waitFor(builtAll(16), "the first build");
      assert.equal(status.model, "fake-16");
      assert.equal(status.configured, true);
      assert.ok((await readFile(join(dir, "mail-embeddings.bin"))).subarray(0, 8).toString("latin1") === "PMEMB01\n");
      const sent = embedder.state.requests.find((request) => request.input.length === MESSAGES.length);
      assert.ok(sent.input.some((text) => text.startsWith("Zwrot kaucji\nFrom: Alice <alice@example.com>\nDzień dobry")), "subject, sender, start of the text");

      const lexical = await app.search({ query: "deposit", mode: "lexical" });
      assert.equal(lexical.mode, undefined);
      assert.ok(!subjects(lexical).includes("Zwrot kaucji"), "words alone do not find it");

      const hybrid = await app.search({ query: "deposit" });
      assert.equal(hybrid.mode, "hybrid", "the default once vectors exist");
      const order = subjects(hybrid);
      assert.equal(order[0], "Deposit refund", "found by words and by meaning");
      assert.ok(order.indexOf("Zwrot kaucji") >= 0 && order.indexOf("Zwrot kaucji") < order.indexOf("Lunch"));
      assert.ok(hybrid.emails.find((email) => email.subject === "Zwrot kaucji").similarity > 0.8);
      assert.equal(hybrid.semanticNotes, undefined);

      const semantic = await app.search({ query: "deposit", mode: "semantic" });
      assert.equal(semantic.mode, "semantic");
      assert.deepEqual(subjects(semantic).slice(0, 2).sort(), ["Deposit refund", "Zwrot kaucji"]);
      assert.equal(subjects(semantic).at(-1), "Lunch");
      assert.ok(semantic.emails.at(-1).similarity < 0.3);
      assert.deepEqual(subjects(await app.search({ query: "deposit", mode: "semantic", subject: "Zwrot" })), ["Zwrot kaucji"], "filters still apply");
      assert.deepEqual(subjects(await app.search({ query: "subject:lunch deposit", mode: "semantic" })), ["Lunch"], "so do shortcuts in the query");
      const filtersOnly = await app.search({ subject: "Lunch" });
      assert.deepEqual([filtersOnly.mode, filtersOnly.semanticNotes, subjects(filtersOnly)], ["lexical", undefined, ["Lunch"]], "nothing to compare, nothing to say");

      const several = await app.search({ queries: ["deposit", "Kaution"] });
      assert.equal(several.mode, "hybrid");
      assert.deepEqual(several.queries, ["deposit", "Kaution"]);
      assert.deepEqual(several.emails.find((email) => email.subject === "Zwrot kaucji").matchedBy, [], "found by meaning only");

      // The model behind the same name now gives other dimensions: words only until the vectors are rebuilt.
      embedder.state.dims = 24;
      const mismatch = await app.search({ query: "deposit" });
      assert.equal(mismatch.mode, "lexical");
      assert.match(mismatch.semanticNotes[0], /24-dimensional vectors but the stored ones have 16/);
      await app.waitFor(builtAll(24), "the rebuild with 24 dimensions");
      assert.equal((await app.search({ query: "deposit" })).mode, "hybrid");

      // The endpoint goes away: words only, with a note, and no error.
      await embedder.close();
      const down = await app.search({ query: "deposit" });
      assert.equal(down.error, undefined);
      assert.equal(down.mode, "lexical");
      assert.match(down.semanticNotes[0], /unavailable \(the embedding endpoint http:\/\/127\.0\.0\.1:\d+\/api\/embed did not answer/);
      assert.deepEqual(subjects(down).sort(), ["Deposit refund", "Rental agreement"]);
    } finally {
      await app.close();
    }
  });
});

test("an endpoint that is down from the start: words only with a note, the build error in the status", needsOpenssl, async () => {
  await withSetup("semantic-down-", async ({ dir, bridge, embedder }) => {
    await embedder.close();
    const app = await startServer(dir, bridge, { url: `http://127.0.0.1:${embedder.port}/api/embed`, api: "ollama", model: "fake-16", allowRemote: false });
    try {
      const first = await app.search({ query: "deposit" });
      assert.equal(first.mode, "lexical");
      assert.equal(first.semanticNotes.length, 1);
      assert.deepEqual(subjects(first).sort(), ["Deposit refund", "Rental agreement"]);
      const status = await app.waitFor((s) => !s.building && /did not answer/.test(s.lastError ?? ""), "the failed build");
      assert.equal(status.vectors, 0);
      assert.equal(status.pending, MESSAGES.length);
      const hybrid = await app.search({ query: "deposit", mode: "hybrid" });
      assert.equal(hybrid.mode, "lexical");
      assert.match(hybrid.semanticNotes[0], /Semantic search is unavailable \(the embedding endpoint .* did not answer/);
      assert.deepEqual((await readdir(dir)).filter((name) => name === "mail-embeddings.bin"), [], "nothing written without a vector");
    } finally {
      await app.close();
    }
  });
});

test("a corrupt or cut-off sidecar is rebuilt, and a new model replaces the vectors (OpenAI-compatible endpoint)", needsOpenssl, async () => {
  await withSetup("semantic-corrupt-", async ({ dir, bridge, embedder }) => {
    const sidecar = join(dir, "mail-embeddings.bin");
    const url = `http://127.0.0.1:${embedder.port}/v1/embeddings`;
    await writeFile(sidecar, "this is not an embeddings file");
    let app = await startServer(dir, bridge, { url, api: "openai", model: "fake-16", allowRemote: false });
    try {
      const result = await app.search({ query: "deposit" });
      assert.equal(result.error, undefined);
      await app.waitFor(builtAll(16), "the rebuild over garbage");
      assert.ok(embedder.state.requests.every((request) => request.path === "/v1/embeddings" && request.model === "fake-16"));
      assert.ok(subjects(await app.search({ query: "deposit", mode: "semantic" })).slice(0, 2).includes("Zwrot kaucji"), "vectors matched to the right messages despite the shuffled answer");
    } finally {
      await app.close();
    }

    const whole = await readFile(sidecar);
    await writeFile(sidecar, whole.subarray(0, Math.floor(whole.length / 2)));
    app = await startServer(dir, bridge, { url, api: "openai", model: "fake-16", allowRemote: false });
    try {
      await app.waitFor(builtAll(16), "the rebuild over a cut-off file");
    } finally {
      await app.close();
    }

    app = await startServer(dir, bridge, { url, api: "openai", model: "fake-24", allowRemote: false });
    try {
      const status = await app.embeddingsStatus();
      assert.equal(status.model, "fake-24");
      assert.ok(status.vectors === 0 || status.dimensions === 24, "vectors of the old model do not count");
      await app.waitFor(builtAll(24), "the rebuild for the new model");
      assert.equal((await app.search({ query: "deposit" })).mode, "hybrid");
    } finally {
      await app.close();
    }
  });
});

test("only the newest messages get a vector, and the status says so", async () => {
  const embedder = await startEmbedder();
  const dir = await mkdtemp(join(tmpdir(), "semantic-cap-"));
  const sources = Array.from({ length: 5 }, (_, index) => ({ key: `<m${index}@x>`, subject: index === 0 ? "deposit" : `note ${index}`, from: [], preview: "" }));
  const index = {
    listEmbeddingSources: async (limit) => sources.slice(0, limit),
    getEmailsByKeys: async (keys) => keys.map((key) => ({ id: `INBOX::${key}`, messageId: key, subject: sources.find((source) => source.key === key).subject })),
  };
  try {
    const service = new EmbeddingService({ url: `http://127.0.0.1:${embedder.port}/api/embed`, api: "ollama", model: "fake-16", allowRemote: false }, dir, index, undefined, 3);
    service.ensureBuilding();
    await service.idle();
    const coverage = await service.coverage();
    assert.deepEqual({ covered: coverage.covered, pending: coverage.pending, capped: coverage.capped }, { covered: 3, pending: 0, capped: true });
    const status = await service.status();
    assert.equal(status.corpusLimit, 3);
    assert.match(status.note, /Only the newest 3 messages get a vector/);
    assert.equal(embedder.state.requests.reduce((sum, request) => sum + request.input.length, 0), 3, "the older two were never sent");
    const [query] = await service.embed(["kaution"]);
    assert.equal((await service.rank(query, 2, {}))[0].subject, "deposit");
  } finally {
    await embedder.close();
    await rm(dir, { recursive: true, force: true });
  }
});
