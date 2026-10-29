import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AccountBundle } from "./account-manager.js";
import type { LocalIndexService } from "./local-index-service.js";
import type { EmailAddress, EmailSummary, EmbeddingsConfig, SearchEmailsInput } from "../types/index.js";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { isFileNotFound } from "../utils/corrupt-store.js";
import { withFileLock } from "../utils/file-lock.js";
import { logger, type Logger } from "../utils/logger.js";
import { isLocalBridgeHost } from "../utils/tls.js";

// Optional semantic search over the local index. The vectors come from an embedding endpoint the user runs
// (PROTONMAIL_EMBEDDINGS_URL: Ollama's /api/embed or an OpenAI-compatible /v1/embeddings); no model is bundled and
// nothing here runs while it is unset. They are built in the background, a batch at a time, from each message's
// subject, sender and the start of its text (the preview the index already keeps), and stored next to the index in
// mail-embeddings.bin. Only the process holding the build lock writes that file; the others read it.

// The newest messages that get a vector. Brute-force cosine over this many stays in milliseconds, and the file in
// tens of MB.
export const MAX_VECTORS = 10_000;
const BATCH_SIZE = 16;
const BATCH_PAUSE_MS = 250;
// Each save rewrites the whole file (tens of MB when full): often enough to resume, not so often it churns the disk.
const SAVE_EVERY = 1_000;
const BUILD_TIMEOUT_MS = 60_000;
const QUERY_TIMEOUT_MS = 10_000;
const RETRY_AFTER_FAILURE_MS = 60_000;
// A finished build is not repeated sooner: every search asks for one, and new mail can wait that long for its vector.
const REBUILD_AFTER_MS = 30_000;
const MAX_TEXT_CHARS = 1_000;
const RANK_CHUNK = 500;
const MAGIC = "PMEMB01\n";
// What an endpoint may hand back: a hostile or broken one must not make this process read gigabytes or store vectors of
// any size for every message.
export const MAX_DIMENSIONS = 8_192;
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
// A build that sees the vector size change between batches starts over this many times, then stops until the next retry.
const MAX_DIMENSION_RESTARTS = 2;

export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingError";
  }
}

class CorruptSidecar extends Error {}

interface Entry {
  hash: number;
  vector: Float32Array;
}

interface Store {
  model: string;
  dims: number;
  entries: Map<string, Entry>;
}

type EmbeddingSource = Awaited<ReturnType<LocalIndexService["listEmbeddingSources"]>>[number];

// Checks PROTONMAIL_EMBEDDINGS_URL: which API it speaks, and that mail text stays on this machine unless allowed.
export function checkEmbeddingsEndpoint(raw: string, allowRemote: boolean): { url: string; api: EmbeddingsConfig["api"] } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`PROTONMAIL_EMBEDDINGS_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`PROTONMAIL_EMBEDDINGS_URL must be an http:// or https:// URL, got: ${raw}`);
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  const api = url.pathname.endsWith("/api/embed") ? "ollama" : url.pathname.endsWith("/embeddings") ? "openai" : undefined;
  if (!api) {
    throw new Error(`PROTONMAIL_EMBEDDINGS_URL must end with /api/embed (Ollama) or /v1/embeddings (OpenAI-compatible), got: ${raw}`);
  }
  if (!allowRemote && !isLocalBridgeHost(url.hostname.replace(/^\[|\]$/g, ""))) {
    throw new Error(
      `PROTONMAIL_EMBEDDINGS_URL points to ${url.hostname}, which is not this computer. Semantic search sends the subject, sender and ` +
        "first lines of your messages to that endpoint, so your mail text would leave this machine. Use an endpoint on localhost, " +
        "127.0.0.1 or [::1], or set PROTONMAIL_EMBEDDINGS_ALLOW_REMOTE=true if you accept that.",
    );
  }
  return { url: url.toString(), api };
}

function textFor(source: Pick<EmbeddingSource, "subject" | "from" | "preview">): string {
  const sender = source.from
    .map((entry: EmailAddress) => (entry.name ? `${entry.name} <${entry.address ?? ""}>` : (entry.address ?? "")))
    .filter(Boolean)
    .join(", ");
  return [source.subject, sender && `From: ${sender}`, source.preview].filter(Boolean).join("\n").slice(0, MAX_TEXT_CHARS) || "(empty)";
}

