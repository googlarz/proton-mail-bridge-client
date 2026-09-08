import { randomUUID } from "node:crypto";
import type { OperationClaim } from "../types/index.js";
import { isProcessAlive } from "./file-lock.js";

export function createOperationClaim(): OperationClaim {
  return { pid: process.pid, token: randomUUID() };
}

// Never recover a live or uninspectable owner. Legacy claims have no owner;
// their outcome must be reported as unknown rather than retried automatically.
export function isAbandonedClaim(claim?: OperationClaim): boolean {
  return !claim || isProcessAlive(claim.pid) === false;
}
