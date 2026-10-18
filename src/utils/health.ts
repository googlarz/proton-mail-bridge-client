import type { BackgroundSyncStatus } from "../types/index.js";

export interface HealthProblem {
  code: "authentication_failed" | "bridge_unreachable" | "sync_stalled" | "index_stale";
  message: string;
  fix: string;
}

// What a user would otherwise find out by noticing that the answers are old: each problem names itself and what to
// do about it. Read from the state the server already keeps; it checks nothing on the network.
export function healthProblems(
  sync: Pick<BackgroundSyncStatus, "enabled" | "leader" | "intervalMinutes" | "lastFailureKind" | "lastFailureMessage" | "lastRunAt" | "lastSuccessAt">,
  index: { isStale: boolean; storedMessageCount: number },
  now = Date.now(),
): HealthProblem[] {
  if (!sync.enabled || sync.leader === false) return [];
  const problems: HealthProblem[] = [];
  if (sync.lastFailureKind === "auth") {
    problems.push({
      code: "authentication_failed",
      message: "Background sync cannot log in to Bridge.",
      fix: "The Bridge password probably changed (for example after signing in to Bridge again). Copy the current one from the Bridge app into PROTONMAIL_PASSWORD.",
    });
  } else if (sync.lastFailureKind === "transient") {
    problems.push({
      code: "bridge_unreachable",
      message: `Background sync is failing: ${sync.lastFailureMessage ?? "Bridge did not answer"}.`,
      fix: "Check that the Bridge app is running and that the ports match its settings.",
    });
  }
  const lastSuccess = sync.lastSuccessAt ? Date.parse(sync.lastSuccessAt) : Number.NaN;
  if (sync.lastRunAt && Number.isFinite(lastSuccess) && now - lastSuccess > 3 * Math.max(1, sync.intervalMinutes) * 60_000 && !problems.length) {
    problems.push({
      code: "sync_stalled",
      message: "Background sync has not completed for a while.",
      fix: "Run run_background_sync, or doctor on the command line, to see why.",
    });
  }
  if (index.isStale && index.storedMessageCount > 0 && !problems.length) {
    problems.push({
      code: "index_stale",
      message: "The local index is older than expected, so indexed searches may be out of date.",
      fix: "Run sync_emails, or check that background sync is enabled.",
    });
  }
  return problems;
}
