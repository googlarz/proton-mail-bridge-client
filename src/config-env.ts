// Building the configuration from PROTONMAIL_* environment variables: the safety presets, passwords from a file or a command, additional accounts, and the checks on every value.

import { DEFAULT_PDF_MAX_MB, DEFAULT_PDF_MAX_PAGES } from "./utils/pdf-text.js";
import { isLocalBridgeHost, parseHostList } from "./utils/tls.js";
import { logger } from "./utils/logger.js";
import { DEFAULT_APPROVAL_TIMEOUT_SECONDS, parseApprovalEnv } from "./utils/approval.js";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { isValidEmail, slugifyAccountAddress } from "./utils/helpers.js";
import { parseListValues } from "./tools/args.js";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { type EmailAction, type SafetyMode, type AccountConfig, type ProtonMailConfig, type EmbeddingsConfig } from "./types/index.js";
import { checkEmbeddingsEndpoint } from "./services/embedding-service.js";
export const ALL_EMAIL_ACTIONS: EmailAction[] = [
  "mark_read",
  "mark_unread",
  "star",
  "unstar",
  "archive",
  "trash",
  "restore",
  "move",
  "delete",
];

export function readEnvValue(name: string): string | undefined {
  const direct = process.env[name]?.trim();
  if (direct) {
    return direct;
  }

  const command = process.env[`${name}_COMMAND`]?.trim();
  if (command) {
    // The platform shell: /bin/sh on macOS and Linux (as before), cmd.exe on Windows, which has no /bin/sh.
    return execSync(command, { encoding: "utf-8" }).trim();
  }

  const filePath = process.env[`${name}_FILE`]?.trim();
  if (!filePath) {
    return undefined;
  }

  return readFileSync(filePath, "utf8").trim();
}

export function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return defaultValue;
  }

  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }
  return defaultValue;
}

export function parseIntegerEnv(
  name: string,
  defaultValue: number,
  min = 1,
  max = 10_000,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return defaultValue;
  }

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    return defaultValue;
  }

  return Math.min(max, Math.max(min, parsed));
}

