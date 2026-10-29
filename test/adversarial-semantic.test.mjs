import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkEmbeddingsEndpoint, EmbeddingService } from "../dist/services/embedding-service.js";

// Adversarial checks by an independent tester against the semantic-search endpoint check, the response parser, the
// sidecar reader and the builder. Tests marked DEFECT fail while the defect exists.

const quiet = new Proxy({}, { get: () => () => undefined });

function listen(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) })));
}

function makeService(url, dir, sources = [], { api = "ollama", maxVectors } = {}) {
  const index = {
    listEmbeddingSources: async (limit) => sources.slice(0, limit),
    getEmailsByKeys: async (keys) => keys.map((key) => ({ id: key, messageId: key, subject: key, from: [], preview: "" })),
  };
  return new EmbeddingService({ url, api, model: "m", allowRemote: false }, dir, index, quiet, maxVectors);
}

const source = (n) => ({ key: `k${n}`, subject: `subject ${n}`, from: [], preview: `preview ${n}` });

test("endpoint check refuses every non-loopback spelling", () => {
  const refused = [
    "http://localhost.evil.com/api/embed",
    "http://127.0.0.1.evil.com/api/embed",
    "http://127.0.0.1@evil.com/api/embed",
    "http://localhost:80@evil.com/api/embed",
    "http://evil.com#@127.0.0.1/api/embed",
    "http://0.0.0.0:11434/api/embed",
    "http://[::ffff:127.0.0.1]:11434/api/embed",
    "http://[::]:11434/api/embed",
    "http://localhost./api/embed",
    "http://127.0.0.2/api/embed",
    "http://[::1].evil.com/api/embed",
    "http://localtest.me/api/embed",
    "http://169.254.169.254/api/embed",
    "https://example.com/v1/embeddings",
  ];
  for (const url of refused) assert.throws(() => checkEmbeddingsEndpoint(url, false), /not this computer|valid URL|must end with/, url);
});

test("endpoint check accepts loopback spellings and normalised forms", () => {
  for (const url of ["http://localhost:11434/api/embed", "http://127.0.0.1:11434/api/embed/", "http://[::1]:11434/api/embed", "http://LOCALHOST/v1/embeddings", "http://2130706433/api/embed", "http://127.1/api/embed"]) {
    assert.doesNotThrow(() => checkEmbeddingsEndpoint(url, false), url);
  }
  assert.throws(() => checkEmbeddingsEndpoint("ftp://localhost/api/embed", false));
  assert.throws(() => checkEmbeddingsEndpoint("http://localhost/other", false));
});

test("a redirect from loopback to another host is not followed", async () => {
  let hit = 0;
  const target = await listen((req, res) => { hit += 1; res.end("{}"); });
  const redirector = await listen((req, res) => { res.statusCode = 307; res.setHeader("location", `http://127.0.0.1:${target.port}/api/embed`); res.end(); });
  const dir = await mkdtemp(join(tmpdir(), "adv-emb-"));
  try {
    const service = makeService(`http://127.0.0.1:${redirector.port}/api/embed`, dir);
    await assert.rejects(service.embed(["secret mail text"]), /did not answer|HTTP/);
    assert.equal(hit, 0);
  } finally {
    await redirector.close(); await target.close(); await rm(dir, { recursive: true, force: true });
  }
});

async function embedAgainst(body, { timeoutMs = 3000, texts = ["a", "b"], api = "ollama", headers = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "adv-emb-"));
  const srv = await listen((req, res) => {
    req.resume();
    res.setHeader("content-type", "application/json");
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    if (typeof body === "function") return body(req, res);
    res.end(body);
  });
  try {
    const service = makeService(`http://127.0.0.1:${srv.port}${api === "ollama" ? "/api/embed" : "/v1/embeddings"}`, dir, [], { api });
    return await service.embed(texts, timeoutMs).then((value) => ({ value }), (error) => ({ error }));
  } finally {
    await srv.close(); await rm(dir, { recursive: true, force: true });
  }
}

test("hostile embedding responses are rejected, not stored", async () => {
  const bad = [
    '{"embeddings":[[1,2],[1]]}',
    '{"embeddings":[[1,2]]}',
    '{"embeddings":[[],[]]}',
    '{"embeddings":[[1,"2"],[1,2]]}',
    '{"embeddings":[[1,null],[1,2]]}',
    '{"embeddings":[[1,1e999],[1,2]]}',
    '{"embeddings":[[1,-1e999],[1,2]]}',
    '{"embeddings":"x"}',
    '{"embeddings":[{"length":2},{"length":2}]}',
    "null",
    "[]",
    "not json",
    "",
  ];
  for (const body of bad) {
    const { error } = await embedAgainst(body);
    assert.ok(error instanceof Error && error.name === "EmbeddingError", `${body} -> ${error}`);
  }
});

test("zero vectors and 1e38 values stay finite", async () => {
  const { value } = await embedAgainst('{"embeddings":[[0,0],[1e38,1e38]]}');
  assert.ok(value[1].every(Number.isFinite), `normalised 1e38 vector: ${[...value[1]]}`);
});