// FNV-1a: tells whether a message's text changed since its vector was made (a preview filled in by a later sync).
function hashText(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const length = Math.sqrt(sum);
  if (length > 0) for (let index = 0; index < vector.length; index += 1) vector[index] /= length;
  return vector;
}

function dot(left: Float32Array, right: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += left[index] * right[index];
  return sum;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    return cause?.code ?? cause?.message ?? error.message;
  }
  return String(error);
}

// The file: MAGIC, a uint32 header length, a JSON header (model, dims, keys, hashes), padding to 4 bytes, then one
// Float32 vector per key in the platform's byte order (little-endian on every platform Bridge runs on).
function encode(store: Store): Buffer {
  const keys = [...store.entries.keys()];
  const header = Buffer.from(JSON.stringify({ model: store.model, dims: store.dims, keys, hashes: keys.map((key) => store.entries.get(key)?.hash) }), "utf8");
  const dataStart = Math.ceil((MAGIC.length + 4 + header.length) / 4) * 4;
  const out = Buffer.alloc(dataStart + keys.length * store.dims * 4);
  out.write(MAGIC, 0, "latin1");
  out.writeUInt32LE(header.length, MAGIC.length);
  header.copy(out, MAGIC.length + 4);
  keys.forEach((key, index) => {
    const vector = store.entries.get(key)?.vector ?? new Float32Array(store.dims);
    Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).copy(out, dataStart + index * store.dims * 4);
  });
  return out;
}

function decode(buffer: Buffer): Store {
  if (buffer.length < MAGIC.length + 4 || buffer.toString("latin1", 0, MAGIC.length) !== MAGIC) throw new CorruptSidecar("not an embeddings file");
  const headerEnd = MAGIC.length + 4 + buffer.readUInt32LE(MAGIC.length);
  if (headerEnd > buffer.length) throw new CorruptSidecar("header cut off");
  let header: { model?: unknown; dims?: unknown; keys?: unknown; hashes?: unknown };
  try {
    header = JSON.parse(buffer.toString("utf8", MAGIC.length + 4, headerEnd));
  } catch {
    throw new CorruptSidecar("header is not JSON");
  }
  const { model, dims, keys, hashes } = header;
  if (
    typeof model !== "string" ||
    !Number.isInteger(dims) ||
    (dims as number) < 0 ||
    (dims as number) > MAX_DIMENSIONS ||
    !Array.isArray(keys) ||
    !keys.every((key) => typeof key === "string") ||
    !Array.isArray(hashes) ||
    hashes.length !== keys.length ||
    (dims === 0 && keys.length > 0)
  ) {
    throw new CorruptSidecar("header fields are wrong");
  }
  const size = (dims as number) * 4;
  const dataStart = Math.ceil(headerEnd / 4) * 4;
  if (buffer.length !== dataStart + keys.length * size) throw new CorruptSidecar("size does not match the header");
  const entries = new Map<string, Entry>();
  keys.forEach((key: string, index) => {
    const offset = buffer.byteOffset + dataStart + index * size;
    const vector = new Float32Array(buffer.buffer.slice(offset, offset + size));
    // A NaN or infinite value would turn every similarity it touches into NaN and the ranking into noise.
    if (!vector.every(Number.isFinite)) throw new CorruptSidecar("vectors hold values that are not finite");
    entries.set(key, { hash: Number(hashes[index]), vector });
  });
  return { model, dims: dims as number, entries };
}

export interface EmbeddingCoverage {
  store?: Store;
  /** Messages of the corpus with a current vector. */
  covered: number;
  pending: number;
  /** True when the index holds more messages than MAX_VECTORS: only the newest get a vector. */
  capped: boolean;
  problem?: string;
}

