// An explicit "is there a newer release?" lookup (`version --check`, `doctor --check-updates`). It never runs on
// its own: the server is local-first and does not contact anything but Bridge unless the user asks.

export interface UpdateCheck {
  current: string;
  latest?: string;
  newer: boolean;
  error?: string;
  releaseUrl?: string;
}

export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (value: string) => value.replace(/^v/, "").split("-")[0].split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

export async function checkForUpdate(
  current: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5_000,
): Promise<UpdateCheck> {
  try {
    const response = await fetchImpl("https://registry.npmjs.org/proton-mail-bridge-client/latest", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { current, newer: false, error: `npm registry answered ${response.status}` };
    const latest = ((await response.json()) as { version?: unknown }).version;
    if (typeof latest !== "string") return { current, newer: false, error: "the npm registry answer had no version" };
    const newer = isNewerVersion(latest, current);
    return {
      current,
      latest,
      newer,
      ...(newer ? { releaseUrl: `https://github.com/googlarz/proton-mail-bridge-client/releases/tag/v${latest}` } : {}),
    };
  } catch (error) {
    return { current, newer: false, error: error instanceof Error ? error.message : String(error) };
  }
}