// Ports need a hard failure, not the silent clamping parseIntegerEnv applies
// for its other (non-port) callers — a typo like PROTONMAIL_IMAP_PORT=99999
// should abort startup with a clear message instead of quietly becoming 65535
// and failing later with a confusing connection error.
export function validatePortEnv(name: string): void {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535, got: ${raw}`);
  }
}

// One switch for the safety flags. A mode is a floor: the individual variables can make things stricter, never
// looser. The Claude Desktop bundle always sends read-only and allow-sending explicitly, so a mode that an explicit
// value could loosen would be ignored for exactly the people who pick it there.
export const SAFETY_MODES: Record<SafetyMode, { readOnly?: boolean; allowSend?: boolean; confirmDestructive?: boolean; allowedActions?: EmailAction[] }> = {
  // Browse and search only: nothing is written, nothing is sent.
  "read-only": { readOnly: true },
  // Drafts and flags; no sending, and no moving, archiving or deleting.
  drafts: { allowSend: false, allowedActions: ["mark_read", "mark_unread", "star", "unstar"] },
  // Everything except permanent deletion, and every send or delete asks for confirmed:true.
  assisted: { confirmDestructive: true, allowedActions: ALL_EMAIL_ACTIONS.filter((action) => action !== "delete") },
  full: {},
};

export function parseSafetyModeEnv(name: string): SafetyMode | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  // An unfilled "${user_config.mode}" from a host that did not substitute it is "not set", not a typo to fail on.
  if (!raw || raw.startsWith("${")) {
    return undefined;
  }
  if (Object.hasOwn(SAFETY_MODES, raw)) {
    return raw as SafetyMode;
  }
  throw new Error(`${name} must be one of: ${Object.keys(SAFETY_MODES).join(", ")} (got "${raw}").`);
}

export function parseAllowedActionsEnv(name: string): EmailAction[] {
  const configured = parseListValues(process.env[name]);
  if (configured.length === 0) {
    return [...ALL_EMAIL_ACTIONS];
  }

  const allowed = configured.filter((value): value is EmailAction =>
    ALL_EMAIL_ACTIONS.includes(value as EmailAction),
  );

  if (allowed.length === 0) {
    throw new Error(`${name} contains no valid action names. Valid values: ${ALL_EMAIL_ACTIONS.join(", ")}`);
  }

  return allowed;
}

// PROTONMAIL_ACCOUNTS_JSON: a JSON array of additional Proton addresses on the same
// account, exposed by Bridge's Split Addresses feature as their own IMAP/SMTP logins.
// Each entry only needs `address` and `password` — Bridge issues each split address its
// own Bridge-generated password but keeps the SAME host/ports as the primary connection,
// and the IMAP/SMTP username for a split address is the address itself. Any of
// imapHost/imapPort/imapSecure/imapUsername/smtpHost/smtpPort/smtpSecure/smtpUsername may
// still be overridden explicitly for setups that don't follow that default.
// Example: [{"address":"me@pm.me","password":"..."},{"address":"me@example.com","password":"...","imapUsername":"me@example.com"}]
export function parseAdditionalAccountsEnv(primary: AccountConfig): AccountConfig[] {
  const raw = process.env.PROTONMAIL_ACCOUNTS_JSON?.trim();
  if (!raw) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `PROTONMAIL_ACCOUNTS_JSON is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("PROTONMAIL_ACCOUNTS_JSON must be a JSON array.");
  }

  const seenAddresses = new Set([primary.address.toLowerCase()]);
  const seenSlugs = new Set([primary.slug]);

  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`PROTONMAIL_ACCOUNTS_JSON[${index}] must be an object.`);
    }
    const value = entry as Record<string, unknown>;
    const address = typeof value.address === "string" ? value.address.trim() : "";
    if (!address || !isValidEmail(address)) {
      throw new Error(`PROTONMAIL_ACCOUNTS_JSON[${index}].address must be a valid email address.`);
    }
    const password = readAccountPassword(value, index);
    const lowerAddress = address.toLowerCase();
    if (seenAddresses.has(lowerAddress)) {
      const isPrimary = lowerAddress === primary.address.toLowerCase();
      throw new Error(
        `PROTONMAIL_ACCOUNTS_JSON[${index}]: duplicate address "${address}".` +
          (isPrimary ? " The primary account (PROTONMAIL_USERNAME) is already configured: list only the additional accounts here." : ""),
      );
    }
    seenAddresses.add(lowerAddress);

    const slug = slugifyAccountAddress(address);
    if (!slug || seenSlugs.has(slug)) {
      throw new Error(
        `PROTONMAIL_ACCOUNTS_JSON[${index}]: address "${address}" produces an empty or duplicate account slug ("${slug}").`,
      );
    }
    seenSlugs.add(slug);

    const stringField = (key: string, fallback: string) =>
      typeof value[key] === "string" && (value[key] as string).trim() ? (value[key] as string).trim() : fallback;
    const numberField = (key: string, fallback: number) =>
      typeof value[key] === "number" && Number.isInteger(value[key]) ? (value[key] as number) : fallback;
    const boolField = (key: string, fallback: boolean) =>
      typeof value[key] === "boolean" ? (value[key] as boolean) : fallback;

    return {
      address,
      slug,
      dataDir: join(primary.dataDir, "accounts", slug),
      imap: {
        host: stringField("imapHost", primary.imap.host),
        port: numberField("imapPort", primary.imap.port),
        secure: boolField("imapSecure", primary.imap.secure),
        username: stringField("imapUsername", address),
        password: stringField("imapPassword", password),
      },
      smtp: {
        host: stringField("smtpHost", primary.smtp.host),
        port: numberField("smtpPort", primary.smtp.port),
        secure: boolField("smtpSecure", primary.smtp.secure),
        secureExplicit: typeof value.smtpSecure === "boolean" || primary.smtp.secureExplicit === true,
        username: stringField("smtpUsername", address),
        password: stringField("smtpPassword", password),
      },
      ...(typeof value.autoSyncFolder === "string" && value.autoSyncFolder.trim()
        ? { autoSyncFolder: value.autoSyncFolder.trim() }
        : {}),
    };
  });
}

