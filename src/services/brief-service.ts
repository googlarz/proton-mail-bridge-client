import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { isFileNotFound } from "../utils/corrupt-store.js";

// The brief: what is worth knowing since the last time you looked, in a few lines. This file keeps only when it was
// last taken (so "new since" means since you were last told); building it is done from the index by the tool.

export interface BriefState {
  lastAt?: string;
}

export class BriefStore {
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, "brief.json");
  }

  async read(): Promise<BriefState> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as BriefState;
      return typeof parsed.lastAt === "string" && !Number.isNaN(Date.parse(parsed.lastAt)) ? { lastAt: parsed.lastAt } : {};
    } catch (error) {
      if (isFileNotFound(error) || error instanceof SyntaxError) return {};
      throw error;
    }
  }

  async markSeen(at: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFileAtomic(this.path, JSON.stringify({ lastAt: at }, null, 2));
  }
}

export interface BriefInput {
  since: string;
  needsReply: Array<{ subject: string; from: string; ageHours?: number }>;
  waitingOnOthers: Array<{ subject: string; to?: string; daysOverdue?: number }>;
  newMail: { total: number; fromPeople: number; automated: number; topSenders: string[] };
  flagged: Array<{ from: string; subject: string; level: string }>;
  commitments?: Array<{ text: string; direction: "mine" | "theirs"; due?: string; overdue: boolean }>;
}

/** The brief as a few plain lines, for a notification or a quick read. Empty sections are left out. */
export function briefLines(input: BriefInput): string[] {
  const lines: string[] = [];
  const { newMail } = input;
  if (newMail.total > 0) {
    const who = newMail.topSenders.length ? ` Most from: ${newMail.topSenders.join(", ")}.` : "";
    lines.push(`${newMail.total} new since ${input.since.slice(0, 16).replace("T", " ")} (${newMail.fromPeople} from people, ${newMail.automated} automatic).${who}`);
  }
  if (input.flagged.length) lines.push(`${input.flagged.length} suspicious: ${input.flagged.slice(0, 3).map((f) => `${f.from} "${f.subject}"`).join("; ")}.`);
  if (input.needsReply.length) lines.push(`${input.needsReply.length} waiting for your reply: ${input.needsReply.slice(0, 3).map((t) => `${t.from} "${t.subject}"`).join("; ")}.`);
  const due = input.commitments?.filter((c) => c.overdue) ?? [];
  if (due.length) lines.push(`${due.length} commitment${due.length === 1 ? "" : "s"} overdue: ${due.slice(0, 3).map((c) => (c.direction === "mine" ? `you: ${c.text}` : `they: ${c.text}`)).join("; ")}.`);
  if (input.waitingOnOthers.length) lines.push(`${input.waitingOnOthers.length} reply${input.waitingOnOthers.length === 1 ? "" : " replies"} you are waiting for are overdue: ${input.waitingOnOthers.slice(0, 3).map((t) => `"${t.subject}"`).join("; ")}.`);
  if (lines.length === 0) lines.push("Nothing new needs you.");
  return lines;
}