export class EmbeddingService {
  private readonly path: string;
  private readonly configError?: string;
  private readonly endpointLabel: string;
  private cached?: { store?: Store; mtimeMs: number; size: number };
  private building?: Promise<void>;
  private retryAt = 0;
  private lastError?: string;
  private lastBuiltAt?: string;
  private otherBuilder = false;
  // A query came back with this many dimensions while the stored vectors have others: the next build starts over.
  private resetForDims?: number;

  constructor(
    private readonly config: EmbeddingsConfig,
    dataDir: string,
    private readonly index: Pick<LocalIndexService, "listEmbeddingSources" | "getEmailsByKeys">,
    private readonly log: Logger = logger,
    private readonly maxVectors = MAX_VECTORS,
  ) {
    this.path = join(dataDir, "mail-embeddings.bin");
    let label = config.url;
    try {
      // The configuration normally passed this check already; it is repeated so no path sends mail text without it.
      const checked = new URL(checkEmbeddingsEndpoint(config.url, config.allowRemote).url);
      label = `${checked.origin}${checked.pathname}`;
    } catch (error) {
      this.configError = error instanceof Error ? error.message : String(error);
    }
    this.endpointLabel = label;
  }

  get model(): string {
    return this.config.model;
  }

  async embed(texts: string[], timeoutMs = QUERY_TIMEOUT_MS): Promise<Float32Array[]> {
    if (this.configError) throw new EmbeddingError(this.configError);
    let response: Response;
    try {
      response = await fetch(this.config.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.config.model, input: texts }),
        // A redirect could hand the mail text to another host.
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new EmbeddingError(`the embedding endpoint ${this.endpointLabel} did not answer (${describe(error)})`);
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200).trim();
      throw new EmbeddingError(`the embedding endpoint ${this.endpointLabel} answered HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    const body = await this.readJson(response);
    const raw =
      this.config.api === "ollama"
        ? body?.embeddings
        : Array.isArray(body?.data)
          ? [...body.data].sort((left, right) => (left?.index ?? 0) - (right?.index ?? 0)).map((entry) => entry?.embedding)
          : undefined;
    const dims = Array.isArray(raw) && Array.isArray(raw[0]) ? raw[0].length : 0;
    if (dims > MAX_DIMENSIONS) {
      throw new EmbeddingError(`the embedding endpoint ${this.endpointLabel} returned ${dims}-dimensional vectors; more than ${MAX_DIMENSIONS} is not accepted`);
    }
    if (
      !Array.isArray(raw) ||
      raw.length !== texts.length ||
      dims === 0 ||
      !raw.every((vector) => Array.isArray(vector) && vector.length === dims && vector.every((value) => typeof value === "number" && Number.isFinite(value)))
    ) {
      throw new EmbeddingError(`the embedding endpoint ${this.endpointLabel} gave an answer that is not ${texts.length} vector(s) of numbers (is "${this.config.model}" an embedding model?)`);
    }
    return (raw as number[][]).map((vector) => normalize(Float32Array.from(vector)));
  }

  // The answer as JSON, read with a size cap; undefined when it is not JSON or the read failed (including the timeout).
  private async readJson(response: Response): Promise<{ embeddings?: unknown; data?: Array<{ index?: number; embedding?: unknown }> } | undefined> {
    const tooBig = () => new EmbeddingError(`the embedding endpoint ${this.endpointLabel} answered with more than ${MAX_RESPONSE_BYTES / 1024 / 1024} MB`);
    if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw tooBig();
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      const reader = response.body?.getReader();
      while (reader) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw tooBig();
        }
        chunks.push(part.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      return undefined;
    }
  }

  // Starts a background build unless one is running or the last one ended moments ago. Never waits.
  ensureBuilding(): void {
    if (this.building || this.configError || Date.now() < this.retryAt) return;
    this.building = this.build()
      .catch((error) => {
        this.lastError = describe(error);
        this.retryAt = Date.now() + RETRY_AFTER_FAILURE_MS;
        this.log.warn("Semantic index build stopped", "EmbeddingService", { error: this.lastError });
      })
      .finally(() => {
        this.building = undefined;
        // A query saw new dimensions while this build ran; the next one starts over.
        if (this.resetForDims !== undefined) this.ensureBuilding();
      });
  }

  /** Resolves when the current background build (if any) has ended. */
  async idle(): Promise<void> {
    await this.building;
  }

  async coverage(): Promise<EmbeddingCoverage> {
    if (this.configError) return { covered: 0, pending: 0, capped: false, problem: this.configError };
    const [store, sources] = await Promise.all([this.current(), this.index.listEmbeddingSources(this.maxVectors + 1)]);
    const corpus = sources.slice(0, this.maxVectors);
    const covered = store ? corpus.filter((source) => store.entries.get(source.key)?.hash === hashText(textFor(source))).length : 0;
    return { store, covered, pending: corpus.length - covered, capped: sources.length > this.maxVectors, ...(this.lastError ? { problem: this.lastError } : {}) };
  }

  async status(): Promise<Record<string, unknown>> {
    const coverage = await this.coverage();
    return {
      configured: true,
      model: this.config.model,
      api: this.config.api,
      endpoint: this.endpointLabel,
      vectors: coverage.covered,
      pending: coverage.pending,
      ...(coverage.store?.dims ? { dimensions: coverage.store.dims } : {}),
      building: Boolean(this.building),
      ...(this.otherBuilder ? { builtByAnotherProcess: true } : {}),
      ...(coverage.capped ? { corpusLimit: this.maxVectors, note: `Only the newest ${this.maxVectors} messages get a vector; older mail is found by its words only.` } : {}),
      ...(this.lastBuiltAt ? { lastBuiltAt: this.lastBuiltAt } : {}),
      ...(coverage.problem ? { lastError: coverage.problem } : {}),
    };
  }

  // The messages most like the query vector, best first, among those the filters allow; `similarity` is the cosine.
  async rank(query: Float32Array, want: number, filters: SearchEmailsInput): Promise<Array<EmailSummary & { similarity: number }>> {
    const store = await this.current();
    if (!store || store.entries.size === 0) return [];
    if (query.length !== store.dims) {
      this.resetForDims = query.length;
      this.retryAt = 0;
      this.ensureBuilding();
      throw new EmbeddingError(`the embedding model now returns ${query.length}-dimensional vectors but the stored ones have ${store.dims}; the semantic index is being rebuilt`);
    }
    const scored = [...store.entries].map(([key, entry]) => ({ key, similarity: dot(query, entry.vector) })).sort((left, right) => right.similarity - left.similarity);
    const ranked: Array<EmailSummary & { similarity: number }> = [];
    for (let start = 0; start < scored.length && ranked.length < want; start += RANK_CHUNK) {
      const chunk = scored.slice(start, start + RANK_CHUNK);
      const similarity = new Map(chunk.map((entry) => [entry.key, entry.similarity]));
      for (const email of await this.index.getEmailsByKeys(chunk.map((entry) => entry.key), filters)) {
        ranked.push({ ...email, similarity: Math.round((similarity.get(email.messageId || email.id) ?? 0) * 1000) / 1000 });
      }
    }
    return ranked.slice(0, want);
  }

  // The stored vectors for the configured model, re-read when another process has saved since.
  private async current(): Promise<Store | undefined> {
    const store = await this.readStore();
    return store && store.model === this.config.model ? store : undefined;
  }

  private async readStore(): Promise<Store | undefined> {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(this.path);
    } catch (error) {
      if (isFileNotFound(error)) return undefined;
      throw error;
    }
    if (this.cached && this.cached.mtimeMs === info.mtimeMs && this.cached.size === info.size) return this.cached.store;
    let store: Store | undefined;
    try {
      store = decode(await readFile(this.path));
    } catch (error) {
      if (!(error instanceof CorruptSidecar)) throw error;
      // Derived data: nothing to recover by hand, the next build replaces it.
      this.log.warn(`Unreadable ${this.path} (${error.message}); the semantic index is rebuilt`, "EmbeddingService");
    }
    this.cached = { store, mtimeMs: info.mtimeMs, size: info.size };
    return store;
  }

  private async save(store: Store): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.path, encode(store));
    const info = await stat(this.path);
    this.cached = { store, mtimeMs: info.mtimeMs, size: info.size };
  }

  private async build(): Promise<void> {
    let entered = false;
    try {
      await withFileLock(`${this.path}.build`, async () => {
        entered = true;
        this.otherBuilder = false;
        await this.buildLocked();
      });
    } catch (error) {
      if (entered || !(error instanceof Error) || !error.message.startsWith("Timed out")) throw error;
      // Another server process on this data directory is building; it saves as it goes and this one reads that.
      this.otherBuilder = true;
      this.retryAt = Date.now() + RETRY_AFTER_FAILURE_MS;
    }
  }

  private async buildLocked(): Promise<void> {
    this.cached = undefined;
    const loaded = await this.readStore();
    const reuse = loaded && loaded.model === this.config.model && (this.resetForDims === undefined || loaded.dims === this.resetForDims);
    let store: Store = reuse ? loaded : { model: this.config.model, dims: 0, entries: new Map() };
    this.resetForDims = undefined;
    // Vectors of another model or size (or a corrupt file) stay on disk until the first new vector replaces them;
    // searches skip or fall back over them meanwhile.
    let dirty = false;

    const sources = await this.index.listEmbeddingSources(this.maxVectors + 1);
    const corpus = sources.slice(0, this.maxVectors).map((source) => {
      const text = textFor(source);
      return { key: source.key, text, hash: hashText(text) };
    });
    const wanted = new Map(corpus.map((item) => [item.key, item.hash]));
    // Messages gone from the index (or past the newest MAX_VECTORS), and ones whose text changed.
    for (const [key, entry] of store.entries) {
      if (wanted.get(key) !== entry.hash) {
        store.entries.delete(key);
        dirty = true;
      }
    }
    let queue = corpus.filter((item) => !store.entries.has(item.key));
    let unsaved = 0;
    let restarts = 0;
    try {
      while (queue.length > 0) {
        const batch = queue.slice(0, BATCH_SIZE);
        const vectors = await this.embed(batch.map((item) => item.text), BUILD_TIMEOUT_MS);
        if (vectors[0].length !== store.dims) {
          if (store.entries.size > 0) {
            // Not discarded again: the vectors kept so far are saved by the finally below.
            if (++restarts > MAX_DIMENSION_RESTARTS) {
              throw new EmbeddingError(
                `the embedding endpoint ${this.endpointLabel} keeps changing the vector size (${store.dims} and ${vectors[0].length} dimensions); the semantic index build stopped after ${MAX_DIMENSION_RESTARTS} restarts`,
              );
            }
            this.log.info(`The embedding model now returns ${vectors[0].length} dimensions instead of ${store.dims}; rebuilding the semantic index`, "EmbeddingService");
          }
          store = { model: this.config.model, dims: vectors[0].length, entries: new Map() };
        }
        batch.forEach((item, index) => {
          store.entries.set(item.key, { hash: item.hash, vector: vectors[index] });
        });
        dirty = true;
        unsaved += batch.length;
        queue = corpus.filter((item) => !store.entries.has(item.key));
        if (unsaved >= SAVE_EVERY) {
          await this.save(store);
          dirty = false;
          unsaved = 0;
        }
        if (queue.length > 0) await new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
      }
    } finally {
      // Progress so far survives an endpoint that went away mid-build: the next build resumes from here.
      if (dirty) await this.save(store).catch((error) => this.log.warn("Could not save the semantic index", "EmbeddingService", { error: describe(error) }));
    }
    this.lastError = undefined;
    this.lastBuiltAt = new Date().toISOString();
    this.retryAt = this.resetForDims === undefined ? Date.now() + REBUILD_AFTER_MS : 0;
  }
}

// One service per account index in this process.
const services = new WeakMap<LocalIndexService, EmbeddingService>();

export function embeddingsFor(bundle: Pick<AccountBundle, "config" | "localIndexService">): EmbeddingService | undefined {
  const config = bundle.config.runtime.embeddings;
  if (!config) return undefined;
  let service = services.get(bundle.localIndexService);
  if (!service) {
    service = new EmbeddingService(config, bundle.config.dataDir, bundle.localIndexService);
    services.set(bundle.localIndexService, service);
  }
  return service;
}
