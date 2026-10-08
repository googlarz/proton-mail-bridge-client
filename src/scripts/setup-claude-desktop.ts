import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { Socket } from "node:net";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  installClaudeDesktopConfig,
  resolveClaudeDesktopConfigPath,
} from "./install-claude-desktop.js";

const DEFAULT_IMAP_HOST = "127.0.0.1";
const DEFAULT_IMAP_PORT = 1143;
const DEFAULT_SMTP_HOST = "127.0.0.1";
const DEFAULT_SMTP_PORT = 1025;
const DEFAULT_DATA_DIR = join(homedir(), ".proton-mail-bridge-client");
const DEFAULT_ALLOWED_ACTIONS = "mark_read,mark_unread,star,unstar,archive,trash,restore";

export interface WizardAnswers {
  username: string;
  password: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
  dataDir?: string;
}

export function parseYesNoAnswer(value: string, defaultValue: boolean): boolean {
  const normalized = value.trim().toLowerCase();

  if (!normalized) {
    return defaultValue;
  }

  if (["y", "yes", "true", "1"].includes(normalized)) {
    return true;
  }

  if (["n", "no", "false", "0"].includes(normalized)) {
    return false;
  }

  throw new Error(`Expected yes or no, received: ${value}`);
}

export function normalizePortInput(value: string, fallback: number): number {
  const normalized = value.trim();
  if (!normalized) {
    return fallback;
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }

  return parsed;
}

export function buildWizardEnv(answers: WizardAnswers): Record<string, string> {
  return {
    PROTONMAIL_USERNAME: answers.username.trim(),
    PROTONMAIL_PASSWORD: answers.password,
    PROTONMAIL_IMAP_HOST: answers.imapHost?.trim() || DEFAULT_IMAP_HOST,
    PROTONMAIL_IMAP_PORT: String(answers.imapPort || DEFAULT_IMAP_PORT),
    PROTONMAIL_IMAP_SECURE: "false",
    PROTONMAIL_SMTP_HOST: answers.smtpHost?.trim() || DEFAULT_SMTP_HOST,
    PROTONMAIL_SMTP_PORT: String(answers.smtpPort || DEFAULT_SMTP_PORT),
    PROTONMAIL_DATA_DIR: answers.dataDir?.trim() || DEFAULT_DATA_DIR,
    PROTONMAIL_AUTO_SYNC: "true",
    PROTONMAIL_STARTUP_SYNC: "true",
    PROTONMAIL_SYNC_INTERVAL_MINUTES: "5",
    PROTONMAIL_IDLE_WATCH: "true",
    PROTONMAIL_IDLE_MAX_SECONDS: "30",
    PROTONMAIL_READ_ONLY: "false",
    PROTONMAIL_ALLOW_SEND: "true",
    PROTONMAIL_ALLOW_REMOTE_DRAFT_SYNC: "true",
    PROTONMAIL_ALLOWED_ACTIONS: DEFAULT_ALLOWED_ACTIONS,
  };
}

export async function probePort(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = new Socket();
    let finished = false;

    const finish = (result: boolean): void => {
      if (finished) {
        return;
      }

      finished = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

// readline echoes what is typed to its output stream. Handing it this stream lets a prompt switch the echo off
// (muted) for a password and back on, without touching the terminal's own mode.
export function createMutableOutput(target: { write: (chunk: string | Uint8Array, encoding?: BufferEncoding) => unknown }): {
  stream: Writable;
  setMuted: (muted: boolean) => void;
} {
  let muted = false;
  const stream = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) {
        target.write(chunk, encoding as BufferEncoding);
      }
      callback();
    },
  });
  return { stream, setMuted: (value) => { muted = value; } };
}

export async function promptSecret(
  rl: ReturnType<typeof createInterface>,
  mutable: ReturnType<typeof createMutableOutput>,
  message: string,
  defaultValue = "",
  write: (text: string) => void = (text) => { output.write(text); },
): Promise<string> {
  while (true) {
    write(`${message}: `);
    mutable.setMuted(true);
    let answer: string;
    try {
      answer = (await rl.question("")).trim();
    } finally {
      mutable.setMuted(false);
    }
    // The Enter key's newline was swallowed with the echo.
    write("\n");
    const value = answer || defaultValue;
    if (value) {
      return value;
    }
    write("This value is required.\n");
  }
}

async function promptRequired(
  rl: ReturnType<typeof createInterface>,
  message: string,
  defaultValue = "",
  showDefault = true,
): Promise<string> {
  while (true) {
    const suffix = defaultValue && showDefault ? ` [${defaultValue}]` : "";
    const value = (await rl.question(`${message}${suffix}: `)).trim() || defaultValue;
    if (value) {
      return value;
    }
    output.write("This value is required.\n");
  }
}

