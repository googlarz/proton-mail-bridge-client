import type { LogEntry } from "../types/index.js";

type LogLevel = LogEntry["level"];

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const MAX_LOG_DATA_DEPTH = 12;

// Turns log data into plain JSON-safe values. `ancestors` holds the objects on the path from the root to
// here: meeting one of them again is a cycle (marked, not followed), while the same object appearing twice
// side by side is just shared and is logged in full both times. Depth is bounded so a pathological object
// cannot overflow the stack: this runs inside catch blocks, where a throw becomes an unhandled rejection.
function normalizeData(data: unknown, ancestors: Set<object> = new Set()): unknown {
  if (data instanceof Error) {
    return {
      name: data.name,
      message: data.message,
      stack: data.stack,
    };
  }

  if (typeof data === "bigint") {
    return data.toString();
  }

  if (!data || typeof data !== "object") {
    return data;
  }

  if (ancestors.has(data)) {
    return "[Circular]";
  }
  if (ancestors.size >= MAX_LOG_DATA_DEPTH) {
    return "[Truncated]";
  }

  ancestors.add(data);
  try {
    if (Array.isArray(data)) {
      return data.map((value) => normalizeData(value, ancestors));
    }
    if (data instanceof Set) {
      return [...data].map((value) => normalizeData(value, ancestors));
    }
    if (data instanceof Map) {
      return Object.fromEntries([...data.entries()].map(([key, value]) => [String(key), normalizeData(value, ancestors)]));
    }
    return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, normalizeData(value, ancestors)]));
  } finally {
    ancestors.delete(data);
  }
}

export class Logger {
  private readonly entries: LogEntry[] = [];
  private _droppedCount = 0;
  private debugMode = false;
  private readonly maxEntries: number;

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
  }

  setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
  }

  debug(message: string, context?: string, data?: unknown): void {
    this.log("debug", message, context, data);
  }

  info(message: string, context?: string, data?: unknown): void {
    this.log("info", message, context, data);
  }

  warn(message: string, context?: string, data?: unknown): void {
    this.log("warn", message, context, data);
  }

  error(message: string, context?: string, data?: unknown): void {
    this.log("error", message, context, data);
  }

  getLogs(options?: { level?: LogLevel; limit?: number }): { entries: LogEntry[]; droppedCount: number } {
    const levelThreshold = options?.level ? LEVEL_ORDER[options.level] : 0;
    const limit = options?.limit ?? 100;

    return {
      entries: this.entries
        .filter((entry) => LEVEL_ORDER[entry.level] >= levelThreshold)
        .slice(-limit),
      droppedCount: this._droppedCount,
    };
  }

  clear(): void {
    this.entries.length = 0;
  }

  private log(level: LogLevel, message: string, context?: string, data?: unknown): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      context,
      message,
      data: normalizeData(data),
    };

    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
      if (this._droppedCount === 0) {
        process.stderr.write('[WARN] proton-mcp: log buffer full, entries are being dropped\n');
      }
      this._droppedCount += 1;
    }

    if (level === "debug" && !this.debugMode) {
      return;
    }

    const parts = [entry.timestamp, level.toUpperCase()];
    if (context) {
      parts.push(`[${context}]`);
    }
    parts.push(message);

    if (entry.data !== undefined) {
      parts.push(JSON.stringify(entry.data));
    }

    process.stderr.write(`${parts.join(" ")}\n`);
  }
}

export const logger = new Logger();
