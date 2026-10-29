import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EmbeddingService, MAX_DIMENSIONS, MAX_RESPONSE_BYTES } from "../dist/services/embedding-service.js";

const quiet = new Proxy({}, { get: () => () => undefined });

function listen(handler) {
  const server = createServer(handler);
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(done);
          }),
      }),
    ),
  );
}

function makeService(url, dir, sources = []) {
  const index = {
    listEmbeddingSources: async (limit) => sources.slice(0, limit),
    getEmailsByKeys: async (keys) => keys.map((key) => ({ id: key, messageId: key, subject: key, from: [], preview: "" })),
  };
  return new EmbeddingService({ url, api: "ollama", model: "m", allowRemote: false }, dir, index, quiet);
}

const source = (n) => ({ key: `k${n}`, subject: `subject ${n}`, from: [], preview: `preview ${n}` });

async function embedAgainst(body, { headers = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "emb-limits-"));
  const srv = await listen((req, res) => {
    req.resume();
    res.setHeader("content-type", "application/json");
    for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
    if (typeof body === "function") return body(req, res);
    res.end(body);
  });
  try {
    const service = makeService(`http://127.0.0.1:${srv.port}/api/embed`, dir);
    return await service.embed(["a", "b"], 20_000).then((value) => ({ value }), (error) => ({ error }));
  } finally {
    await srv.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("vectors with more dimensions than the cap are rejected", async () => {
  const row = (dims) => `[${"0.5,".repeat(dims - 1)}0.5]`;
  const big = await embedAgainst(`{"embeddings":[${row(MAX_DIMENSIONS + 1)},${row(MAX_DIMENSIONS + 1)}]}`);
  assert.equal(big.error?.name, "EmbeddingError");
  assert.match(big.error.message, /dimensional vectors/);
  const huge = await embedAgainst(`{"embeddings":[${row(500_000)},${row(500_000)}]}`);
  assert.equal(huge.error?.name, "EmbeddingError");
  const ok = await embedAgainst(`{"embeddings":[${row(MAX_DIMENSIONS)},${row(MAX_DIMENSIONS)}]}`);
  assert.equal(ok.value?.length, 2);
  assert.equal(ok.value[0].length, MAX_DIMENSIONS);
});

test("a response over the size cap is an endpoint error, whether it says so or not", async () => {
  const filler = "0,".repeat(MAX_RESPONSE_BYTES / 2);
  const body = `{"embeddings":[[${filler}0],[${filler}0]]}`;
  const streamed = await embedAgainst((_req, res) => {
    res.write(body.slice(0, 1000));
    res.end(body.slice(1000));
  });
  assert.equal(streamed.error?.name, "EmbeddingError");
  assert.match(streamed.error.message, /more than 16 MB/);
  const declared = await embedAgainst(body, { headers: { "content-length": String(Buffer.byteLength(body)) } });
  assert.match(declared.error?.message ?? "", /more than 16 MB/);
});

test("a never-ending body is stopped at the cap, not read for ever", async () => {
  const start = Date.now();
  const { error } = await embedAgainst((_req, res) => {
    res.write('{"embeddings":[[');
    const chunk = "0,".repeat(500_000);
    const timer = setInterval(() => res.write(chunk), 1);
    res.on("close", () => clearInterval(timer));
  });
  assert.match(error?.message ?? "", /more than 16 MB/);
  assert.ok(Date.now() - start < 10_000);
});

function sidecar(header, data) {
  const head = Buffer.from(JSON.stringify(header), "utf8");
  const dataStart = Math.ceil((8 + 4 + head.length) / 4) * 4;
  const out = Buffer.alloc(dataStart + data.length);
  out.write("PMEMB01\n", 0, "latin1");
  out.writeUInt32LE(head.length, 8);
  head.copy(out, 12);
  data.copy(out, dataStart);
  return out;
}

const floats = (...values) => {
  const out = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => {
    out.writeFloatLE(value, index * 4);
  });
  return out;
};

test("a sidecar with NaN or infinite values is corrupt: not used, and rebuilt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emb-limits-"));
  try {
    const service = makeService("http://127.0.0.1:9/api/embed", dir, [source(1)]);
    for (const bad of [NaN, Infinity, -Infinity]) {
      await writeFile(join(dir, "mail-embeddings.bin"), sidecar({ model: "m", dims: 2, keys: ["a", "b"], hashes: [1, 2] }, Buffer.concat([floats(bad, bad), floats(1, 0)])));
      assert.deepEqual(await service.rank(new Float32Array([1, 0]), 5, {}), []);
      assert.equal((await service.coverage()).store, undefined);
    }
    await writeFile(join(dir, "mail-embeddings.bin"), sidecar({ model: "m", dims: 2, keys: ["a", "b"], hashes: [1, 2] }, Buffer.concat([floats(0, 1), floats(1, 0)])));
    assert.deepEqual((await service.rank(new Float32Array([1, 0]), 5, {})).map((hit) => hit.id), ["b", "a"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a sidecar announcing more dimensions than the cap is corrupt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emb-limits-"));
  try {
    const service = makeService("http://127.0.0.1:9/api/embed", dir);
    await writeFile(join(dir, "mail-embeddings.bin"), sidecar({ model: "m", dims: MAX_DIMENSIONS + 1, keys: [], hashes: [] }, Buffer.alloc(0)));
    assert.equal((await service.coverage()).store, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an endpoint that flips the vector size between batches ends the build with a clear error and keeps vectors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emb-limits-"));
  let calls = 0;
  const srv = await listen((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const { input } = JSON.parse(body);
      calls += 1;
      const dims = calls % 2 ? 3 : 4;
      res.end(JSON.stringify({ embeddings: input.map(() => Array.from({ length: dims }, (_, i) => i + 1)) }));
    });
  });
  try {
    const service = makeService(`http://127.0.0.1:${srv.port}/api/embed`, dir, Array.from({ length: 80 }, (_, i) => source(i)));
    service.ensureBuilding();
    const outcome = await Promise.race([service.idle().then(() => "ended"), new Promise((resolve) => setTimeout(() => resolve("still building"), 8000))]);
    assert.equal(outcome, "ended", `still building after ${calls} endpoint calls`);
    assert.ok(calls <= 5, `${calls} endpoint calls`);
    const status = await service.status();
    assert.match(String(status.lastError), /keeps changing the vector size/);
    assert.equal(status.building, false);
    assert.ok(Number(status.vectors) > 0, "vectors from before the last flip are kept");
    const before = calls;
    service.ensureBuilding();
    await service.idle();
    assert.equal(calls, before, "backs off instead of retrying at once");
  } finally {
    await srv.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("one change of model size still rebuilds normally", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emb-limits-"));
  let dims = 3;
  const srv = await listen((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const { input } = JSON.parse(body);
      res.end(JSON.stringify({ embeddings: input.map(() => Array.from({ length: dims }, (_, i) => i + 1)) }));
    });
  });
  try {
    const service = makeService(`http://127.0.0.1:${srv.port}/api/embed`, dir, Array.from({ length: 20 }, (_, i) => source(i)));
    service.ensureBuilding();
    await service.idle();
    assert.equal((await service.status()).dimensions, 3);
    dims = 5;
    const second = makeService(`http://127.0.0.1:${srv.port}/api/embed`, dir, Array.from({ length: 21 }, (_, i) => source(i)));
    second.ensureBuilding();
    await second.idle();
    const status = await second.status();
    assert.equal(status.dimensions, 5);
    assert.equal(status.lastError, undefined);
  } finally {
    await srv.close();
    await rm(dir, { recursive: true, force: true });
  }
});