async function promptYesNo(
  rl: ReturnType<typeof createInterface>,
  message: string,
  defaultValue: boolean,
): Promise<boolean> {
  while (true) {
    const suffix = defaultValue ? " [Y/n]" : " [y/N]";
    try {
      return parseYesNoAnswer(await rl.question(`${message}${suffix}: `), defaultValue);
    } catch (error) {
      output.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

async function promptPort(
  rl: ReturnType<typeof createInterface>,
  message: string,
  fallback: number,
): Promise<number> {
  while (true) {
    try {
      return normalizePortInput(await rl.question(`${message} [${fallback}]: `), fallback);
    } catch (error) {
      output.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

function portFromEnv(rawValue: string | undefined, fallback: number): number {
  if (!rawValue?.trim()) {
    return fallback;
  }

  try {
    return normalizePortInput(rawValue, fallback);
  } catch {
    return fallback;
  }
}

export async function runClaudeDesktopSetupWizard(): Promise<void> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      "setup:claude-desktop needs an interactive terminal. Use npm run install:claude-desktop for a non-interactive install.",
    );
  }

  const imapReachable = await probePort(DEFAULT_IMAP_HOST, DEFAULT_IMAP_PORT);
  const smtpReachable = await probePort(DEFAULT_SMTP_HOST, DEFAULT_SMTP_PORT);
  const defaultConfigPath = resolveClaudeDesktopConfigPath();

  output.write("Proton Mail Bridge Client — Claude Desktop setup\n\n");
  output.write(`Claude Desktop config: ${defaultConfigPath}\n`);

  if (imapReachable || smtpReachable) {
    output.write(
      `Detected Proton Bridge on localhost (${imapReachable ? "IMAP ok" : "IMAP not detected"}, ${smtpReachable ? "SMTP ok" : "SMTP not detected"}).\n`,
    );
  } else {
    output.write(
      "Could not confirm Proton Bridge on 127.0.0.1:1143 / 127.0.0.1:1025. You can still continue with custom values.\n",
    );
  }

  output.write(
    "This wizard installs Proton Mail Bridge Client for Claude Desktop on this computer. It stages a stable local runtime for Claude Desktop to use across chats and workspaces. It does not create a remote URL connector.\n\n",
  );

  const mutableOutput = createMutableOutput(output);
  const rl = createInterface({ input, output: mutableOutput.stream, terminal: Boolean(input.isTTY && output.isTTY) });

  try {
    const username = await promptRequired(
      rl,
      "Proton Bridge username",
      process.env.PROTONMAIL_USERNAME?.trim() || "",
    );
    const password = await promptSecret(
      rl,
      mutableOutput,
      "Proton Bridge password (input is hidden)",
      process.env.PROTONMAIL_PASSWORD || "",
    );
    const useDefaultBridge = await promptYesNo(
      rl,
      "Use standard local Proton Bridge addresses (127.0.0.1:1143 IMAP and 127.0.0.1:1025 SMTP)",
      true,
    );

    const imapHost = useDefaultBridge
      ? DEFAULT_IMAP_HOST
      : await promptRequired(rl, "IMAP host", process.env.PROTONMAIL_IMAP_HOST || DEFAULT_IMAP_HOST);
    const imapPort = useDefaultBridge
      ? DEFAULT_IMAP_PORT
      : await promptPort(rl, "IMAP port", portFromEnv(process.env.PROTONMAIL_IMAP_PORT, DEFAULT_IMAP_PORT));
    const smtpHost = useDefaultBridge
      ? DEFAULT_SMTP_HOST
      : await promptRequired(rl, "SMTP host", process.env.PROTONMAIL_SMTP_HOST || DEFAULT_SMTP_HOST);
    const smtpPort = useDefaultBridge
      ? DEFAULT_SMTP_PORT
      : await promptPort(rl, "SMTP port", portFromEnv(process.env.PROTONMAIL_SMTP_PORT, DEFAULT_SMTP_PORT));
    const dataDir = await promptRequired(
      rl,
      "Local data directory",
      process.env.PROTONMAIL_DATA_DIR || DEFAULT_DATA_DIR,
    );

    const result = await installClaudeDesktopConfig({
      includeEnv: false,
      env: buildWizardEnv({
        username,
        password,
        imapHost,
        imapPort,
        smtpHost,
        smtpPort,
        dataDir,
      }),
    });

    output.write("\nClaude Desktop setup complete.\n");
    output.write(`- Config written to: ${result.configPath}\n`);
    output.write(`- Claude Desktop runtime installed at: ${result.runtimeDir}\n`);
    if (result.backupPath) {
      output.write(`- Previous config backup: ${result.backupPath}\n`);
    }
    output.write("- Restart Claude Desktop.\n");
    output.write("- Keep Proton Bridge open while using the tools.\n");
    output.write("- If Bridge settings change later, run this wizard again.\n");
  } finally {
    rl.close();
  }
}

const isDirectExecution =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  runClaudeDesktopSetupWizard().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
