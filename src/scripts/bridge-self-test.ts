import { buildConfigFromEnv } from "../config-env.js";
import { SimpleIMAPService } from "../services/simple-imap-service.js";
import type { Logger } from "../utils/logger.js";

export type Diagnose = (reason: unknown) => { cause: string; suggestion: string } | undefined;

export type SelfTestResult =
  | { ok: true; account: string; inboxMessages: number }
  | { ok: false; cause: string; suggestion: string };

const SELF_TEST_TIMEOUT_MS = 8000;
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

// Reads the setup's own env map without touching process.env afterwards (buildConfigFromEnv reads process.env).
function configFor(env: Record<string, string>): ReturnType<typeof buildConfigFromEnv> {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  // buildConfigFromEnv logs the server's TLS notices to stderr; they are noise inside the wizard.
  const writeStderr = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return buildConfigFromEnv();
  } finally {
    process.stderr.write = writeStderr;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// Strictly read-only: one IMAP login and one LIST with STATUS (message counts). No folder is selected, nothing is
// written, no local file is created, and the password only goes to the Bridge. Bounded by a timeout.
export async function runBridgeSelfTest(
  env: Record<string, string>,
  options: { diagnose?: Diagnose; timeoutMs?: number } = {},
): Promise<SelfTestResult> {
  const config = configFor(env);
  const service = new SimpleIMAPService(config, silentLogger);
  const timeoutMs = options.timeoutMs ?? SELF_TEST_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  try {
    const folders = await Promise.race([
      service.getFolders(true),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("Timed out waiting for Bridge"), { code: "ETIMEDOUT" })), timeoutMs);
      }),
    ]);
    const inbox = folders.find((folder) => folder.path.toUpperCase() === "INBOX");
    return { ok: true, account: config.imap.username, inboxMessages: inbox?.messages ?? 0 };
  } catch (error) {
    const diagnosis = options.diagnose?.(error);
    return {
      ok: false,
      cause: diagnosis?.cause ?? "unknown",
      suggestion:
        diagnosis?.suggestion ??
        "Bridge did not answer as expected. Check that Proton Bridge is open and signed in, then run `proton-mail-bridge-client doctor`.",
    };
  } finally {
    if (timer) clearTimeout(timer);
    // Do not wait on a logout for a Bridge that is not answering.
    void service.disconnect().catch(() => {});
  }
}

export function formatSelfTest(result: SelfTestResult): string {
  if (result.ok) {
    const count = result.inboxMessages;
    return `Bridge reachable, signed in as ${result.account}, INBOX has ${count} message${count === 1 ? "" : "s"}.\n`;
  }
  return `Could not reach your mailbox yet (${result.cause}).\nMost likely: ${result.suggestion}\n`;
}

export const NEXT_STEPS = [
  "",
  "Next steps:",
  "  1. Quit Claude Desktop completely (not just close the window) and open it again.",
  "  2. Try one of these in a new chat:",
  '       - "Summarise my unread emails from today."',
  '       - "Find the latest email from <a person you know> and tell me what they asked."',
  '       - "How many emails are in my inbox, and who sends me the most?"',
  "  3. The first time Claude uses a tool, Claude Desktop asks you to approve it. That prompt is Claude Desktop's own",
  '     safety check, not an error; choose "Allow once" or "Always allow".',
  "",
].join("\n");

// Everything the wizard prints after the config is written: the self-test (unless skipped) and the next steps.
export async function setupFollowUp(
  env: Record<string, string>,
  options: { skipCheck?: boolean; diagnose?: Diagnose; timeoutMs?: number } = {},
): Promise<string> {
  if (options.skipCheck) return NEXT_STEPS;
  const result = await runBridgeSelfTest(env, options);
  return `\nChecking your mailbox (read-only)...\n${formatSelfTest(result)}${NEXT_STEPS}`;
}
