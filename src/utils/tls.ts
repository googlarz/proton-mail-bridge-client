import { readFileSync } from "node:fs";
import type { ProtonRuntimeConfig } from "../types/index.js";

// Bridge presents a self-signed certificate made for localhost, so a connection to 127.0.0.1, localhost or ::1 skips
// verification. A Bridge reached by another name (another container, another machine on a private network) needs the
// user to say so: either trust specific host names, or pin Bridge's exported certificate.

export function isLocalBridgeHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

export function parseHostList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

type TlsRuntime = Pick<ProtonRuntimeConfig, "tlsCaFile" | "tlsInsecureHosts">;

/** TLS options for a connection to `host`, or undefined to use Node's defaults (full verification). */
export function tlsOptionsFor(host: string, runtime: TlsRuntime | undefined): Record<string, unknown> | undefined {
  const normalized = host.trim().toLowerCase();
  if (isLocalBridgeHost(normalized) || runtime?.tlsInsecureHosts?.includes(normalized)) {
    return { rejectUnauthorized: false };
  }
  if (runtime?.tlsCaFile) {
    // Trust exactly this certificate. Bridge's is made for localhost, so the name check is skipped: the pinned
    // certificate is the identity.
    return { ca: readFileSync(runtime.tlsCaFile), checkServerIdentity: () => undefined };
  }
  return undefined;
}