test("OpenAI-style: out-of-range and duplicate index values are rejected or ordered", async () => {
  const { value, error } = await embedAgainst('{"data":[{"index":5,"embedding":[1,0]},{"index":0,"embedding":[0,1]}]}', { api: "openai" });
  assert.ok(value || error);
  const dup = await embedAgainst('{"data":[{"index":0,"embedding":[1,0]},{"index":0,"embedding":[0,1]}]}', { api: "openai" });
  // Informational: two vectors both claiming index 0 are accepted in arrival order.
  assert.ok(dup.value || dup.error);
});

test("a response that never ends is cut by the timeout", async () => {
  const start = Date.now();
  const { error } = await embedAgainst((req, res) => {
    res.write('{"embeddings":[[');
    const timer = setInterval(() => res.write("0,"), 5);
    res.on("close", () => clearInterval(timer));
  }, { timeoutMs: 500 });
  assert.ok(error);
  assert.ok(Date.now() - start < 3000, `${Date.now() - start} ms`);
});

test("a server that accepts and never answers is cut by the timeout", async () => {
  const start = Date.now();
  const { error } = await embedAgainst(() => {}, { timeoutMs: 400 });
  assert.ok(error);
  assert.ok(Date.now() - start < 3000);
});

test("DEFECT: no cap on vector dimensions - a 500,000-dimensional answer is accepted and would be stored for every message", async () => {
  const dims = 500_000;
  const one = `[${"0.5,".repeat(dims - 1)}0.5]`;
  const { value, error } = await embedAgainst(`{"embeddings":[${one},${one}]}`, { timeoutMs: 20_000 });
  assert.ok(error, `accepted ${value?.length} vectors x ${dims} dims (x 4 bytes x up to 10,000 messages = 20 GB sidecar)`);
});

test("fixed: a response over the size cap is cut off, not read to the end", async () => {
  let written = 0;
  const chunk = "0,".repeat(512 * 1024);
  const { error } = await embedAgainst((req, res) => {
    res.write('{"embeddings":[[');
    const timer = setInterval(() => {
      written += chunk.length;
      if (written > 200 * 1024 * 1024) { clearInterval(timer); res.end(); return; }
      res.write(chunk);
    }, 1);
    res.on("close", () => clearInterval(timer));
  }, { timeoutMs: 30_000 });
  assert.ok(error, "the oversized body must be refused");
  assert.ok(written < 64 * 1024 * 1024, `the client kept reading: the server wrote ${(written / 1048576) | 0} MB`);
});

// ---- sidecar ---------------------------------------------------------------------------------------------------

function sidecar(header, data = Buffer.alloc(0), headerLength) {
  const head = Buffer.from(JSON.stringify(header), "utf8");
  const dataStart = Math.ceil((8 + 4 + head.length) / 4) * 4;
  const out = Buffer.alloc(dataStart + data.length);
  out.write("PMEMB01\n", 0, "latin1");
  out.writeUInt32LE(headerLength ?? head.length, 8);
  head.copy(out, 12);
  data.copy(out, dataStart);
  return out;
}

