import { randomUUID } from "node:crypto";
import { copyFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EmailTemplateRecord, ProtonMailConfig } from "../types/index.js";
import { withFileLock } from "../utils/file-lock.js";
import { logger, type Logger } from "../utils/logger.js";

// Named, reusable email templates with {{variable}} substitution. Persistence
// mirrors DeliveryQueueService/SnoozeService: atomic temp+rename writes,
// corrupted-file backup instead of silent data loss, orphaned .tmp cleanup,
// in-process lock. No update method — recreate (delete + create) instead,
// keeping the surface small.

interface TemplateFile {
  version: number;
  items: Record<string, EmailTemplateRecord>;
}

function createEmptyStore(): TemplateFile {
  return { version: 1, items: {} };
}

const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function extractTemplateVariables(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(VARIABLE_PATTERN)) {
    found.add(match[1]);
  }
  return [...found];
}

export function renderTemplateText(text: string, variables: Record<string, string>): string {
  return text.replace(VARIABLE_PATTERN, (full, name) =>
    Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : full,
  );
}

export class TemplateService {
  private readonly storePath: string;
  private _lock: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: ProtonMailConfig,
    private readonly log: Logger = logger,
  ) {
    this.storePath = join(this.config.dataDir, "templates.json");
  }

  async create(input: { name: string; subject: string; body: string; isHtml?: boolean }): Promise<EmailTemplateRecord> {
    const name = input.name.trim();
    if (!name) {
      throw new Error("Template name must not be empty");
    }

    return this.withLock(async () => {
      const store = await this.loadUnlocked();
      if (Object.values(store.items).some((item) => item.name === name)) {
        throw new Error(`A template named "${name}" already exists. Delete it first or choose a different name.`);
      }
      const record: EmailTemplateRecord = {
        id: randomUUID(),
        name,
        subject: input.subject,
        body: input.body,
        isHtml: Boolean(input.isHtml),
        variables: [...extractTemplateVariables(input.subject), ...extractTemplateVariables(input.body)].filter(
          (value, index, all) => all.indexOf(value) === index,
        ),
        createdAt: new Date().toISOString(),
      };
      store.items[record.id] = record;
      await this.save(store);
      return record;
    });
  }

  async get(id: string): Promise<EmailTemplateRecord> {
    const store = await this.load();
    const record = store.items[id];
    if (!record) {
      throw new Error(`Template not found for id ${id}`);
    }
    return record;
  }

  async list(): Promise<EmailTemplateRecord[]> {
    const store = await this.load();
    return Object.values(store.items).sort((left, right) => left.name.localeCompare(right.name));
  }

  async delete(id: string): Promise<{ id: string; deleted: boolean }> {
    return this.withLock(async () => {
      const store = await this.loadUnlocked();
      if (!store.items[id]) {
        return { id, deleted: false };
      }
      delete store.items[id];
      await this.save(store);
      return { id, deleted: true };
    });
  }

  async render(id: string, variables: Record<string, string> = {}): Promise<{ subject: string; body: string; isHtml: boolean; missingVariables: string[] }> {
    const template = await this.get(id);
    const missingVariables = template.variables.filter(
      (name) => !Object.prototype.hasOwnProperty.call(variables, name),
    );
    return {
      subject: renderTemplateText(template.subject, variables),
      body: renderTemplateText(template.body, variables),
      isHtml: template.isHtml,
      missingVariables,
    };
  }

  // In-process chain (cheap, no I/O) still serializes calls within this
  // process; withFileLock additionally serializes against every OTHER
  // process sharing this dataDir — see file-lock.ts for why that's a real,
  // everyday scenario here, not just a testing artifact.
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const locked = () => withFileLock(this.storePath, fn);
    const run = this._lock.then(locked, locked);
    this._lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async load(): Promise<TemplateFile> {
    return this.withLock(() => this.loadUnlocked());
  }

  // Always reads from disk (no in-memory cache) — see the identical comment
  // in DeliveryQueueService.loadUnlocked for why.
  private async loadUnlocked(): Promise<TemplateFile> {
    await this.cleanOrphanedTempFiles();

    try {
      const raw = await readFile(this.storePath, "utf8");
      const parsed = JSON.parse(raw) as TemplateFile;
      return { ...createEmptyStore(), ...parsed };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
        return createEmptyStore();
      }

      const corruptPath = `${this.storePath}.corrupt`;
      try {
        copyFileSync(this.storePath, corruptPath);
        this.log.error(`Corrupted templates.json backed up to ${corruptPath} — recreating empty store`, "TemplateService", error);
      } catch (backupError) {
        this.log.error("Failed to back up corrupted templates.json — recreating empty store without backup", "TemplateService", { parseError: error, backupError });
      }

      return createEmptyStore();
    }
  }

  private async cleanOrphanedTempFiles(): Promise<void> {
    const dir = dirname(this.storePath);
    try {
      const entries = await readdir(dir);
      const tmpFiles = entries.filter((name) => name.startsWith("templates.json") && name.endsWith(".tmp"));
      await Promise.all(
        tmpFiles.map((name) =>
          unlink(join(dir, name)).catch((err) => {
            this.log.warn(`Failed to remove orphaned temp file: ${name}`, "TemplateService", err);
          }),
        ),
      );
    } catch {
      // Directory may not exist yet — ignore.
    }
  }

  // ponytail: same cross-process race as DeliveryQueueService.save — see that
  // comment for why it's left unlocked and the real upgrade path (SQLite).
  private async save(store: TemplateFile): Promise<void> {
    await mkdir(dirname(this.storePath), { recursive: true });
    const tempPath = `${this.storePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(store, null, 2), "utf8");
    await rename(tempPath, this.storePath);
  }
}
