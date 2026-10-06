// Pure helpers for scripts/build-mcpb.mjs, kept separate so tests can import them without
// running a build.

// Exact version: an unpinned `npx --yes @anthropic-ai/mcpb` would let a new release change the
// bundle format under a release build.
export const MCPB_VERSION = "2.1.2";

// better-sqlite3 ships N-API prebuilds for every one of these inside the package
// (node_modules/better-sqlite3/prebuilds/<platform>-<arch>.node), so one staged
// node_modules serves them all and a runner only has to re-stamp the manifest.
export const SUPPORTED_TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"];

export function parseTarget(target) {
  if (!SUPPORTED_TARGETS.includes(target)) {
    throw new Error(`Unsupported target "${target}". Supported: ${SUPPORTED_TARGETS.join(", ")}`);
  }
  const [platform, arch] = target.split("-");
  return { target, platform, arch };
}

/** `--targets a,b` (default: the host platform) -> parsed, de-duplicated targets. */
export function resolveTargets(argv, host) {
  const index = argv.indexOf("--targets");
  const raw = index === -1 ? [`${host.platform}-${host.arch}`] : (argv[index + 1] ?? "").split(",").filter(Boolean);
  if (raw.length === 0) throw new Error("--targets requires a comma-separated value.");
  return [...new Set(raw)].map(parseTarget);
}

export function bundleFileName({ platform, arch }) {
  return `proton-mail-bridge-client-${platform}-${arch}.mcpb`;
}

/** A copy of the manifest stamped with the package version and one platform. */
export function stampManifest(manifest, version, platform) {
  return {
    ...manifest,
    version,
    compatibility: { ...(manifest.compatibility ?? {}), platforms: [platform] },
  };
}