// An additional account's Bridge password: inline, or read from a file / a command so it need not sit in the
// client config (same idea as PROTONMAIL_PASSWORD_FILE / _COMMAND for the primary account).
export function readAccountPassword(value: Record<string, unknown>, index: number): string {
  const where = `PROTONMAIL_ACCOUNTS_JSON[${index}]`;
  const inline = typeof value.password === "string" ? value.password : "";
  const file = typeof value.passwordFile === "string" ? value.passwordFile.trim() : "";
  const command = typeof value.passwordCommand === "string" ? value.passwordCommand.trim() : "";
  if ([inline, file, command].filter(Boolean).length > 1) {
    throw new Error(`${where}: use only one of password, passwordFile, passwordCommand.`);
  }
  let password = inline;
  try {
    if (file) password = readFileSync(file, "utf8").trim();
    else if (command) password = execSync(command, { encoding: "utf-8" }).trim();
  } catch (error) {
    throw new Error(`${where}: could not read the password from ${file ? "passwordFile" : "passwordCommand"}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!password) {
    throw new Error(`${where}.password is required (or passwordFile / passwordCommand).`);
  }
  return password;
}

// PROTONMAIL_EMBEDDINGS_URL turns on semantic search over the local index; unset, nothing about it runs. A host other
// than this machine is refused unless PROTONMAIL_EMBEDDINGS_ALLOW_REMOTE=true, since every indexed message's text goes there.
export function parseEmbeddingsEnv(): EmbeddingsConfig | undefined {
  const raw = process.env.PROTONMAIL_EMBEDDINGS_URL?.trim();
  if (!raw) {
    return undefined;
  }
  const allowRemote = parseBooleanEnv("PROTONMAIL_EMBEDDINGS_ALLOW_REMOTE", false);
  const { url, api } = checkEmbeddingsEndpoint(raw, allowRemote);
  if (allowRemote && !isLocalBridgeHost(new URL(url).hostname.replace(/^\[|\]$/g, ""))) {
    logger.warn("Semantic search sends mail text to an embedding endpoint on another host (PROTONMAIL_EMBEDDINGS_ALLOW_REMOTE).", "MCPServer", { url });
  }
  return { url, api, model: process.env.PROTONMAIL_EMBEDDINGS_MODEL?.trim() || "nomic-embed-text", allowRemote };
}

// The one configuration error the server can still answer: without a login it cannot reach Bridge, but it can
// list its tools and say what is missing (registries and MCP clients start servers without credentials to
// inspect them, and "Connection closed" tells nobody anything).
export class MissingCredentialsError extends Error {
  constructor() {
    super("Missing required environment variables or secret sources: PROTONMAIL_USERNAME and PROTONMAIL_PASSWORD.");
    this.name = "MissingCredentialsError";
  }
}

export function buildConfigFromEnv(): ProtonMailConfig {
  const username = readEnvValue("PROTONMAIL_USERNAME");
  const password = readEnvValue("PROTONMAIL_PASSWORD");

  if (!username || !password) {
    throw new MissingCredentialsError();
  }

  validatePortEnv("PROTONMAIL_SMTP_PORT");
  const smtpPort = parseIntegerEnv("PROTONMAIL_SMTP_PORT", 1025, 1, 65_535);
  // Bridge's local SMTP port requires implicit TLS from the first byte (no
  // plaintext greeting, no STARTTLS) — confirmed against a live Bridge
  // instance. Overridable for non-Bridge SMTP setups.
  const smtpSecure = parseBooleanEnv("PROTONMAIL_SMTP_SECURE", true);
  // Set by the user (a non-empty value that is not an unfilled "${user_config...}" placeholder), as opposed to the default.
  const smtpSecureRaw = process.env.PROTONMAIL_SMTP_SECURE?.trim() ?? "";
  const smtpSecureExplicit = smtpSecureRaw !== "" && !smtpSecureRaw.startsWith("${");
  validatePortEnv("PROTONMAIL_IMAP_PORT");
  const imapPort = parseIntegerEnv("PROTONMAIL_IMAP_PORT", 1143, 1, 65_535);
  const debug = parseBooleanEnv("DEBUG", false);
  const mode = parseSafetyModeEnv("PROTONMAIL_MODE");
  const preset = mode ? SAFETY_MODES[mode] : {};
  const readOnly = (preset.readOnly ?? false) || parseBooleanEnv("PROTONMAIL_READ_ONLY", false);
  const allowSend = (preset.allowSend ?? true) && parseBooleanEnv("PROTONMAIL_ALLOW_SEND", !readOnly);
  const allowRemoteDraftSync = parseBooleanEnv(
    "PROTONMAIL_ALLOW_REMOTE_DRAFT_SYNC",
    !readOnly,
  );
  const autoSync = parseBooleanEnv("PROTONMAIL_AUTO_SYNC", true);
  const syncInterval = parseIntegerEnv("PROTONMAIL_SYNC_INTERVAL_MINUTES", 5, 1, 24 * 60);
  const idleWatchEnabled = parseBooleanEnv("PROTONMAIL_IDLE_WATCH", autoSync);
  const idleMaxSeconds = parseIntegerEnv("PROTONMAIL_IDLE_MAX_SECONDS", 30, 5, 300);
  const confirmDestructive = (preset.confirmDestructive ?? false) || parseBooleanEnv("PROTONMAIL_CONFIRM_DESTRUCTIVE", false);
  const allowEmptyFolder = parseBooleanEnv("PROTONMAIL_ALLOW_EMPTY_FOLDER", false);
  const restrictOutboundToSelf = parseBooleanEnv("PROTONMAIL_RESTRICT_OUTBOUND_TO_SELF", false);
  const allowFileDownloadDir = process.env.PROTONMAIL_ALLOW_FILE_DOWNLOAD_DIR?.trim() || undefined;
  const imapUsername = process.env.PROTONMAIL_IMAP_USERNAME?.trim() || username;
  const imapPassword = process.env.PROTONMAIL_IMAP_PASSWORD?.trim() || password;
  const opDelayMs = parseIntegerEnv("PROTONMAIL_OP_DELAY_MS", 0, 0, 5000);
  const sendDelaySeconds = parseIntegerEnv("PROTONMAIL_SEND_DELAY_SECONDS", 0, 0, 300);
  const smtpHost = process.env.PROTONMAIL_SMTP_HOST || "127.0.0.1";
  // 127.0.0.1, not "localhost": Bridge listens on IPv4 loopback only, and "localhost" may
  // resolve to ::1 first (and matches what the README and the SMTP default already say).
  const imapHost = process.env.PROTONMAIL_IMAP_HOST || "127.0.0.1";
  const imapSecure = parseBooleanEnv("PROTONMAIL_IMAP_SECURE", false);
  const dataDir = process.env.PROTONMAIL_DATA_DIR?.trim() || join(homedir(), ".proton-mail-bridge-client");

  if (dataDir && !isAbsolute(dataDir)) {
    throw new Error("PROTONMAIL_DATA_DIR must be absolute, got: " + dataDir);
  }
  const embeddings = parseEmbeddingsEnv();

  logger.setDebugMode(debug);
  if (isLocalBridgeHost(smtpHost)) {
    logger.warn("TLS verification is disabled for local Bridge SMTP connections.", "MCPServer", { host: smtpHost });
  }
  if (isLocalBridgeHost(imapHost)) {
    logger.warn("TLS verification is disabled for local Bridge IMAP connections.", "MCPServer", { host: imapHost });
  }
  const insecureHosts = parseHostList(process.env.PROTONMAIL_TLS_INSECURE_HOSTS);
  for (const host of [imapHost, smtpHost]) {
    if (insecureHosts.includes(host.trim().toLowerCase())) {
      logger.warn("TLS verification is disabled for this host (PROTONMAIL_TLS_INSECURE_HOSTS).", "MCPServer", { host });
    }
  }

  const primarySmtp = { host: smtpHost, port: smtpPort, secure: smtpSecure, secureExplicit: smtpSecureExplicit, username, password };
  const primaryImap = { host: imapHost, port: imapPort, secure: imapSecure, username: imapUsername, password: imapPassword };
  const primaryAccount: AccountConfig = {
    address: username,
    slug: slugifyAccountAddress(username),
    imap: primaryImap,
    smtp: primarySmtp,
    dataDir,
  };
  const accounts: AccountConfig[] = [primaryAccount, ...parseAdditionalAccountsEnv(primaryAccount)];

  return {
    smtp: primarySmtp,
    imap: primaryImap,
    dataDir,
    debug,
    cacheEnabled: true,
    analyticsEnabled: true,
    autoSync,
    syncInterval,
    accounts,
    runtime: {
      ...(mode ? { mode } : {}),
      readOnly,
      allowSend,
      allowRemoteDraftSync,
      allowedActions: parseAllowedActionsEnv("PROTONMAIL_ALLOWED_ACTIONS").filter(
        (action) => !preset.allowedActions || preset.allowedActions.includes(action),
      ),
      startupSync: parseBooleanEnv("PROTONMAIL_STARTUP_SYNC", autoSync),
      // Comma-separated; Sent is included by default so pendingOn/digest/follow-up
      // candidates don't misreport threads that were already answered — IDLE still
      // only watches the first folder (see BackgroundSyncService.primaryIdleFolder).
      autoSyncFolder: process.env.PROTONMAIL_AUTO_SYNC_FOLDER?.trim() || "INBOX,Sent",
      autoSyncFull: parseBooleanEnv("PROTONMAIL_AUTO_SYNC_FULL", false),
      autoSyncLimitPerFolder: parseIntegerEnv("PROTONMAIL_AUTO_SYNC_LIMIT_PER_FOLDER", 100, 1, 500),
      idleWatchEnabled,
      idleMaxSeconds,
      confirmDestructive,
      approval: parseApprovalEnv("PROTONMAIL_APPROVAL"),
      approvalTimeoutSeconds: parseIntegerEnv("PROTONMAIL_APPROVAL_TIMEOUT_SECONDS", DEFAULT_APPROVAL_TIMEOUT_SECONDS, 1, 3600),
      allowEmptyFolder,
      restrictOutboundToSelf,
      allowFileDownloadDir,
      // The value is in KB despite the historical name; PROTONMAIL_MAX_INLINE_KB is the clear spelling and wins.
      maxInlineBytes: parseIntegerEnv("PROTONMAIL_MAX_INLINE_KB", parseIntegerEnv("PROTONMAIL_MAX_INLINE_BYTES", 40, 1, 10240), 1, 10240),
      shortenLinks: parseBooleanEnv("PROTONMAIL_SHORTEN_LINKS", false),
      tlsCaFile: process.env.PROTONMAIL_TLS_CA_FILE?.trim() || undefined,
      tlsInsecureHosts: parseHostList(process.env.PROTONMAIL_TLS_INSECURE_HOSTS),
      pdfMaxMb: parseIntegerEnv("PROTONMAIL_PDF_MAX_MB", DEFAULT_PDF_MAX_MB, 1, 100),
      pdfMaxPages: parseIntegerEnv("PROTONMAIL_PDF_MAX_PAGES", DEFAULT_PDF_MAX_PAGES, 1, 2000),
      ocrCommand: process.env.PROTONMAIL_OCR_COMMAND?.trim() || undefined,
      indexAttachments: parseBooleanEnv("PROTONMAIL_INDEX_ATTACHMENTS", false),
      opDelayMs,
      sendDelaySeconds,
      ...(embeddings ? { embeddings } : {}),
    },
  };
}
