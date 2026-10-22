import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { isFileNotFound, setAsideCorruptStore } from "../utils/corrupt-store.js";
import { withFileLock } from "../utils/file-lock.js";
import { logger } from "../utils/logger.js";

// A batch of mailbox changes proposed in one go, to be approved in one go (or in part) and undone in one go. The
// batch only ever holds changes that can be taken back (archive, move, mark read, label): never delete or trash.

export type PlanAction = "archive" | "move" | "mark_read" | "label";

export interface PlanItem {
  /** Position in the plan, 1-based: what approve_plan refers to. */
  n: number;
  emailId: string;
  from: string;
  subject: string;
  action: PlanAction;
  /** Folder for move, label name for label. */
  target?: string;
  reason: string;
  source: "client" | "scan";
}

export interface AppliedItem {
  n: number;
  ok: boolean;
  error?: string;
  /** What undo needs: where the message is now and how to put it back. */
  undo?: { kind: "move"; emailId: string; backTo: string } | { kind: "unread"; emailId: string } | { kind: "unlabel"; emailId: string; label: string };
  undone?: boolean;
}

export interface TriagePlan {
  id: string;
  createdAt: string;
  items: PlanItem[];
  status: "open" | "applied" | "undone";
  appliedAt?: string;
  applied?: AppliedItem[];
}

interface TriageState {
  plans: TriagePlan[];
  /** Senders whose mail was left out of an approved plan: not proposed again by the scan. */
  declined: Array<{ sender: string; at: string }>;
}

const MAX_PLANS = 20;
const MAX_DECLINED = 500;

export class TriagePlanService {
  private readonly storePath: string;

  constructor(options: { dataDir: string }) {
    this.storePath = join(options.dataDir, "triage-plans.json");
  }

  async create(items: Omit<PlanItem, "n">[], now = new Date()): Promise<TriagePlan> {
    return this.withLock(async () => {
      const state = await this.load();
      const plan: TriagePlan = { id: `plan-${randomUUID().slice(0, 8)}`, createdAt: now.toISOString(), items: items.map((item, index) => ({ ...item, n: index + 1 })), status: "open" };
      state.plans = [...state.plans, plan].slice(-MAX_PLANS);
      await this.save(state);
      return plan;
    });
  }

  async get(id: string): Promise<TriagePlan | undefined> {
    return (await this.load()).plans.find((plan) => plan.id === id);
  }

  async list(): Promise<TriagePlan[]> {
    return (await this.load()).plans;
  }

  async declinedSenders(): Promise<Set<string>> {
    return new Set((await this.load()).declined.map((entry) => entry.sender));
  }

  async markApplied(id: string, applied: AppliedItem[], declinedSenders: string[], now = new Date()): Promise<TriagePlan> {
    return this.withLock(async () => {
      const state = await this.load();
      const plan = state.plans.find((candidate) => candidate.id === id);
      if (!plan) throw new Error(`No plan ${id}.`);
      plan.status = "applied";
      plan.appliedAt = now.toISOString();
      plan.applied = applied;
      const known = new Set(state.declined.map((entry) => entry.sender));
      for (const sender of declinedSenders) if (sender && !known.has(sender)) state.declined.push({ sender, at: now.toISOString() });
      state.declined = state.declined.slice(-MAX_DECLINED);
      await this.save(state);
      return plan;
    });
  }

  async markUndone(id: string, applied: AppliedItem[]): Promise<TriagePlan> {
    return this.withLock(async () => {
      const state = await this.load();
      const plan = state.plans.find((candidate) => candidate.id === id);
      if (!plan) throw new Error(`No plan ${id}.`);
      plan.applied = applied;
      plan.status = applied.every((item) => !item.ok || item.undone || !item.undo) ? "undone" : "applied";
      await this.save(state);
      return plan;
    });
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.storePath), { recursive: true, mode: 0o700 });
    return withFileLock(this.storePath, fn);
  }

  private async load(): Promise<TriageState> {
    try {
      const parsed = JSON.parse(await readFile(this.storePath, "utf8")) as Partial<TriageState>;
      return { plans: Array.isArray(parsed.plans) ? parsed.plans : [], declined: Array.isArray(parsed.declined) ? parsed.declined : [] };
    } catch (error) {
      if (isFileNotFound(error)) return { plans: [], declined: [] };
      setAsideCorruptStore(this.storePath, error, logger, "TriagePlanService");
      return { plans: [], declined: [] };
    }
  }

  private async save(state: TriageState): Promise<void> {
    await writeFileAtomic(this.storePath, JSON.stringify(state, null, 2));
  }
}
