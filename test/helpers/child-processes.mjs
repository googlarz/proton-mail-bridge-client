import { execFileSync } from "node:child_process";

// Live child processes of a process (default: this one). Office and PDF text are read in child processes, so this is
// what the tests count to see that the pool is bounded and that nothing is left behind. POSIX only (pgrep).
export function childPids(pid = process.pid) {
  try {
    return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number);
  } catch {
    return []; // pgrep exits 1 when there is none
  }
}

export const childCount = (pid = process.pid) => childPids(pid).length;