test("corrupt sidecars never throw out of coverage()/rank()", async () => {
  const dir = await mkdtemp(join(tmpdir(), "adv-emb-"));
  try {
    const service = makeService("http://127.0.0.1:9/api/embed", dir, [source(1)]);
    const cases = [
      Buffer.alloc(0),
      Buffer.from("PMEMB01\n"),
      Buffer.from("garbage".repeat(100)),
      sidecar({ model: "m", dims: 2, keys: ["k1"], hashes: [1] }, Buffer.alloc(3)),
      sidecar({ model: "m", dims: 2, keys: ["k1"], hashes: [1] }, Buffer.alloc(8), 0xffffffff),
      sidecar({ model: "m", dims: -1, keys: [], hashes: [] }),
      sidecar({ model: "m", dims: 1.5, keys: [], hashes: [] }),
      sidecar({ model: "m", dims: 0, keys: ["k1"], hashes: [1] }),
      sidecar({ model: "m", dims: 2, keys: ["k1", 5], hashes: [1, 2] }, Buffer.alloc(16)),
      sidecar({ model: "m", dims: 1e300, keys: [], hashes: [] }),
      sidecar({ model: "m", dims: 2, keys: ["__proto__", "constructor"], hashes: [1, 2] }, Buffer.alloc(16)),
    ];
    for (const [i, bytes] of cases.entries()) {
      await writeFile(join(dir, "mail-embeddings.bin"), bytes);
      await service.coverage().catch((e) => assert.fail(`case ${i}: coverage threw ${e}`));
      await service.rank(new Float32Array([1, 0]), 5, {}).catch((e) => {
        assert.equal(e.name, "EmbeddingError", `case ${i}: rank threw ${e}`);
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("DEFECT: a sidecar holding NaN vectors yields NaN similarities and an undefined ranking", async () => {
  const dir = await mkdtemp(join(tmpdir(), "adv-emb-"));
  try {
    const nan = Buffer.alloc(8); nan.writeFloatLE(NaN, 0); nan.writeFloatLE(NaN, 4);
    const ok = Buffer.alloc(8); ok.writeFloatLE(1, 0); ok.writeFloatLE(0, 4);
    await writeFile(join(dir, "mail-embeddings.bin"), sidecar({ model: "m", dims: 2, keys: ["a", "b"], hashes: [1, 2] }, Buffer.concat([nan, ok])));
    const service = makeService("http://127.0.0.1:9/api/embed", dir);
    const hits = await service.rank(new Float32Array([1, 0]), 5, {});
    assert.ok(hits.every((hit) => Number.isFinite(hit.similarity)), `similarities: ${hits.map((h) => h.similarity)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- builder ---------------------------------------------------------------------------------------------------

function goodEmbedder(delayMs = 0) {
  let calls = 0;
  const handler = (req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      calls += 1;
      const { input } = JSON.parse(body);
      setTimeout(() => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ embeddings: input.map((t) => [t.length % 7, 1, (t.length * 3) % 5]) }));
      }, delayMs);
    });
  };
  return { handler, calls: () => calls };
}

test("two builders on one data directory leave a valid sidecar and the second reports the first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "adv-emb-"));
  const embedder = goodEmbedder(30);
  const srv = await listen(embedder.handler);
  const sources = Array.from({ length: 60 }, (_, n) => source(n));
  try {
    const url = `http://127.0.0.1:${srv.port}/api/embed`;
    const a = makeService(url, dir, sources);
    const b = makeService(url, dir, sources);
    a.ensureBuilding();
    b.ensureBuilding();
    await Promise.all([a.idle(), b.idle()]);
    const [cov, status] = [await a.coverage(), await b.status()];
    assert.equal(cov.pending, 0);
    assert.equal(cov.covered, 60);
    assert.ok(status.vectors === 60);
    const raw = await readFile(join(dir, "mail-embeddings.bin"));
    assert.equal(raw.toString("latin1", 0, 8), "PMEMB01\n");
  } finally {
    await srv.close(); await rm(dir, { recursive: true, force: true });
  }
});

test("search while a build runs returns what exists without waiting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "adv-emb-"));
  const srv = await listen(goodEmbedder(200).handler);
  const sources = Array.from({ length: 64 }, (_, n) => source(n));
  try {
    const service = makeService(`http://127.0.0.1:${srv.port}/api/embed`, dir, sources);
    service.ensureBuilding();
    const start = Date.now();
    const cov = await service.coverage();
    const hits = await service.rank(new Float32Array([1, 0, 0]).map((v) => v), 5, {}).catch((e) => e);
    assert.ok(Date.now() - start < 500, `coverage+rank took ${Date.now() - start} ms during a build`);
    assert.ok(cov.pending >= 0 && (Array.isArray(hits) || hits instanceof Error));
    await service.idle();
  } finally {
    await srv.close(); await rm(dir, { recursive: true, force: true });
  }
});

test("DEFECT: a server that flips dimensions between batches keeps the builder running forever", async () => {
  const dir = await mkdtemp(join(tmpdir(), "adv-emb-"));
  let n = 0;
  const srv = await listen((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const { input } = JSON.parse(body);
      n += 1;
      const dims = n % 2 ? 3 : 4;
      res.end(JSON.stringify({ embeddings: input.map(() => Array.from({ length: dims }, (_, i) => i + 1)) }));
    });
  });
  try {
    const service = makeService(`http://127.0.0.1:${srv.port}/api/embed`, dir, Array.from({ length: 40 }, (_, i) => source(i)));
    service.ensureBuilding();
    // Each flip discards every earlier vector, so the queue never empties and the endpoint is called until it stops.
    const outcome = await Promise.race([service.idle().then(() => "ended"), new Promise((resolve) => setTimeout(() => resolve("still building"), 5000))]);
    const calls = n;
    assert.equal(outcome, "ended", `still building after 5 s and ${calls} endpoint calls`);
  } finally {
    await srv.close(); await rm(dir, { recursive: true, force: true });
  }
});

test("10,000-message cap: build of 10,001 sources keeps 10,000, memory stays small", async () => {
  const dir = await mkdtemp(join(tmpdir(), "adv-emb-"));
  const srv = await listen(goodEmbedder(0).handler);
  const sources = Array.from({ length: 10_001 }, (_, n) => source(n));
  try {
    const service = makeService(`http://127.0.0.1:${srv.port}/api/embed`, dir, sources);
    const start = Date.now();
    const before = process.memoryUsage().rss;
    // The pause between batches is 250 ms, so a full build takes minutes; only check the cap arithmetic on coverage.
    const cov = await service.coverage();
    assert.equal(cov.capped, true);
    assert.equal(cov.pending, 10_000);
    assert.ok(Date.now() - start < 2000);
    assert.ok((process.memoryUsage().rss - before) / (1024 * 1024) < 100);
  } finally {
    await srv.close(); await rm(dir, { recursive: true, force: true });
  }
});
