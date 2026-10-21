// The Bridge version this project was last verified against. Bridge changes behaviour between releases (the
// connection modes, folder handling, what a deleted folder does to a connection), so a newer one is worth a note.
export const TESTED_BRIDGE_VERSION = [3, 27, 1] as const;

export function parseBridgeVersion(value: string | undefined): number[] | undefined {
  const match = value?.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : undefined;
}

/** A note for the user when Bridge is newer (in major or minor) than the version verified here; undefined otherwise. */
export function bridgeVersionNote(announced: { version?: string; greeting?: string } | undefined): string | undefined {
  const parsed = parseBridgeVersion(announced?.version) ?? parseBridgeVersion(announced?.greeting);
  if (!parsed) return undefined;
  const [major, minor] = parsed;
  const [testedMajor, testedMinor] = TESTED_BRIDGE_VERSION;
  if (major > testedMajor || (major === testedMajor && minor > testedMinor)) {
    return `Bridge ${parsed.join(".")} is newer than ${TESTED_BRIDGE_VERSION.join(".")}, the version this release was verified against. It will most likely work; if something behaves oddly, run \`report\` and attach it to an issue.`;
  }
  return undefined;
}
