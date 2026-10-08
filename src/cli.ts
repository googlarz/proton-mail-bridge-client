#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildConfigFromEnv, createServer, withAudit } from "./index.js";
import { isMainModule } from "./is-main.js";
import { SimpleIMAPService } from "./services/simple-imap-service.js";
import type { EmailSummary, ProtonMailConfig, SearchEmailsInput } from "./types/index.js";
import { ensureDestructiveConfirmed, ensureEmailActionAllowed, ensureMailboxWriteAllowed, sanitizeRuntimeConfig } from "./utils/runtime-policy.js";
import { isValidEmail, parseEmails } from "./utils/helpers.js";
import { getClaudeDesktopInstallStatus } from "./scripts/check-claude-desktop.js";
import { installClaudeDesktopConfig } from "./scripts/install-claude-desktop.js";
import { runClaudeDesktopSetupWizard } from "./scripts/setup-claude-desktop.js";

let _pkgVersion: string | undefined;
async function getPkgVersion(): Promise<string> {
  if (_pkgVersion) return _pkgVersion;
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  _pkgVersion = pkg.version;
  return _pkgVersion;
}

type CliFlags = Record<string, string | boolean>;

export interface ParsedCliArgs {
  command: string;
  subcommand?: string;
  positionals: string[];
  flags: CliFlags;
}

// Every flag this CLI reads via isTruthyFlag() below — none of them ever takes a value in
// practice (no command documents `--json false`). Without this set, the parser had no notion
// of which flags are boolean, so a boolean flag placed before a positional argument silently
// swallowed it as that flag's "value": `search --json invoice` set flags.json = "invoice"
// (truthy check fails => plain text, not JSON) and searched with no query at all, matching
// every message instead of the one intended. Listing them here makes such a flag always
// boolean regardless of what follows it, so the next token is correctly left as a positional.
const BOOLEAN_FLAGS = new Set([
  "all", "checkConnections", "confirmed", "dry-run", "full", "help", "html", "json", "live",
  "no-attachment-text", "permanent", "read", "reply-all", "sent", "starred", "sync", "unread",
  "unread-only", "unstar", "unstarred", "version", "wait",
]);

// A command-line mistake (unknown flag, malformed number, repeated flag, missing filter):
// reported on stderr and exits 2, as opposed to a runtime failure, which exits 1.
export class CliUsageError extends Error {}

// Option syntax: `--flag value`, `--flag=value` (split at the FIRST `=`, so the value may
// contain more), and `--` ends option parsing (everything after it is positional). A bare
// `--flag` followed by another `--token` is a boolean flag; a value that itself starts with
// `--` therefore has to use the `=` form or come after `--`. An empty string is a value.
export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const positionals: string[] = [];
  const flags: CliFlags = {};
  let optionsEnded = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (optionsEnded) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      optionsEnded = true;
      continue;
    }
    if (token === "-h" || token === "-v") {
      flags[token === "-h" ? "help" : "version"] = true;
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const equals = token.indexOf("=");
    const key = equals === -1 ? token.slice(2) : token.slice(2, equals);
    let value: string | boolean;
    if (equals !== -1) {
      value = token.slice(equals + 1);
    } else {
      const next = argv[index + 1];
      if (BOOLEAN_FLAGS.has(key) || next === undefined || next.startsWith("--")) {
        value = true;
      } else {
        value = next;
        index += 1;
      }
    }

    if (Object.hasOwn(flags, key) && !BOOLEAN_FLAGS.has(key)) {
      throw new CliUsageError(`--${key} was given more than once; pass it a single time.`);
    }
    flags[key] = value;
  }

  const command = positionals[0] || "help";
  const subcommand = command === "claude" ? positionals[1] : undefined;
  const consumed = command === "claude" ? 2 : 1;

  return {
    command,
    subcommand,
    positionals: positionals.slice(consumed),
    flags,
  };
}

function cliEntryPath(): string {
  return fileURLToPath(new URL("./index.js", import.meta.url));
}

function printHelp(): void {
  process.stdout.write(
    [
      "  ____  ____   ___ _____ ___  _   _   __  __    _    ___ _     ",
      " |  _ \\|  _ \\ / _ \\_   _/ _ \\| \\ | | |  \\/  |  / \\  |_ _| |    ",
      " | |_) | |_) | | | || || | | |  \\| | | |\\/| | / _ \\  | || |    ",
      " |  __/|  _ <| |_| || || |_| | |\\  | | |  | |/ ___ \\ | || |___",
      " |_|   |_| \\_\\\\___/ |_| \\___/|_| \\_| |_|  |_/_/   \\_\\___|_____|",
      "  Bridge Client  ·  CLI + Claude Desktop MCP for Proton Mail",
      "",
      "Usage:",
      "  proton-mail-bridge <command> [options]",
      "",
      "Commands:",
      "  status                 Show local config, index, runtime, and Claude Desktop status",
      "  doctor                 Verify IMAP, SMTP, and Claude Desktop wiring",
      "  connection-status      Show live IMAP/SMTP connectivity state",
      "  runtime-status         Show runtime policy and background sync state",
      "  sync                   Refresh the local index from Proton Bridge",
      "  index-status           Show local index health and freshness",
      "  folders                List available folders from Proton Bridge",
      "  create-folder <path>   Create a mailbox folder (e.g. Folders/Receipts)",
      "  rename-folder <p> <p2> Rename a folder (or use --to <newPath>)",
      "  delete-folder <path>   Delete an empty folder",
      "  empty-folder <folder>  Permanently empty a folder (--confirmed to execute)",
      "  labels                 List normalized labels from the local index",
      "  threads [query]        List normalized threads from the local index",
      "  digest                 Show inbox digest and top actionable threads",
      "  followups              Show follow-up candidates from the local index",
      "  emails                 List emails from a folder (--folder --limit --offset)",
      "  attachments <emailId>  List attachments for one message",
      "  search [query]         Search indexed mail (default) or live mail with --live",
      "  read <emailId>         Read one email by composite email id",
      "  move <emailId> <fldr>  Move an email to another folder",
      "  archive <emailId>      Archive an email",
      "  trash <emailId>        Move an email to Trash",
      "  restore <emailId>      Restore an email from Trash to Inbox",
      "  mark-read <emailId>    Mark read (--unread to flip)",
      "  star <emailId>         Star an email (--unstar to flip)",
      "  delete <emailId>       Permanently delete an email",
      "  batch <action> <ids…>  Apply action to multiple emails (or --ids)",
      "  bulk-delete            Delete matching emails (--folder --from --dry-run)",
      "  bulk-move <folder>     Move matching emails (--folder --from --dry-run)",
      "  send                   Send an email (--to --subject --body or stdin, --undo-window <s>, --wait)",
      "  reply <emailId>        Reply to an email (--body or stdin, --reply-all)",
      "  forward <emailId>      Forward an email (--to, optional --body or stdin)",
      "  test-email <addr>      Send a test email to verify SMTP (--confirmed if required)",
      "  thread <id>            Fetch a full thread by id",
      "  thread-brief <id>      Summarise a thread (latest in/out, next action)",
      "  thread-action <id> <a> Apply action to all messages in a thread",
      "  actionable             List actionable threads",
      "  document-threads       Find threads with important attachments",
      "  meeting-context <who>  Prep context for a meeting (--domain also accepted)",
      "  stats                  Mailbox counts and analytics sample",
      "  analytics              Detailed mailbox analytics (top senders, busy hours)",
      "  folder-stats [folder]  Live message stats for a folder",
      "  contacts               Contacts ranked by interaction volume",
      "  volume-trends          Daily message counts (--days, default 30)",
      "  watch                  Wait for mailbox changes via IMAP IDLE (--timeout)",
      "  clear-cache            Clear in-memory MCP server caches",
      "  get-logs               Return recent in-memory MCP server logs",
      "  notify                 Daemon: watch INBOX and send a system notification on new mail (--folder --timeout)",
      "  drafts                 List local drafts",
      "  remote-drafts          List drafts in the Proton Drafts mailbox",
      "  draft-create           Create a draft (--to --subject --body or stdin)",
      "  draft-read <id>        Read a saved draft",
      "  draft-update <id>      Update a draft (--subject --body --to etc.)",
      "  draft-reply <emailId>  Create a reply draft (--body or stdin, --reply-all)",
      "  draft-forward <id>     Create a forward draft (--to, --body or stdin)",
      "  draft-sync <id>        Sync a local draft to the Proton Drafts mailbox",
      "  draft-send <id>        Send a saved draft",
      "  draft-delete <id>      Delete a saved draft",
      "  draft-thread-reply <id> Create a reply draft for a thread",
      "  tools                  List every MCP tool exposed by the server",
      "  tool <name>            Call any MCP tool with JSON arguments",
      "",
      "Additional 1:1 tool commands (required args positional, rest via --args):",
      ...TOOL_ONLY_COMMANDS.map((entry) => `  ${entry.command.padEnd(23)} ${entry.help}`),
      "",
      "  claude setup           Run the interactive Claude Desktop setup wizard",
      "  claude install         Install or update the Claude Desktop runtime",
      "  claude check           Check Claude Desktop integration status",
      "  claude update          Alias for claude install",
      "  setup-claude-desktop   Run the Claude Desktop setup wizard (works from any install)",
      "",
      "Global flags:",
      "  --version, -v          Print version and exit",
      "  --json                 Print machine-readable JSON",
      "  --help, -h             Show help for a command (never runs it): proton-mail-bridge send --help",
      "  --flag=value           Same as --flag value; required when the value starts with --",
      "  --                     End of options: everything after it is a plain argument",
      "",
      "Exit codes: 0 success, 1 failure (including a failed doctor/connection check or a failed",
      "  item in batch/bulk runs), 2 usage error (unknown flag, bad number, missing bulk filter).",
      "",
      "Search flags:",
      "  --folder <name>        Limit to one folder",
      "  --limit <n>            Limit results",
      "  --live                 Use live IMAP search instead of the local index",
      "  --sync                 Refresh the local index before indexed search",
      "  --label <name>         Filter by normalized label",
      "  --from <value>         Filter by sender",
      "  --to <value>           Filter by recipient",
      "  --subject <value>      Filter by subject",
      "  --domain <value>       Filter by sender domain",
      "  --dateFrom <value>     Filter from this date/time",
      "  --dateTo <value>       Filter through this date/time",
      "  --read / --unread      Filter by read state",
      "  --starred / --unstarred Filter by star state",
      "",
      "Examples:",
      "  proton-mail-bridge doctor",
      "  proton-mail-bridge sync --folder INBOX --limit 150",
      "  proton-mail-bridge folders --json",
      "  proton-mail-bridge digest --json",
      "  proton-mail-bridge attachments INBOX::25642 --json",
      "  proton-mail-bridge search \"label:inbox invoice\"",
      "  proton-mail-bridge search --live --from openai.com",
      "  proton-mail-bridge read INBOX::25642",
      "  proton-mail-bridge tools",
      "  proton-mail-bridge tool get_connection_status",
      "  proton-mail-bridge tool search_indexed_emails --args '{\"query\":\"invoice\",\"limit\":3}'",
      "  proton-mail-bridge claude check",
    ].join("\n"),
  );
}

// Every hand-written command: usage line, one-line description and the flags it reads.
// `--json`, `--help` and `--version` are accepted by every command and are not repeated
// here. A flag that is not listed for its command is a usage error (exit 2), so this table
// is also what `<command> --help` prints. Table-driven 1:1 tool commands
// (TOOL_ONLY_COMMANDS below) get their spec derived from their own entry.
interface CommandSpec {
  usage: string;
  description: string;
  flags: string[];
}

const BODY_FLAGS = ["body"];
const SEARCH_FLAGS = ["folder", "limit", "live", "sync", "label", "from", "to", "subject", "domain", "dateFrom", "dateTo", "read", "unread", "starred", "unstarred"];
const DRAFT_COPY_FLAGS = ["cc", "bcc", "notes"];
const BULK_FILTER_FLAGS = ["from", "subject", "since", "before"];

export const COMMAND_SPECS: Record<string, CommandSpec> = {
  completion: { usage: "completion <zsh|bash|fish>", description: "Print a shell completion script for the commands and their flags", flags: [] },
  help: { usage: "help [command]", description: "Show the command list, or the help for one command", flags: [] },
  version: { usage: "version", description: "Print the version and exit", flags: [] },
  "setup-claude-desktop": { usage: "setup-claude-desktop", description: "Run the Claude Desktop setup wizard (works from any install)", flags: [] },
  claude: { usage: "claude <setup|install|check|update|doctor>", description: "Claude Desktop integration: setup wizard, install or update the runtime, check status (update is an alias for install, doctor for check)", flags: [] },
  status: { usage: "status", description: "Show local config, index, runtime, and Claude Desktop status", flags: [] },
  doctor: { usage: "doctor", description: "Verify IMAP, SMTP, and Claude Desktop wiring (exits 1 when the check fails)", flags: [] },
  "connection-status": { usage: "connection-status", description: "Show live IMAP/SMTP connectivity state (exits 1 when either is unreachable)", flags: [] },
  "runtime-status": { usage: "runtime-status", description: "Show runtime policy and background sync state", flags: [] },
  sync: { usage: "sync [--folder <name>] [--limit <n>] [--full]", description: "Refresh the local index from Proton Bridge", flags: ["folder", "limit", "full", "no-attachment-text"] },
  "index-status": { usage: "index-status", description: "Show local index health and freshness", flags: [] },
  folders: { usage: "folders", description: "List available folders from Proton Bridge", flags: [] },
  "create-folder": { usage: "create-folder <path>", description: "Create a mailbox folder (e.g. Folders/Receipts)", flags: ["path"] },
  "rename-folder": { usage: "rename-folder <path> <newPath>", description: "Rename a folder (or use --to <newPath>)", flags: ["path", "to", "new-path"] },
  "delete-folder": { usage: "delete-folder <path> [--confirmed]", description: "Delete an empty folder", flags: ["path", "confirmed"] },
  "empty-folder": { usage: "empty-folder <folder> [--confirmed]", description: "Permanently empty a folder (--confirmed to execute)", flags: ["folder", "confirmed"] },
  labels: { usage: "labels [--limit <n>]", description: "List normalized labels from the local index", flags: ["limit"] },
  threads: { usage: "threads [query] [--label <name>] [--limit <n>] [--sync]", description: "List normalized threads from the local index", flags: ["sync", "folder", "limit", "label"] },
  digest: { usage: "digest [--limit <n>] [--age-hours <n>] [--sync]", description: "Show inbox digest and top actionable threads", flags: ["sync", "limit", "age-hours"] },
  followups: { usage: "followups [--pending you|them|any] [--limit <n>] [--age-hours <n>] [--sync]", description: "Show follow-up candidates from the local index", flags: ["sync", "pending", "limit", "age-hours"] },
  emails: { usage: "emails [--folder <name>] [--limit <n>] [--offset <n>]", description: "List emails from a folder", flags: ["folder", "limit", "offset"] },
  attachments: { usage: "attachments <emailId>", description: "List attachments for one message", flags: [] },
  search: { usage: "search [query] [--live] [--sync] [filters]", description: "Search indexed mail (default) or live mail with --live", flags: SEARCH_FLAGS },
  read: { usage: "read <emailId>", description: "Read one email by composite email id", flags: [] },
  move: { usage: "move <emailId> <folder>", description: "Move an email to another folder (target folder as second argument or --folder)", flags: ["folder"] },
  archive: { usage: "archive <emailId>", description: "Archive an email", flags: [] },
  trash: { usage: "trash <emailId>", description: "Move an email to Trash", flags: [] },
  restore: { usage: "restore <emailId> [--folder <name>]", description: "Restore an email from Trash to Inbox (or --folder)", flags: ["folder"] },
  "mark-read": { usage: "mark-read <emailId> [--unread]", description: "Mark read (--unread to flip)", flags: ["unread"] },
  star: { usage: "star <emailId> [--unstar]", description: "Star an email (--unstar to flip)", flags: ["unstar"] },
  delete: { usage: "delete <emailId> [--confirmed]", description: "Permanently delete an email", flags: ["confirmed"] },
  batch: { usage: "batch <action> <emailId...> [--ids <a,b,c>] [--folder <name>] [--dry-run]", description: "Apply an action (mark_read|mark_unread|star|unstar|archive|trash|restore) to multiple emails; exits 1 if any item failed", flags: ["action", "ids", "folder", "dry-run"] },
  "bulk-delete": { usage: "bulk-delete (--from <v> | --subject <v> | --since <date> | --before <date>)... [--folder <name>] [--dry-run] [--permanent] [--max <n>] [--confirmed]", description: "Delete emails matching the filters (moves to Trash unless --permanent). At least one filter is required; use --dry-run first", flags: [...BULK_FILTER_FLAGS, "folder", "dry-run", "permanent", "max", "confirmed"] },
  "bulk-move": { usage: "bulk-move <folder> (--from <v> | --subject <v> | --since <date> | --before <date>)... [--folder <name>] [--dry-run] [--max <n>]", description: "Move emails matching the filters to a folder. At least one filter is required; use --dry-run first", flags: [...BULK_FILTER_FLAGS, "target-folder", "folder", "dry-run", "max"] },
  send: { usage: "send --to <addr> --subject <text> (--body <text> | stdin) [--cc <a>] [--bcc <a>] [--html] [--dry-run] [--confirmed] [--undo-window <s>] [--wait]", description: "Send an email", flags: ["to", "cc", "bcc", "subject", ...BODY_FLAGS, "html", "dry-run", "confirmed", "undo-window", "wait"] },
  reply: { usage: "reply <emailId> (--body <text> | stdin) [--reply-all] [--confirmed] [--undo-window <s>]", description: "Reply to an email", flags: [...BODY_FLAGS, "reply-all", "all", "confirmed", "undo-window"] },
  forward: { usage: "forward <emailId> --to <addr> [--body <text> | stdin] [--confirmed] [--undo-window <s>]", description: "Forward an email", flags: ["to", ...BODY_FLAGS, "confirmed", "undo-window"] },
  "test-email": { usage: "test-email <addr> [--message <text>] [--confirmed]", description: "Send a test email to verify SMTP (--confirmed if required)", flags: ["to", "message", "confirmed"] },
  thread: { usage: "thread <threadId>", description: "Fetch a full thread by id", flags: ["id"] },
  "thread-brief": { usage: "thread-brief <threadId>", description: "Summarise a thread (latest in/out, next action)", flags: ["id"] },
  "thread-action": { usage: "thread-action <threadId> <action> [--folder <name>] [--unread-only] [--dry-run]", description: "Apply an action to all messages in a thread", flags: ["id", "action", "folder", "unread-only", "dry-run"] },
  actionable: { usage: "actionable [--limit <n>]", description: "List actionable threads", flags: ["limit"] },
  "document-threads": { usage: "document-threads [query] [--category <name>] [--limit <n>] [--sync]", description: "Find threads with important attachments", flags: ["category", "limit", "sync"] },
  "meeting-context": { usage: "meeting-context <person> [--domain <d>] [--limit <n>] [--sync]", description: "Prep context for a meeting", flags: ["person", "domain", "limit", "sync"] },
  stats: { usage: "stats", description: "Mailbox counts and analytics sample", flags: [] },
  analytics: { usage: "analytics", description: "Detailed mailbox analytics (top senders, busy hours)", flags: [] },
  "folder-stats": { usage: "folder-stats [folder]", description: "Live message stats for a folder", flags: ["folder"] },
  contacts: { usage: "contacts [--limit <n>]", description: "Contacts ranked by interaction volume", flags: ["limit"] },
  "volume-trends": { usage: "volume-trends [--days <n>]", description: "Daily message counts (default 30 days)", flags: ["days"] },
  watch: { usage: "watch [--folder <name>] [--timeout <s>]", description: "Wait for mailbox changes via IMAP IDLE", flags: ["folder", "timeout"] },
  "clear-cache": { usage: "clear-cache", description: "Clear in-memory MCP server caches", flags: [] },
  "get-logs": { usage: "get-logs [--limit <n>] [--offset <n>] [--level <level>]", description: "Return recent in-memory MCP server logs", flags: ["limit", "level", "offset"] },
  notify: { usage: "notify [--folder <name>] [--timeout <s>]", description: "Daemon: watch a folder and send a system notification on new mail", flags: ["folder", "timeout"] },
  drafts: { usage: "drafts [--sent]", description: "List local drafts", flags: ["sent"] },
  "remote-drafts": { usage: "remote-drafts [--limit <n>] [--offset <n>]", description: "List drafts in the Proton Drafts mailbox", flags: ["limit", "offset"] },
  "draft-create": { usage: "draft-create --subject <text> [--to <addr>] (--body <text> | stdin) [--cc <a>] [--bcc <a>]", description: "Create a draft", flags: ["to", "cc", "bcc", "subject", ...BODY_FLAGS] },
  "draft-read": { usage: "draft-read <id>", description: "Read a saved draft", flags: ["id"] },
  "draft-update": { usage: "draft-update <id> [--subject <text>] [--body <text> | stdin] [--to <a>] [--cc <a>] [--bcc <a>] [--notes <text>]", description: "Update a draft", flags: ["id", "to", "cc", "bcc", "subject", ...BODY_FLAGS, "notes"] },
  "draft-reply": { usage: "draft-reply <emailId> (--body <text> | stdin) [--reply-all]", description: "Create a reply draft", flags: ["id", ...BODY_FLAGS, "reply-all", "all", ...DRAFT_COPY_FLAGS] },
  "draft-forward": { usage: "draft-forward <emailId> --to <addr> [--body <text> | stdin]", description: "Create a forward draft", flags: ["id", "to", ...BODY_FLAGS, ...DRAFT_COPY_FLAGS] },
  "draft-sync": { usage: "draft-sync <id>", description: "Sync a local draft to the Proton Drafts mailbox", flags: ["id"] },
  "draft-send": { usage: "draft-send <id> [--args '{...}']", description: "Send a saved draft (dryRun etc. via --args)", flags: ["id", "args", "args-file"] },
  "draft-delete": { usage: "draft-delete <id>", description: "Delete a saved draft", flags: ["id"] },
  "draft-thread-reply": { usage: "draft-thread-reply <threadId> (--body <text> | stdin) [--reply-all]", description: "Create a reply draft for a thread", flags: ["id", ...BODY_FLAGS, "reply-all", "all", ...DRAFT_COPY_FLAGS] },
  tools: { usage: "tools", description: "List every MCP tool exposed by the server", flags: [] },
  tool: { usage: "tool <name> [--args '{...}' | --args-file <path>]", description: "Call any MCP tool with JSON arguments", flags: ["args", "args-file"] },
};

const GLOBAL_FLAGS = ["json", "help", "version", "v"];

function specForCommand(command: string): CommandSpec | undefined {
  const spec = COMMAND_SPECS[command];
  if (spec) return spec;
  const entry = TOOL_ONLY_COMMANDS.find((candidate) => candidate.command === command);
  if (!entry) return undefined;
  const positionals = entry.positionals.map((field) => ` <${field}>`).join("");
  const fileFlag = entry.fileField || entry.fileFieldBase64 ? ["file"] : [];
  return {
    usage: `${entry.command}${positionals}${fileFlag.length ? " --file <path>" : ""} [--args '{...}' | --args-file <path>]`,
    description: `${entry.help} (MCP tool ${entry.tool})`,
    flags: ["args", "args-file", ...fileFlag, ...(entry.boolFlags ?? [])],
  };
}

// Tab completion for the commands and flags above. The scripts are generated from the same tables the parser and
// `--help` use, so they cannot drift from what the CLI accepts.
export const COMPLETION_SHELLS = ["zsh", "bash", "fish"] as const;
const CLI_BINARIES = ["proton-mail-bridge-client", "proton-mail-bridge"];

export function completionCommands(): Array<{ name: string; description: string; flags: string[] }> {
  const names = [...new Set([...Object.keys(COMMAND_SPECS), ...TOOL_ONLY_COMMANDS.map((entry) => entry.command)])].sort();
  return names.flatMap((name) => {
    const spec = specForCommand(name);
    if (!spec) return [];
    const description = spec.description.replace(/\s*\(MCP tool [a-z_]+\)\s*$/, "").replace(/\s+/g, " ").trim();
    return [{ name, description, flags: [...new Set([...spec.flags, "json", "help"])].sort() }];
  });
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

export function completionScript(shell: string): string {
  const commands = completionCommands();
  if (shell === "bash") {
    const cases = commands
      .map((command) => `    ${command.name}) COMPREPLY=( $(compgen -W ${shellQuote(command.flags.map((flag) => `--${flag}`).join(" "))} -- "$cur") ) ;;`)
      .join("\n");
    return [
      "# bash completion for proton-mail-bridge-client. Load it with:",
      "#   source <(proton-mail-bridge-client completion bash)",
      "_proton_mail_bridge_client() {",
      '  local cur="${COMP_WORDS[COMP_CWORD]}"',
      "  if [ \"$COMP_CWORD\" -eq 1 ]; then",
      `    COMPREPLY=( $(compgen -W ${shellQuote(commands.map((command) => command.name).join(" "))} -- "$cur") )`,
      "    return",
      "  fi",
      '  case "${COMP_WORDS[1]}" in',
      cases,
      "  esac",
      "}",
      ...CLI_BINARIES.map((binary) => `complete -F _proton_mail_bridge_client ${binary}`),
      "",
    ].join("\n");
  }
  if (shell === "zsh") {
    const list = commands.map((command) => `    ${shellQuote(`${command.name}:${command.description.replace(/:/g, " -")}`)}`).join("\n");
    const cases = commands
      .map((command) => `    ${command.name}) _arguments ${command.flags.map((flag) => shellQuote(`--${flag}`)).join(" ")} ;;`)
      .join("\n");
    return [
      `#compdef ${CLI_BINARIES.join(" ")}`,
      "# zsh completion for proton-mail-bridge-client. Load it with:",
      "#   source <(proton-mail-bridge-client completion zsh)   (after compinit)",
      "_proton_mail_bridge_client() {",
      "  local -a commands",
      "  commands=(",
      list,
      "  )",
      "  if (( CURRENT == 2 )); then",
      "    _describe -t commands 'command' commands",
      "    return",
      "  fi",
      '  case "$words[2]" in',
      cases,
      "  esac",
      "}",
      `compdef _proton_mail_bridge_client ${CLI_BINARIES.join(" ")}`,
      "",
    ].join("\n");
  }
  if (shell === "fish") {
    const lines: string[] = [];
    for (const binary of CLI_BINARIES) {
      lines.push(`complete -c ${binary} -f`);
      for (const command of commands) {
        lines.push(`complete -c ${binary} -n '__fish_use_subcommand' -a ${command.name} -d ${shellQuote(command.description)}`);
        for (const flag of command.flags) {
          lines.push(`complete -c ${binary} -n '__fish_seen_subcommand_from ${command.name}' -l ${flag}`);
        }
      }
    }
    return ["# fish completion for proton-mail-bridge-client. Load it with:", "#   proton-mail-bridge-client completion fish | source", ...lines, ""].join("\n");
  }
  throw new CliUsageError(`completion needs a shell: ${COMPLETION_SHELLS.join(", ")}.`);
}

export function commandHelpText(command: string): string | undefined {
  const spec = specForCommand(command);
  if (!spec) return undefined;
  const flags = [...new Set([...spec.flags, ...GLOBAL_FLAGS.filter((flag) => flag !== "v")])];
  return [
    `Usage: proton-mail-bridge ${spec.usage}`,
    "",
    spec.description,
    "",
    `Options: ${flags.map((flag) => `--${flag}`).join(" ")}`,
    "",
    "A value that starts with -- must be written --flag=value (or placed after a bare --).",
    "",
  ].join("\n");
}

// Rejects any flag the command does not read, instead of silently dropping it (a mistyped
// filter on a bulk command would otherwise widen what the command matches).
function assertKnownFlags(parsed: ParsedCliArgs): void {
  const spec = specForCommand(parsed.command);
  if (!spec) return;
  const allowed = new Set([...GLOBAL_FLAGS, ...spec.flags]);
  const unknown = Object.keys(parsed.flags).filter((flag) => !allowed.has(flag));
  if (unknown.length === 0) return;
  const valid = [...allowed].filter((flag) => flag !== "v").map((flag) => `--${flag}`).join(", ");
  throw new CliUsageError(
    `Unknown flag ${unknown.map((flag) => `--${flag}`).join(", ")} for ${parsed.command}. Valid flags: ${valid}. Run "${parsed.command} --help" for usage.`,
  );
}

function isTruthyFlag(value: string | boolean | undefined): boolean {
  if (value === true) {
    return true;
  }
  if (typeof value !== "string") {
    return false;
  }
  return ["1", "true", "yes", "y"].includes(value.trim().toLowerCase());
}

function getStringFlag(flags: CliFlags, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// Strict: digits only ("5x", "1.5", "-1" and "" are rejected rather than read as 5, 1, ...).
function parseIntegerFlag(flags: CliFlags, key: string, minimum: number, requirement: string): number | undefined {
  const value = flags[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new CliUsageError(`--${key} requires a value (${requirement}).`);
  }
  const trimmed = value.trim();
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new CliUsageError(`--${key} must be ${requirement}, got "${value}".`);
  }
  return parsed;
}

function getNumberFlag(flags: CliFlags, key: string, fallback: number): number {
  return parseIntegerFlag(flags, key, 1, "a positive integer") ?? fallback;
}

// Same as getNumberFlag but for flags like --offset where 0 is the
// documented default and a legitimate explicit value ("start from the
// beginning"), not an error — only negative/non-integer values are invalid.
function getOffsetFlag(flags: CliFlags, key: string, fallback: number): number {
  return parseIntegerFlag(flags, key, 0, "a non-negative integer") ?? fallback;
}

// Free text (bodies, notes): returned exactly as given, so leading indentation survives.
// A blank value counts as absent, like getStringFlag.
function getTextFlag(flags: CliFlags, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

// A piped body: one trailing newline is the shell's, everything else is the author's. An
// all-whitespace stdin counts as no body.
async function readStdinBody(): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim() ? text.replace(/\r?\n$/, "") : undefined;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function tableEmails(emails: EmailSummary[]): string {
  if (emails.length === 0) {
    return "No results.\n";
  }

  return [
    "Results:",
    ...emails.map((email, index) => {
      const from = Array.isArray(email.from)
        ? (email.from as Array<{ address?: string; name?: string }>).map((entry) => entry.address || entry.name || "").filter(Boolean).join(", ")
        : "";
      return `${index + 1}. ${email.id} | ${email.subject || "(no subject)"} | ${from} | ${email.date || email.internalDate || ""}`;
    }),
  ].join("\n") + "\n";
}

function summarizeThreadList(value: Record<string, unknown>): string {
  const threads = Array.isArray(value.threads) ? value.threads as Array<Record<string, unknown>> : [];
  if (threads.length === 0) {
    return "No threads.\n";
  }

  return [
    `Threads: ${value.total ?? value.totalThreads ?? threads.length}`,
    ...threads.map((thread, index) => {
      const subject = String(thread.subject || "(no subject)");
      const count = thread.messageCount ?? "?";
      const pending = thread.pendingOn ? ` | pending: ${thread.pendingOn}` : "";
      const latest = thread.latestDate ? ` | ${thread.latestDate}` : "";
      return `${index + 1}. ${thread.id} | ${subject} | messages: ${count}${pending}${latest}`;
    }),
  ].join("\n") + "\n";
}

function printToolCallResult(result: Record<string, unknown>, wantJson: boolean): void {
  if (wantJson) {
    process.stdout.write(json(result));
    return;
  }

  if (typeof result.structuredContent === "object" && result.structuredContent) {
    process.stdout.write(`${JSON.stringify(result.structuredContent, null, 2)}\n`);
    return;
  }

  const content = Array.isArray(result.content) ? result.content : [];
  if (content.length === 0) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const rendered = content
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return String(entry);
      }
      if ("type" in entry && entry.type === "text" && "text" in entry) {
        return String(entry.text);
      }
      if ("type" in entry && entry.type === "resource" && "resource" in entry) {
        const resource = entry.resource;
        if (resource && typeof resource === "object") {
          if ("text" in resource) {
            return String(resource.text);
          }
          if ("blob" in resource) {
            return `[resource blob] ${String(resource.uri ?? "")}`;
          }
        }
      }
      if ("type" in entry && entry.type === "resource_link") {
        return `${String(entry.title || entry.name || entry.uri || "resource")} -> ${String(entry.uri || "")}`;
      }
      return JSON.stringify(entry, null, 2);
    })
    .filter(Boolean)
    .join("\n\n");

  process.stdout.write(`${rendered}\n`);
}

// Tools whose result reports per-item failures: the call still returns a full JSON result,
// but a run where any item failed must not look like success to a script.
const ITEM_RESULT_TOOLS = new Set([
  "batch_email_action", "bulk_delete", "bulk_move", "bulk_update_flags", "bulk_update_labels", "apply_thread_action",
]);

// 1 for an error result, a failed item in a batch/bulk run, or a failed health check
// (get_connection_status / run_doctor report smtp.ok / imap.ok); 0 otherwise. The printed
// JSON is never altered by this.
export function toolResultExitCode(toolName: string, result: Record<string, unknown>): number {
  if (result.isError === true) return 1;
  const data = result.structuredContent;
  if (!data || typeof data !== "object") return 0;
  const record = data as Record<string, unknown>;
  if (ITEM_RESULT_TOOLS.has(toolName) && typeof record.failed === "number" && record.failed > 0) return 1;
  if (toolName === "get_connection_status" || toolName === "run_doctor") {
    for (const side of [record.smtp, record.imap]) {
      if (side && typeof side === "object" && (side as Record<string, unknown>).ok === false) return 1;
    }
  }
  return 0;
}

async function withMcpClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliEntryPath()],
    env: Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
    stderr: "ignore",
  });

  const client = new Client(
    {
      name: "proton-mail-bridge-cli",
      version: await getPkgVersion(),
    },
    {
      capabilities: {},
    },
  );

  const callTool = client.callTool.bind(client);
  client.callTool = (async (params: Parameters<typeof callTool>[0], ...rest: unknown[]) => {
    const result = await (callTool as (...args: unknown[]) => Promise<Record<string, unknown>>)(params, ...rest);
    if (toolResultExitCode(params.name, result) !== 0) process.exitCode = 1;
    return result;
  }) as typeof client.callTool;

  try {
    await client.connect(transport);
    return await run(client);
  } finally {
    await Promise.allSettled([client.close(), transport.close()]);
  }
}

async function parseToolArgs(parsed: ParsedCliArgs): Promise<Record<string, unknown> | undefined> {
  const inline = getStringFlag(parsed.flags, "args");
  if (inline) {
    const parsedInline = JSON.parse(inline) as unknown;
    if (!parsedInline || typeof parsedInline !== "object" || Array.isArray(parsedInline)) {
      throw new Error("--args must be a JSON object.");
    }
    return parsedInline as Record<string, unknown>;
  }

  const file = getStringFlag(parsed.flags, "args-file");
  if (file) {
    const raw = await readFile(file, "utf8");
    const parsedFile = JSON.parse(raw) as unknown;
    if (!parsedFile || typeof parsedFile !== "object" || Array.isArray(parsedFile)) {
      throw new Error("--args-file must contain a JSON object.");
    }
    return parsedFile as Record<string, unknown>;
  }

  return undefined;
}

function summarizeDigest(value: Record<string, unknown>): string {
  const counts = (value.counts && typeof value.counts === "object") ? value.counts as Record<string, unknown> : {};
  const topThreads = Array.isArray(value.topThreads) ? value.topThreads as Array<Record<string, unknown>> : [];
  const stale = Array.isArray(value.staleAwaitingYou) ? value.staleAwaitingYou as Array<Record<string, unknown>> : [];

  return [
    "Inbox digest",
    `Total threads: ${counts.totalThreads ?? 0}`,
    `Unread threads: ${counts.unreadThreads ?? 0}`,
    `Pending on you: ${counts.pendingOnYou ?? 0}`,
    `Pending on them: ${counts.pendingOnThem ?? 0}`,
    `Stale awaiting you: ${counts.staleAwaitingYou ?? 0}`,
    "",
    "Top threads:",
    ...(topThreads.length > 0
      ? topThreads.map((thread, index) => `${index + 1}. ${thread.subject || "(no subject)"} | ${thread.latestDate || ""}`)
      : ["None"]),
    "",
    "Stale awaiting you:",
    ...(stale.length > 0
      ? stale.map((thread, index) => `${index + 1}. ${thread.subject || "(no subject)"} | ${thread.latestDate || ""}`)
      : ["None"]),
  ].join("\n") + "\n";
}

async function withServices<T>(run: (context: ReturnType<typeof createServer> & { config: ProtonMailConfig }) => Promise<T>): Promise<T> {
  const config = buildConfigFromEnv();
  const services = createServer(config, { startBackgroundSync: false });

  try {
    return await run({ config, ...services });
  } finally {
    services.backgroundSyncService.stop();
    await Promise.allSettled([services.imapService.disconnect(), services.smtpService.close()]);
  }
}

async function syncIndex(context: ReturnType<typeof createServer>, input: {
  folder?: string;
  full?: boolean;
  limitPerFolder?: number;
  includeAttachmentText?: boolean;
}) {
  const snapshot = await context.imapService.collectEmailsForIndex({
    ...input,
    checkpoints: await context.localIndexService.getSyncCheckpointMap(),
  });
  const index = await context.localIndexService.recordSnapshot({
    folders: snapshot.folders,
    emails: snapshot.emails,
    syncedAt: snapshot.syncedAt,
    folderStats: snapshot.folderStats,
  });

  return {
    syncedAt: snapshot.syncedAt,
    full: Boolean(input.full),
    folders: snapshot.folderStats,
    cachedMessages: snapshot.emails.length,
    index,
  };
}

function renderStatus(status: Record<string, unknown>): string {
  const lines = [
    "Proton Mail Bridge status",
    `Version: ${status.version || "unknown"} (${status.entrypoint || "unknown entrypoint"})`,
    `Account: ${status.account || "unknown"}`,
    `IMAP: ${status.imapHost}:${status.imapPort}`,
    `SMTP: ${status.smtpHost}:${status.smtpPort}`,
  ];

  const index = status.index as Record<string, unknown> | undefined;
  if (index) {
    lines.push(`Index path: ${index.path || "unknown"}`);
    lines.push(`Indexed messages: ${index.dedupedMessageCount || 0}`);
    lines.push(`Index updated: ${index.updatedAt || "never"}`);
  }

  const claude = status.claudeDesktop as Record<string, unknown> | undefined;
  if (claude) {
    lines.push(`Claude Desktop installed: ${claude.installed ? "yes" : "no"}`);
    if (claude.runtimeDir) {
      lines.push(`Claude runtime: ${String(claude.runtimeDir)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function buildSearchFilters(parsed: ParsedCliArgs): SearchEmailsInput {
  return {
    query: parsed.positionals.join(" ") || undefined,
    folder: getStringFlag(parsed.flags, "folder"),
    label: getStringFlag(parsed.flags, "label"),
    from: getStringFlag(parsed.flags, "from"),
    to: getStringFlag(parsed.flags, "to"),
    subject: getStringFlag(parsed.flags, "subject"),
    senderDomain: getStringFlag(parsed.flags, "domain"),
    dateFrom: getStringFlag(parsed.flags, "dateFrom"),
    dateTo: getStringFlag(parsed.flags, "dateTo"),
    limit: getNumberFlag(parsed.flags, "limit", 25),
    isRead: isTruthyFlag(parsed.flags.read) ? true : isTruthyFlag(parsed.flags.unread) ? false : undefined,
    isStarred: isTruthyFlag(parsed.flags.starred) ? true : isTruthyFlag(parsed.flags.unstarred) ? false : undefined,
  };
}

async function runStatus(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ config, localIndexService, backgroundSyncService }) => {
    const [index, claudeDesktop] = await Promise.all([
      localIndexService.getStatus(),
      getClaudeDesktopInstallStatus(),
    ]);

    const result = {
      version: await getPkgVersion(),
      entrypoint: cliEntryPath(),
      account: config.smtp.username,
      imapHost: config.imap.host,
      imapPort: config.imap.port,
      smtpHost: config.smtp.host,
      smtpPort: config.smtp.port,
      runtime: sanitizeRuntimeConfig(config.runtime),
      index,
      backgroundSync: backgroundSyncService.getStatus(),
      claudeDesktop,
    };

    process.stdout.write(wantJson ? json(result) : renderStatus(result));
  });
}

async function runDoctor(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ config, smtpService, imapService, localIndexService }) => {
    const [claudeDesktop, index] = await Promise.all([
      getClaudeDesktopInstallStatus(),
      localIndexService.getStatus(),
    ]);

    let imapOk = false;
    let smtpOk = false;
    let folderCount = 0;
    let error: string | undefined;

    try {
      await imapService.ping();
      imapOk = true;
      folderCount = (await imapService.getFolders(true)).length;
      await smtpService.verifyConnection();
      smtpOk = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const result = {
      ok: imapOk && smtpOk,
      // A stale/orphaned install elsewhere on disk (wrong path, old
      // version) looks identical to a fresh one on every other field
      // above — this is the field that actually distinguishes them.
      version: await getPkgVersion(),
      entrypoint: cliEntryPath(),
      account: config.smtp.username,
      imapOk,
      smtpOk,
      folderCount,
      indexUpdatedAt: index.updatedAt,
      claudeDesktopInstalled: claudeDesktop.installed,
      error,
    };

    process.stdout.write(wantJson ? json(result) : `${result.ok ? "Doctor OK" : "Doctor failed"}\n${json(result)}`);
    if (!result.ok) process.exitCode = 1;
  });
}

async function runConnectionStatus(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ config, smtpService, imapService }) => {
    let imapOk = false;
    let smtpOk = false;
    let error: string | undefined;
    try {
      await imapService.ping();
      imapOk = true;
      await smtpService.verifyConnection();
      smtpOk = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const result = {
      account: config.smtp.username,
      imap: {
        host: config.imap.host,
        port: config.imap.port,
        ok: imapOk,
      },
      smtp: {
        host: config.smtp.host,
        port: config.smtp.port,
        ok: smtpOk,
      },
      idle: imapService.getIdleStatus(),
      error,
    };

    process.stdout.write(wantJson ? json(result) : `${JSON.stringify(result, null, 2)}\n`);
    if (!(imapOk && smtpOk)) process.exitCode = 1;
  });
}

async function runRuntimeStatus(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ config, backgroundSyncService, draftStore, localIndexService }) => {
    const result = {
      account: config.smtp.username,
      runtime: sanitizeRuntimeConfig(config.runtime),
      backgroundSync: backgroundSyncService.getStatus(),
      localIndex: await localIndexService.getStatus(),
      drafts: {
        total: (await draftStore.listDrafts(true)).length,
        active: (await draftStore.listDrafts(false)).length,
      },
    };
    process.stdout.write(wantJson ? json(result) : `${JSON.stringify(result, null, 2)}\n`);
  });
}

async function runSync(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async (context) => {
    const result = await syncIndex(context, {
      folder: getStringFlag(parsed.flags, "folder"),
      full: isTruthyFlag(parsed.flags.full),
      limitPerFolder: getNumberFlag(parsed.flags, "limit", 100),
      includeAttachmentText: !isTruthyFlag(parsed.flags["no-attachment-text"]),
    });
    process.stdout.write(wantJson ? json(result) : `${JSON.stringify(result, null, 2)}\n`);
  });
}

async function runIndexStatus(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ localIndexService }) => {
    const result = await localIndexService.getStatus();
    if (wantJson) {
      process.stdout.write(json(result));
      return;
    }
    process.stdout.write(
      [
        "Index status",
        `Path: ${result.path}`,
        `Updated: ${result.updatedAt || "never"}`,
        `Messages: ${result.dedupedMessageCount}`,
        `Threads: ${result.threadCount}`,
        `Labels: ${result.labelCount}`,
        `Stale: ${result.isStale ? "yes" : "no"}`,
      ].join("\n") + "\n",
    );
  });
}

async function runFolders(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ imapService }) => {
    const folders = await imapService.getFolders(true);
    process.stdout.write(wantJson ? json(folders) : `${JSON.stringify(folders, null, 2)}\n`);
  });
}

async function runLabels(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ localIndexService }) => {
    const result = await localIndexService.getLabels(getNumberFlag(parsed.flags, "limit", 100));
    if (wantJson) {
      process.stdout.write(json(result));
      return;
    }
    process.stdout.write(
      result.length === 0
        ? "No labels.\n"
        : result.map((label, index) => `${index + 1}. ${label.name} | ${label.type} | messages: ${label.messageCount}`).join("\n") + "\n",
    );
  });
}

async function runThreads(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  const syncBefore = isTruthyFlag(parsed.flags.sync);
  await withServices(async (context) => {
    if (syncBefore) {
      await syncIndex(context, {
        folder: getStringFlag(parsed.flags, "folder"),
        limitPerFolder: Math.max(getNumberFlag(parsed.flags, "limit", 25), 100),
        includeAttachmentText: true,
      });
    }
    const result = await context.localIndexService.getThreads({
      query: parsed.positionals.join(" ") || undefined,
      label: getStringFlag(parsed.flags, "label"),
      limit: getNumberFlag(parsed.flags, "limit", 25),
    });
    process.stdout.write(wantJson ? json(result) : summarizeThreadList(result as Record<string, unknown>));
  });
}

async function runDigest(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  const syncBefore = isTruthyFlag(parsed.flags.sync);
  await withServices(async (context) => {
    if (syncBefore) {
      await syncIndex(context, { folder: "INBOX", limitPerFolder: 100, includeAttachmentText: true });
    }
    const result = await context.localIndexService.getInboxDigest({
      limit: getNumberFlag(parsed.flags, "limit", 10),
      minAgeHours: getNumberFlag(parsed.flags, "age-hours", 24),
    });
    process.stdout.write(wantJson ? json(result) : summarizeDigest(result as Record<string, unknown>));
  });
}

async function runFollowups(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  const syncBefore = isTruthyFlag(parsed.flags.sync);
  await withServices(async (context) => {
    if (syncBefore) {
      await syncIndex(context, { folder: "INBOX", limitPerFolder: 100, includeAttachmentText: true });
    }
    const pendingOnRaw = getStringFlag(parsed.flags, "pending");
    const pendingOn =
      pendingOnRaw === "you" || pendingOnRaw === "them" || pendingOnRaw === "any"
        ? pendingOnRaw
        : "you";
    const result = await context.localIndexService.getFollowUpCandidates({
      limit: getNumberFlag(parsed.flags, "limit", 25),
      minAgeHours: getNumberFlag(parsed.flags, "age-hours", 24),
      pendingOn,
    });
    process.stdout.write(wantJson ? json(result) : summarizeThreadList(result as Record<string, unknown>));
  });
}

async function runDrafts(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ draftStore }) => {
    const result = await draftStore.listDrafts(isTruthyFlag(parsed.flags.sent));
    if (wantJson) {
      process.stdout.write(json(result));
      return;
    }
    process.stdout.write(
      result.length === 0
        ? "No drafts.\n"
        : result.map((draft, index) => `${index + 1}. ${draft.id} | ${draft.mode} | ${draft.subject}`).join("\n") + "\n",
    );
  });
}

// The single-message shortcuts below go through the same MCP tool handlers as every other
// client, so `<slug>::<id>` account routing, the uidValidity check, runtime policy
// (PROTONMAIL_ALLOWED_ACTIONS, CONFIRM_DESTRUCTIVE) and auditing all apply exactly as they
// do there. They used to call the primary account's IMAP service directly, bypassing all of it.
function structuredResult(result: Record<string, unknown>): Record<string, unknown> {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent as Record<string, unknown>;
  }
  const content = Array.isArray(result.content) ? (result.content as Array<{ type?: string; text?: string }>) : [];
  const text = content.find((entry) => entry.type === "text")?.text;
  try {
    const parsed = text ? (JSON.parse(text) as unknown) : undefined;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function runToolShortcut(
  parsed: ParsedCliArgs,
  toolName: string,
  args: Record<string, unknown>,
  render: (data: Record<string, unknown>) => string,
): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = (await client.callTool({ name: toolName, arguments: args })) as Record<string, unknown>;
    if (result.isError === true) {
      printToolCallResult(result, wantJson);
      return;
    }
    const data = structuredResult(result);
    process.stdout.write(wantJson ? json(data) : render(data));
  });
}

async function runAttachments(parsed: ParsedCliArgs): Promise<void> {
  const emailId = parsed.positionals[0];
  if (!emailId) {
    throw new Error("attachments requires an emailId, for example: proton-mail-bridge attachments INBOX::123");
  }
  await runToolShortcut(parsed, "list_attachments", { emailId }, (data) => {
    const attachments = Array.isArray(data.attachments) ? (data.attachments as Array<Record<string, unknown>>) : [];
    return attachments.length === 0
      ? "No attachments.\n"
      : attachments.map((attachment, index) => `${index + 1}. ${attachment.filename || attachment.id || "(unnamed)"} | ${attachment.contentType || "unknown"} | ${attachment.kind || "other"}`).join("\n") + "\n";
  });
}

async function runSearch(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  const live = isTruthyFlag(parsed.flags.live);
  const syncBefore = isTruthyFlag(parsed.flags.sync);
  const filters = buildSearchFilters(parsed);

  await withMcpClient(async (client) => {
    // An empty index is refreshed by search_indexed_emails itself; --sync forces a refresh first.
    if (!live && syncBefore) {
      await client.callTool({
        name: "sync_emails",
        arguments: { folder: filters.folder, limitPerFolder: Math.max(filters.limit ?? 25, 100) },
      });
    }
    const result = (await client.callTool({
      name: live ? "search_emails" : "search_indexed_emails",
      arguments: { ...filters },
    })) as Record<string, unknown>;
    if (result.isError === true) {
      printToolCallResult(result, wantJson);
      return;
    }
    const data = structuredResult(result);
    process.stdout.write(wantJson ? json(data) : tableEmails(Array.isArray(data.emails) ? (data.emails as EmailSummary[]) : []));
  });
}

async function runRead(parsed: ParsedCliArgs): Promise<void> {
  const emailId = parsed.positionals[0];
  if (!emailId) {
    throw new Error("read requires an emailId, for example: proton-mail-bridge read INBOX::123");
  }

  await runToolShortcut(parsed, "get_email_by_id", { emailId }, (detail) => {
    const from = Array.isArray(detail.from) ? (detail.from as Array<Record<string, unknown>>) : [];
    const lines = [
      `ID: ${detail.id}`,
      `Subject: ${detail.subject}`,
      `From: ${from.map((entry) => entry.address || entry.name || "").filter(Boolean).join(", ")}`,
      `Date: ${detail.date || detail.internalDate || ""}`,
      "",
      detail.text || detail.preview || "(no text body available)",
    ];
    return `${lines.join("\n")}\n`;
  });
}

// ── write commands ──────────────────────────────────────────────────────────

async function runMove(parsed: ParsedCliArgs): Promise<void> {
  const emailId = parsed.positionals[0];
  const targetFolder = parsed.positionals[1] || getStringFlag(parsed.flags, "folder");
  if (!emailId) throw new Error("move requires an emailId");
  if (!targetFolder) throw new Error("move requires a target folder as a second argument or --folder");
  await runToolShortcut(parsed, "move_email", { emailId, targetFolder }, (result) => `Moved ${emailId} → ${result.targetFolder}\n`);
}

async function runArchive(parsed: ParsedCliArgs): Promise<void> {
  const emailId = parsed.positionals[0];
  if (!emailId) throw new Error("archive requires an emailId");
  await runToolShortcut(parsed, "archive_email", { emailId }, (result) => `Archived ${emailId} → ${result.targetFolder}\n`);
}

async function runTrash(parsed: ParsedCliArgs): Promise<void> {
  const emailId = parsed.positionals[0];
  if (!emailId) throw new Error("trash requires an emailId");
  await runToolShortcut(parsed, "trash_email", { emailId }, (result) => `Trashed ${emailId} → ${result.targetFolder}\n`);
}

async function runRestore(parsed: ParsedCliArgs): Promise<void> {
  const emailId = parsed.positionals[0];
  if (!emailId) throw new Error("restore requires an emailId");
  await runToolShortcut(
    parsed,
    "restore_email",
    { emailId, targetFolder: getStringFlag(parsed.flags, "folder") },
    (result) => `Restored ${emailId} → ${result.targetFolder}\n`,
  );
}

async function runMarkRead(parsed: ParsedCliArgs): Promise<void> {
  const emailId = parsed.positionals[0];
  if (!emailId) throw new Error("mark-read requires an emailId");
  const isRead = !isTruthyFlag(parsed.flags.unread);
  await runToolShortcut(parsed, "mark_email_read", { emailId, isRead }, (result) => `Marked ${emailId} as ${result.isRead ? "read" : "unread"}\n`);
}

async function runStar(parsed: ParsedCliArgs): Promise<void> {
  const emailId = parsed.positionals[0];
  if (!emailId) throw new Error("star requires an emailId");
  const isStarred = !isTruthyFlag(parsed.flags.unstar);
  await runToolShortcut(parsed, "star_email", { emailId, isStarred }, (result) => `${result.isStarred ? "Starred" : "Unstarred"} ${emailId}\n`);
}

async function runDelete(parsed: ParsedCliArgs): Promise<void> {
  const emailId = parsed.positionals[0];
  if (!emailId) throw new Error("delete requires an emailId");
  await runToolShortcut(
    parsed,
    "delete_email",
    { emailId, confirmed: isTruthyFlag(parsed.flags.confirmed) || undefined },
    () => `Deleted ${emailId}\n`,
  );
}

async function runSend(parsed: ParsedCliArgs): Promise<void> {
  const to = getStringFlag(parsed.flags, "to");
  const cc = getStringFlag(parsed.flags, "cc");
  const bcc = getStringFlag(parsed.flags, "bcc");
  const subject = getStringFlag(parsed.flags, "subject");
  if (!to) throw new Error("send requires --to");
  if (!subject) throw new Error("send requires --subject");

  const body = getTextFlag(parsed.flags, "body") ?? (await readStdinBody());
  if (!body) throw new Error("send requires --body or body piped via stdin");

  const wantJson = isTruthyFlag(parsed.flags.json);
  const wait = isTruthyFlag(parsed.flags.wait);
  const undoWindowSeconds = parseUndoWindowFlag(parsed);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "send_email",
      arguments: {
        to,
        cc,
        bcc,
        subject,
        body,
        isHtml: isTruthyFlag(parsed.flags.html) || undefined,
        dryRun: isTruthyFlag(parsed.flags["dry-run"]) || undefined,
        confirmed: isTruthyFlag(parsed.flags.confirmed) || undefined,
        undoWindowSeconds,
      },
    });
    const parsedResult = result as Record<string, unknown>;
    const structured = (parsedResult.structuredContent ?? {}) as Record<string, unknown>;

    if (!structured.queued) {
      printToolCallResult(parsedResult, wantJson);
      return;
    }

    if (!wait) {
      printToolCallResult(parsedResult, wantJson);
      if (!wantJson) {
        process.stderr.write(
          "Note: this queued send only fires while an MCP server (e.g. Claude Desktop) is running against the same data directory — this CLI process exits immediately after queuing, so it will NOT deliver on its own. Pass --wait to have this command stay open until it fires or is canceled.\n",
        );
      }
      return;
    }

    // --wait: keep this process (and its spawned server) alive until the
    // queued send actually resolves, closing exactly the gap in the note
    // above — polls list_scheduled_sends since there's no per-id get.
    const id = structured.id as string;
    if (!wantJson) {
      process.stderr.write(`Waiting for queued send ${id} to fire (sendAt ${structured.sendAt})...\n`);
    }
    for (;;) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2000));
      // limit 10000 = every record: the id being waited on must be found however old
      // the queue is (the default page is only the 50 newest).
      const listResult = await client.callTool({ name: "list_scheduled_sends", arguments: { limit: 10000 } });
      const listContent = (listResult as { content?: Array<{ type: string; text?: string }> }).content ?? [];
      const rawText = listContent.find((entry) => entry.type === "text")?.text ?? "{}";
      const items = (JSON.parse(rawText) as { items?: Array<Record<string, unknown>> }).items ?? [];
      const item = items.find((entry) => entry.id === id);
      // "sending" is a transient claimed-but-not-finished state (see the
      // atomic pending->sending claim in DeliveryQueueService.checkDue) —
      // keep polling through it, only stop at a genuinely terminal status.
      const terminal = !item || ["sent", "failed", "canceled"].includes(String(item.status));
      if (terminal) {
        process.stdout.write(wantJson ? json(item ?? { id, status: "unknown" }) : `${item?.status ?? "unknown"}: ${id}\n`);
        return;
      }
    }
  });
}

// Not getNumberFlag: 0 is a meaningful, valid value here (force an immediate send even
// when the server has a default undo window configured), but getNumberFlag rejects <= 0
// for the flags where only a positive count makes sense (limit, offset, ...).
function parseUndoWindowFlag(parsed: ParsedCliArgs): number | undefined {
  const requested = parseIntegerFlag(parsed.flags, "undo-window", 0, "an integer between 0 and 300");
  if (requested !== undefined && requested > 300) {
    throw new CliUsageError(`--undo-window must be an integer between 0 and 300, got "${String(parsed.flags["undo-window"])}".`);
  }
  return requested;
}

// A CLI process exits right after the call, and the undo-send queue only fires while an
// MCP server (e.g. Claude Desktop) is running against the same data directory — say so
// instead of letting a queued reply/forward look sent.
function noteIfQueued(result: Record<string, unknown>, wantJson: boolean): void {
  const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
  if (structured.queued && !wantJson) {
    process.stderr.write(
      "Note: queued, not sent yet. It only fires while an MCP server (e.g. Claude Desktop) is running against the same data directory — this CLI process exits now. Cancel with cancel-send, or pass --undo-window 0 to send immediately.\n",
    );
  }
}

async function runReply(parsed: ParsedCliArgs): Promise<void> {
  const emailId = parsed.positionals[0];
  if (!emailId) throw new Error("reply requires an emailId");
  const replyAll = isTruthyFlag(parsed.flags["reply-all"]) || isTruthyFlag(parsed.flags.all);

  const body = getTextFlag(parsed.flags, "body") ?? (await readStdinBody());
  if (!body) throw new Error("reply requires --body or body piped via stdin");

  const wantJson = isTruthyFlag(parsed.flags.json);
  // Goes through the same MCP handler as every other client, so send policy
  // (read-only/allowSend, RESTRICT_OUTBOUND_TO_SELF, CONFIRM_DESTRUCTIVE, account
  // routing) applies here exactly as it does there. This used to build the message and
  // call SMTP directly, bypassing all of it.
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "reply_to_email",
      arguments: { emailId, body, replyAll: replyAll || undefined, confirmed: isTruthyFlag(parsed.flags.confirmed) || undefined, undoWindowSeconds: parseUndoWindowFlag(parsed) },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
    noteIfQueued(result as Record<string, unknown>, wantJson);
  });
}

async function runForward(parsed: ParsedCliArgs): Promise<void> {
  const emailId = parsed.positionals[0];
  if (!emailId) throw new Error("forward requires an emailId");
  const to = parseEmails(getStringFlag(parsed.flags, "to") || "");
  if (to.length === 0) throw new Error("forward requires --to");

  const body = getTextFlag(parsed.flags, "body") ?? (await readStdinBody());

  const wantJson = isTruthyFlag(parsed.flags.json);
  // Same reasoning as runReply: use the shared MCP handler so send policy applies.
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "forward_email",
      arguments: { emailId, to: to.join(", "), body, confirmed: isTruthyFlag(parsed.flags.confirmed) || undefined, undoWindowSeconds: parseUndoWindowFlag(parsed) },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
    noteIfQueued(result as Record<string, unknown>, wantJson);
  });
}

async function runCreateFolder(parsed: ParsedCliArgs): Promise<void> {
  const path = parsed.positionals[0] || getStringFlag(parsed.flags, "path");
  if (!path) throw new Error("create-folder requires a path argument");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ config, imapService, auditService }) => {
    ensureMailboxWriteAllowed(config.runtime);
    const result = await withAudit(auditService, "create_folder", { path }, () => imapService.createFolder(path));
    process.stdout.write(wantJson ? json(result) : `${result.created ? "Created" : "Already existed"}: ${result.path}\n`);
  });
}

async function runRenameFolder(parsed: ParsedCliArgs): Promise<void> {
  const path = parsed.positionals[0] || getStringFlag(parsed.flags, "path");
  const newPath = parsed.positionals[1] || getStringFlag(parsed.flags, "to") || getStringFlag(parsed.flags, "new-path");
  if (!path) throw new Error("rename-folder requires a source path argument");
  if (!newPath) throw new Error("rename-folder requires a target path as second argument or --to");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ config, imapService, auditService }) => {
    ensureMailboxWriteAllowed(config.runtime);
    const result = await withAudit(auditService, "rename_folder", { path, newPath }, () => imapService.renameFolder(path, newPath));
    process.stdout.write(wantJson ? json(result) : `Renamed: ${result.path} → ${result.newPath}\n`);
  });
}

async function runDeleteFolder(parsed: ParsedCliArgs): Promise<void> {
  const path = parsed.positionals[0] || getStringFlag(parsed.flags, "path");
  if (!path) throw new Error("delete-folder requires a path argument");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ config, imapService, auditService }) => {
    // Same bypass as runDelete's identical gap — see its comment.
    ensureEmailActionAllowed(config.runtime, "delete");
    ensureDestructiveConfirmed(config.runtime, isTruthyFlag(parsed.flags.confirmed), `Permanently delete folder and all messages in it: ${path}`);
    const result = await withAudit(auditService, "delete_folder", { path }, () => imapService.deleteFolder(path));
    process.stdout.write(wantJson ? json(result) : `Deleted folder: ${result.path}\n`);
  });
}

async function runEmptyFolder(parsed: ParsedCliArgs): Promise<void> {
  const folder = parsed.positionals[0] || getStringFlag(parsed.flags, "folder");
  if (!folder) throw new Error("empty-folder requires a folder argument");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "empty_folder",
      arguments: {
        folder,
        confirmed: isTruthyFlag(parsed.flags.confirmed) || undefined,
      },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

// The server resolves an empty `match` to the whole folder, so a bulk command with no filter
// would act on up to every message in it. Refuse here, before anything connects.
function requireBulkFilter(command: string, filters: Array<string | undefined>): void {
  if (filters.every((filter) => !filter)) {
    throw new CliUsageError(
      `${command} requires at least one of --from, --subject, --since, --before (without a filter it would match the whole folder). Use --dry-run to preview what a filter matches.`,
    );
  }
}

async function runBulkDelete(parsed: ParsedCliArgs): Promise<void> {
  const from = getStringFlag(parsed.flags, "from");
  const subject = getStringFlag(parsed.flags, "subject");
  const since = getStringFlag(parsed.flags, "since");
  const before = getStringFlag(parsed.flags, "before");
  requireBulkFilter("bulk-delete", [from, subject, since, before]);
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "bulk_delete",
      arguments: {
        folder: getStringFlag(parsed.flags, "folder"),
        match: {
          ...(from ? { from } : {}),
          ...(subject ? { subject } : {}),
          ...(since ? { since } : {}),
          ...(before ? { before } : {}),
        },
        dryRun: isTruthyFlag(parsed.flags["dry-run"]) || undefined,
        permanent: isTruthyFlag(parsed.flags.permanent) || undefined,
        maxBatchSize: getStringFlag(parsed.flags, "max") ? getNumberFlag(parsed.flags, "max", 0) : undefined,
        confirmed: isTruthyFlag(parsed.flags.confirmed) || undefined,
      },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runBulkMove(parsed: ParsedCliArgs): Promise<void> {
  const targetFolder = parsed.positionals[0] || getStringFlag(parsed.flags, "target-folder");
  if (!targetFolder) throw new Error("bulk-move requires a target folder argument");
  const from = getStringFlag(parsed.flags, "from");
  const subject = getStringFlag(parsed.flags, "subject");
  const since = getStringFlag(parsed.flags, "since");
  const before = getStringFlag(parsed.flags, "before");
  requireBulkFilter("bulk-move", [from, subject, since, before]);
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "bulk_move",
      arguments: {
        targetFolder,
        folder: getStringFlag(parsed.flags, "folder"),
        match: {
          ...(from ? { from } : {}),
          ...(subject ? { subject } : {}),
          ...(since ? { since } : {}),
          ...(before ? { before } : {}),
        },
        dryRun: isTruthyFlag(parsed.flags["dry-run"]) || undefined,
        maxBatchSize: getStringFlag(parsed.flags, "max") ? getNumberFlag(parsed.flags, "max", 0) : undefined,
      },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runClearCache(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({ name: "clear_cache", arguments: {} });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runGetLogs(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "get_logs",
      arguments: {
        limit: getNumberFlag(parsed.flags, "limit", 100),
        level: getStringFlag(parsed.flags, "level"),
        offset: getStringFlag(parsed.flags, "offset") ? getOffsetFlag(parsed.flags, "offset", 0) : undefined,
      },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runFolderStats(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "folder_stats",
      arguments: { folder: parsed.positionals[0] || getStringFlag(parsed.flags, "folder") },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

// draft commands go through withMcpClient to reuse policy/remote-sync logic in index.ts
async function runEmails(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "get_emails",
      arguments: {
        folder: getStringFlag(parsed.flags, "folder") || "INBOX",
        limit: getNumberFlag(parsed.flags, "limit", 50),
        offset: getOffsetFlag(parsed.flags, "offset", 0),
      },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runThread(parsed: ParsedCliArgs): Promise<void> {
  const threadId = parsed.positionals[0] || getStringFlag(parsed.flags, "id");
  if (!threadId) throw new Error("thread requires a threadId");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({ name: "get_thread_by_id", arguments: { threadId } });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runThreadBrief(parsed: ParsedCliArgs): Promise<void> {
  const threadId = parsed.positionals[0] || getStringFlag(parsed.flags, "id");
  if (!threadId) throw new Error("thread-brief requires a threadId");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({ name: "get_thread_brief", arguments: { threadId } });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runActionable(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "get_actionable_threads",
      arguments: { limit: getNumberFlag(parsed.flags, "limit", 25) },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runDocumentThreads(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "find_document_threads",
      arguments: {
        category: getStringFlag(parsed.flags, "category"),
        query: parsed.positionals.join(" ") || undefined,
        limit: getNumberFlag(parsed.flags, "limit", 25),
        sync: isTruthyFlag(parsed.flags.sync) || undefined,
      },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runMeetingContext(parsed: ParsedCliArgs): Promise<void> {
  const person = parsed.positionals[0] || getStringFlag(parsed.flags, "person");
  const domain = getStringFlag(parsed.flags, "domain");
  if (!person && !domain) throw new Error("meeting-context requires a person argument or --domain");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "prepare_meeting_context",
      arguments: {
        person,
        domain,
        limit: getNumberFlag(parsed.flags, "limit", 10),
        sync: isTruthyFlag(parsed.flags.sync) || undefined,
      },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runThreadAction(parsed: ParsedCliArgs): Promise<void> {
  const threadId = parsed.positionals[0] || getStringFlag(parsed.flags, "id");
  const action = parsed.positionals[1] || getStringFlag(parsed.flags, "action");
  if (!threadId) throw new Error("thread-action requires a threadId");
  if (!action) throw new Error("thread-action requires an action (mark_read|mark_unread|star|unstar|archive|trash|restore)");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "apply_thread_action",
      arguments: {
        threadId,
        action,
        targetFolder: getStringFlag(parsed.flags, "folder"),
        unreadOnly: isTruthyFlag(parsed.flags["unread-only"]) || undefined,
        dryRun: isTruthyFlag(parsed.flags["dry-run"]) || undefined,
      },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runBatch(parsed: ParsedCliArgs): Promise<void> {
  const action = parsed.positionals[0] || getStringFlag(parsed.flags, "action");
  const emailIds = parsed.positionals.slice(1).join(",") || getStringFlag(parsed.flags, "ids");
  if (!action) throw new Error("batch requires an action (mark_read|mark_unread|star|unstar|archive|trash|restore)");
  if (!emailIds) throw new Error("batch requires email ids as positional args or --ids");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "batch_email_action",
      arguments: {
        emailIds,
        action,
        targetFolder: getStringFlag(parsed.flags, "folder"),
        dryRun: isTruthyFlag(parsed.flags["dry-run"]) || undefined,
      },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runStats(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({ name: "get_email_stats", arguments: {} });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runAnalytics(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({ name: "get_email_analytics", arguments: {} });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runContacts(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "get_contacts",
      arguments: { limit: getNumberFlag(parsed.flags, "limit", 100) },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runVolumeTrends(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "get_volume_trends",
      arguments: { days: getNumberFlag(parsed.flags, "days", 30) },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runWatch(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "wait_for_mailbox_changes",
      arguments: {
        folder: getStringFlag(parsed.flags, "folder") || "INBOX",
        timeoutSeconds: getNumberFlag(parsed.flags, "timeout", 15),
      },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function sendSystemNotification(title: string, body: string): Promise<void> {
  const execFileAsync = promisify(execFile);
  try {
    if (process.platform === "darwin") {
      const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
      await execFileAsync("osascript", ["-e", script]);
    } else if (process.platform === "linux") {
      const { spawn } = await import("node:child_process");
      await new Promise<void>((resolve) => {
        const proc = spawn("notify-send", [title, body], { stdio: "ignore" });
        proc.on("close", () => { resolve(); });
        proc.on("error", () => { resolve(); }); // notify-send may not be installed
      });
    }
    // Windows: no built-in toast without extra deps — stdout line is the fallback
  } catch {
    // Silent — stdout already carries the event
  }
}

async function runNotify(parsed: ParsedCliArgs): Promise<void> {
  const folder = getStringFlag(parsed.flags, "folder") || "INBOX";
  const timeoutSeconds = getNumberFlag(parsed.flags, "timeout", 30);

  const config = buildConfigFromEnv();
  const imapService = new SimpleIMAPService(config);

  let running = true;
  let previousCount: number | undefined;

  const shutdown = () => { running = false; };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  process.stderr.write(`[notify] Watching ${folder} for new mail (IMAP IDLE). Ctrl+C to stop.\n`);

  while (running) {
    try {
      const result = await imapService.waitForMailboxChanges({
        folder,
        timeoutMs: timeoutSeconds * 1000,
      });

      if (!running) break;

      if (result.changed) {
        const existsEvent = result.events.find((e) => e["type"] === "exists");
        if (existsEvent) {
          const newCount = typeof existsEvent["count"] === "number" ? (existsEvent["count"] as number) : undefined;
          const delta =
            previousCount !== undefined && newCount !== undefined && newCount > previousCount
              ? newCount - previousCount
              : undefined;
          previousCount = newCount ?? previousCount;

          const n = delta ?? 1;
          const body = `${n} new message${n !== 1 ? "s" : ""} in ${folder}`;
          await sendSystemNotification("Proton Mail", body);
          process.stdout.write(
            JSON.stringify({ event: "new_mail", folder, count: n, at: result.checkedAt }) + "\n",
          );
        } else {
          // flags / expunge only — track count but don't notify
          const existsOnAny = result.events.find((e) => typeof e["count"] === "number");
          if (existsOnAny) previousCount = existsOnAny["count"] as number;
        }
      }
    } catch (error) {
      if (!running) break;
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[notify] Watch error: ${msg}\n`);
      // Simple backoff before retrying
      await new Promise<void>((resolve) => { setTimeout(resolve, 15_000).unref(); });
    }
  }

  try {
    await imapService.disconnect();
  } catch {
    // ignore
  }
  process.stderr.write("[notify] Stopped.\n");
}

async function runTestEmail(parsed: ParsedCliArgs): Promise<void> {
  const to = parsed.positionals[0] || getStringFlag(parsed.flags, "to");
  if (!to) throw new Error("test-email requires a recipient address");
  if (!isValidEmail(to)) throw new Error("test-email: invalid email address");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "send_test_email",
      arguments: {
        to,
        customMessage: getTextFlag(parsed.flags, "message"),
        confirmed: isTruthyFlag(parsed.flags.confirmed) || undefined,
      },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runDraftCreate(parsed: ParsedCliArgs): Promise<void> {
  const to = getStringFlag(parsed.flags, "to") || "";
  const subject = getStringFlag(parsed.flags, "subject");
  if (!subject) throw new Error("draft-create requires --subject");
  const body = getTextFlag(parsed.flags, "body") ?? (await readStdinBody());
  if (!body) throw new Error("draft-create requires --body or body piped via stdin");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "create_draft",
      arguments: { to, subject, body, cc: getStringFlag(parsed.flags, "cc") || "", bcc: getStringFlag(parsed.flags, "bcc") || "" },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runDraftRead(parsed: ParsedCliArgs): Promise<void> {
  const draftId = parsed.positionals[0] || getStringFlag(parsed.flags, "id");
  if (!draftId) throw new Error("draft-read requires a draft id");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({ name: "get_draft", arguments: { draftId } });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runDraftUpdate(parsed: ParsedCliArgs): Promise<void> {
  const draftId = parsed.positionals[0] || getStringFlag(parsed.flags, "id");
  if (!draftId) throw new Error("draft-update requires a draft id");
  const body = getTextFlag(parsed.flags, "body") ?? (await readStdinBody());
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "update_draft",
      arguments: {
        draftId,
        to: getStringFlag(parsed.flags, "to"),
        cc: getStringFlag(parsed.flags, "cc"),
        bcc: getStringFlag(parsed.flags, "bcc"),
        subject: getStringFlag(parsed.flags, "subject"),
        body: body || undefined,
        notes: getTextFlag(parsed.flags, "notes"),
      },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runDraftReply(parsed: ParsedCliArgs): Promise<void> {
  const emailId = parsed.positionals[0] || getStringFlag(parsed.flags, "id");
  if (!emailId) throw new Error("draft-reply requires an emailId");
  const body = getTextFlag(parsed.flags, "body") ?? (await readStdinBody());
  if (!body) throw new Error("draft-reply requires --body or body piped via stdin");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "create_reply_draft",
      arguments: {
        emailId,
        body,
        replyAll: isTruthyFlag(parsed.flags["reply-all"]) || isTruthyFlag(parsed.flags.all) || undefined,
        cc: getStringFlag(parsed.flags, "cc"),
        bcc: getStringFlag(parsed.flags, "bcc"),
        notes: getTextFlag(parsed.flags, "notes"),
      },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runDraftForward(parsed: ParsedCliArgs): Promise<void> {
  const emailId = parsed.positionals[0] || getStringFlag(parsed.flags, "id");
  const to = getStringFlag(parsed.flags, "to");
  if (!emailId) throw new Error("draft-forward requires an emailId");
  if (!to) throw new Error("draft-forward requires --to");
  const body = getTextFlag(parsed.flags, "body") ?? (await readStdinBody());
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "create_forward_draft",
      arguments: { emailId, to, body: body || undefined, cc: getStringFlag(parsed.flags, "cc"), bcc: getStringFlag(parsed.flags, "bcc"), notes: getTextFlag(parsed.flags, "notes") },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runDraftSync(parsed: ParsedCliArgs): Promise<void> {
  const draftId = parsed.positionals[0] || getStringFlag(parsed.flags, "id");
  if (!draftId) throw new Error("draft-sync requires a draft id");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({ name: "sync_draft_to_remote", arguments: { draftId } });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runRemoteDrafts(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "list_remote_drafts",
      arguments: { limit: getNumberFlag(parsed.flags, "limit", 50), offset: getOffsetFlag(parsed.flags, "offset", 0) },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runDraftThreadReply(parsed: ParsedCliArgs): Promise<void> {
  const threadId = parsed.positionals[0] || getStringFlag(parsed.flags, "id");
  if (!threadId) throw new Error("draft-thread-reply requires a threadId");
  const body = getTextFlag(parsed.flags, "body") ?? (await readStdinBody());
  if (!body) throw new Error("draft-thread-reply requires --body or body piped via stdin");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "create_thread_reply_draft",
      arguments: {
        threadId,
        body,
        replyAll: isTruthyFlag(parsed.flags["reply-all"]) || isTruthyFlag(parsed.flags.all) || undefined,
        cc: getStringFlag(parsed.flags, "cc"),
        bcc: getStringFlag(parsed.flags, "bcc"),
        notes: getTextFlag(parsed.flags, "notes"),
      },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runDraftSend(parsed: ParsedCliArgs): Promise<void> {
  const draftId = parsed.positionals[0] || getStringFlag(parsed.flags, "id");
  if (!draftId) throw new Error("draft-send requires a draft id");
  const wantJson = isTruthyFlag(parsed.flags.json);
  // Found live: this ignored --args entirely, so `draft-send <id> --args
  // '{"dryRun":true}'` silently sent for real instead of previewing — the
  // exact opposite of what dryRun promises. Merge it in like every
  // table-driven 1:1 command already does (see parseToolArgs's other call
  // site above).
  const args: Record<string, unknown> = { draftId };
  Object.assign(args, (await parseToolArgs(parsed)) ?? {});
  await withMcpClient(async (client) => {
    const result = await client.callTool({ name: "send_draft", arguments: args });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runDraftDelete(parsed: ParsedCliArgs): Promise<void> {
  const draftId = parsed.positionals[0] || getStringFlag(parsed.flags, "id");
  if (!draftId) throw new Error("draft-delete requires a draft id");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({ name: "delete_draft", arguments: { draftId } });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runTools(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.listTools();
    if (wantJson) {
      process.stdout.write(json(result));
      return;
    }
    process.stdout.write(
      result.tools.length === 0
        ? "No MCP tools exposed.\n"
        : result.tools
            .map((tool, index) => `${index + 1}. ${tool.name}${tool.description ? ` | ${tool.description}` : ""}`)
            .join("\n") + "\n",
    );
  });
}

async function runTool(parsed: ParsedCliArgs): Promise<void> {
  const toolName = parsed.positionals[0];
  if (!toolName) {
    throw new Error("tool requires a tool name, for example: proton-mail-bridge tool get_connection_status");
  }

  const wantJson = isTruthyFlag(parsed.flags.json);
  const args = await parseToolArgs(parsed);

  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: toolName,
      arguments: args,
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

// Dedicated 1:1 CLI subcommand for every remaining MCP tool that has no
// hand-written command above (either a brand-new tool, or an older one that
// was only ever reachable via the generic `tool <name> --args` escape
// hatch). Required fields are taken positionally, in schema order; anything
// else (optional flags, arrays, nested objects) goes through --args, same
// as `tool`. Tools with a friendlier hand-written command already above
// (e.g. move_email -> `move`) are intentionally NOT duplicated here.
interface ToolOnlyCommand {
  command: string;
  tool: string;
  positionals: string[];
  help: string;
  // When set, this field is read from --file <path> instead of a shell
  // positional (for content too large/unwieldy to pass as an argv token,
  // e.g. a full .eml source). Not included in `positionals`.
  fileField?: string;
  // Companion arg name the file's raw bytes are sent as, base64-encoded,
  // instead of fileField's UTF-8 decode — for tools (like import_email)
  // that accept a byte-exact alternative. A real .eml file frequently uses
  // a legacy 8-bit charset (ISO-8859-1, Windows-1252, ...) outside of its
  // MIME-encoded parts; decoding those bytes as UTF-8 corrupts or throws.
  fileFieldBase64?: string;
  // Boolean flags forwarded to the tool under their own name (e.g. --checkConnections).
  boolFlags?: string[];
}

export const TOOL_ONLY_COMMANDS: ToolOnlyCommand[] = [
  { command: "cancel-send", tool: "cancel_send", positionals: ["id"], help: "Cancel a send queued by PROTONMAIL_SEND_DELAY_SECONDS" },
  { command: "list-scheduled-sends", tool: "list_scheduled_sends", positionals: [], help: "List queued/scheduled sends (rediscover an id for cancel-send)" },
  { command: "unsubscribe-info", tool: "get_unsubscribe_info", positionals: ["emailId"], help: "Read List-Unsubscribe details for a message" },
  { command: "unsubscribe-sender", tool: "unsubscribe_sender", positionals: ["emailId"], help: "Execute a mailto unsubscribe (--args '{\"confirmed\":true}' if required)" },
  { command: "reply-to-email", tool: "reply_to_email", positionals: ["emailId", "body"], help: "Immediately send a reply (full tool: attachments/dryRun via --args)" },
  { command: "set-reply-reminder", tool: "set_reply_reminder", positionals: ["emailId"], help: "Remind me if nobody answers this message (--args '{\"afterDays\":5}')" },
  { command: "list-reply-reminders", tool: "list_reply_reminders", positionals: [], help: "List reply reminders: waiting, due, answered" },
  { command: "cancel-reply-reminder", tool: "cancel_reply_reminder", positionals: ["id"], help: "Delete a reply reminder" },
  { command: "respond-to-invite", tool: "respond_to_invite", positionals: ["emailId", "response"], help: "Accept / decline / tentative a calendar invitation (--args '{\"dryRun\":true}' to preview)" },
  { command: "reply-all-email", tool: "reply_all_email", positionals: ["emailId", "body"], help: "Immediately reply to all recipients" },
  { command: "forward-email", tool: "forward_email", positionals: ["emailId", "to"], help: "Immediately forward a message, preserving attachments" },
  { command: "list-drafts", tool: "list_drafts", positionals: [], help: "List local drafts (tool form; see also `drafts`)" },
  { command: "schedule-draft", tool: "schedule_draft", positionals: ["draftId", "sendAt"], help: "Queue a saved draft to send at a future time" },
  { command: "get-email-by-id", tool: "get_email_by_id", positionals: ["emailId"], help: "Fetch one email (tool form; see also `read`)" },
  { command: "get-emails-by-ids", tool: "get_emails_by_ids", positionals: ["emailIds"], help: "Fetch up to 25 emails by comma-separated ids" },
  { command: "search-emails", tool: "search_emails", positionals: [], help: "Live IMAP search (tool form; see also `search --live`)" },
  { command: "get-folders", tool: "get_folders", positionals: [], help: "List folders (tool form; see also `folders`)" },
  { command: "sync-folders", tool: "sync_folders", positionals: [], help: "Refresh the in-memory folder list from IMAP" },
  { command: "mark-email-read", tool: "mark_email_read", positionals: ["emailId"], help: "Mark read/unread (tool form; see also `mark-read`)" },
  { command: "star-email", tool: "star_email", positionals: ["emailId"], help: "Star/unstar (tool form; see also `star`)" },
  { command: "move-email", tool: "move_email", positionals: ["emailId", "targetFolder"], help: "Move an email (tool form; see also `move`)" },
  { command: "archive-email", tool: "archive_email", positionals: ["emailId"], help: "Archive an email (tool form; see also `archive`)" },
  { command: "trash-email", tool: "trash_email", positionals: ["emailId"], help: "Move to Trash (tool form; see also `trash`)" },
  { command: "restore-email", tool: "restore_email", positionals: ["emailId"], help: "Restore from Trash (tool form; see also `restore`)" },
  { command: "snooze-email", tool: "snooze_email", positionals: ["emailId", "wakeAt"], help: "Snooze a message until wakeAt (ISO timestamp)" },
  { command: "cancel-snooze", tool: "cancel_snooze", positionals: ["id"], help: "Wake a snoozed email immediately" },
  { command: "list-snoozed", tool: "list_snoozed", positionals: [], help: "List snoozed emails (rediscover an id for cancel-snooze)" },
  { command: "create-template", tool: "create_template", positionals: ["name", "subject", "body"], help: "Save a reusable email template" },
  { command: "list-templates", tool: "list_templates", positionals: [], help: "List saved email templates" },
  { command: "get-template", tool: "get_template", positionals: ["id"], help: "Get a saved template by id" },
  { command: "delete-template", tool: "delete_template", positionals: ["id"], help: "Delete a saved template" },
  { command: "render-template", tool: "render_template", positionals: ["id"], help: "Render a template ({{var}} substitution via --args '{\"variables\":{...}}')" },
  { command: "delete-email", tool: "delete_email", positionals: ["emailId"], help: "Permanently delete (tool form; see also `delete`)" },
  { command: "update-message-labels", tool: "update_message_labels", positionals: ["emailId"], help: "Add/remove Proton labels on one message" },
  { command: "update-message-flags", tool: "update_message_flags", positionals: ["emailId"], help: "Add/remove IMAP flags on one message" },
  { command: "count-messages", tool: "count_messages", positionals: [], help: "Count messages matching live IMAP search criteria" },
  { command: "bulk-update-flags", tool: "bulk_update_flags", positionals: [], help: "Add/remove IMAP flags on multiple messages" },
  { command: "bulk-update-labels", tool: "bulk_update_labels", positionals: [], help: "Add/remove Proton labels on multiple messages" },
  { command: "top-senders", tool: "top_senders", positionals: [], help: "Top senders in a folder over a date range" },
  { command: "move-thread", tool: "move_thread", positionals: ["messageId", "destination"], help: "Move every message in a thread" },
  { command: "delete-thread", tool: "delete_thread", positionals: ["messageId"], help: "Delete every message in a thread" },
  { command: "flag-thread", tool: "flag_thread", positionals: ["messageId"], help: "Add/remove IMAP flags across a thread" },
  { command: "create-label", tool: "create_label", positionals: ["name"], help: "Create a Proton label" },
  { command: "rename-label", tool: "rename_label", positionals: ["name", "newName"], help: "Rename a Proton label" },
  { command: "delete-label", tool: "delete_label", positionals: ["name"], help: "Delete a Proton label" },
  { command: "get-connection-status", tool: "get_connection_status", positionals: [], help: "(tool form; see also `connection-status`)" },
  { command: "list-accounts", tool: "list_accounts", positionals: [], boolFlags: ["checkConnections"], help: "List the configured Proton addresses with each one's connection status and index freshness (multi-account setups; pass --checkConnections to verify live)" },
  { command: "get-runtime-status", tool: "get_runtime_status", positionals: [], help: "(tool form; see also `runtime-status`)" },
  { command: "run-doctor", tool: "run_doctor", positionals: [], help: "Full production health check (tool form; see also `doctor`)" },
  { command: "run-background-sync", tool: "run_background_sync", positionals: [], help: "Trigger the configured background sync cycle now" },
  { command: "sync-emails", tool: "sync_emails", positionals: [], help: "(tool form; see also `sync`)" },
  { command: "get-index-status", tool: "get_index_status", positionals: [], help: "(tool form; see also `index-status`)" },
  { command: "search-indexed-emails", tool: "search_indexed_emails", positionals: [], help: "(tool form; see also `search`)" },
  { command: "get-labels", tool: "get_labels", positionals: [], help: "(tool form; see also `labels`)" },
  { command: "get-threads", tool: "get_threads", positionals: [], help: "(tool form; see also `threads`)" },
  { command: "get-inbox-digest", tool: "get_inbox_digest", positionals: [], help: "(tool form; see also `digest`)" },
  { command: "get-follow-up-candidates", tool: "get_follow_up_candidates", positionals: [], help: "(tool form; see also `followups`)" },
  { command: "list-attachments", tool: "list_attachments", positionals: ["emailId"], help: "(tool form; see also `attachments`)" },
  { command: "get-attachment-content", tool: "get_attachment_content", positionals: ["emailId", "attachmentId"], help: "Fetch attachment metadata/base64" },
  { command: "get-attachment-text", tool: "get_attachment_text", positionals: ["emailId", "attachmentId"], help: "Extract text from a text-like attachment" },
  { command: "save-attachments", tool: "save_attachments", positionals: ["emailId"], help: "Save all attachments from an email to disk" },
  { command: "save-attachment", tool: "save_attachment", positionals: ["emailId", "attachmentId"], help: "Save one attachment to disk" },
  { command: "export-email", tool: "export_email", positionals: ["emailId"], help: "Save raw .eml source to disk" },
  { command: "import-email", tool: "import_email", positionals: [], fileFieldBase64: "rawBase64", help: "Import a .eml message via IMAP APPEND (--file <path.eml>)" },
  { command: "clear-index", tool: "clear_index", positionals: [], help: "Delete the local SQLite mailbox index" },
  { command: "get-audit-logs", tool: "get_audit_logs", positionals: [], help: "Recent write-operation audit log entries" },
];

async function runToolOnlyCommand(entry: ToolOnlyCommand, parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  const args: Record<string, unknown> = {};
  entry.positionals.forEach((field, index) => {
    const value = parsed.positionals[index];
    if (value === undefined) {
      throw new Error(`${entry.command} requires: ${entry.positionals.join(", ")}`);
    }
    args[field] = value;
  });

  if (entry.fileField || entry.fileFieldBase64) {
    const filePath = getStringFlag(parsed.flags, "file");
    if (filePath) {
      if (entry.fileFieldBase64) {
        args[entry.fileFieldBase64] = (await readFile(filePath)).toString("base64");
      } else if (entry.fileField) {
        args[entry.fileField] = await readFile(filePath, "utf8");
      }
    }
  }

  for (const flag of entry.boolFlags ?? []) {
    if (isTruthyFlag(parsed.flags[flag])) args[flag] = true;
  }

  Object.assign(args, (await parseToolArgs(parsed)) ?? {});

  const requiredFileField = entry.fileFieldBase64 ?? entry.fileField;
  if (requiredFileField && args[requiredFileField] === undefined) {
    throw new Error(`${entry.command} requires --file <path>, or ${requiredFileField} via --args.`);
  }

  await withMcpClient(async (client) => {
    const result = await client.callTool({ name: entry.tool, arguments: args });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runClaude(parsed: ParsedCliArgs): Promise<void> {
  switch (parsed.subcommand) {
    case "setup":
      await runClaudeDesktopSetupWizard();
      return;
    case "install":
    case "update": {
      const result = await installClaudeDesktopConfig();
      process.stdout.write(json(result));
      return;
    }
    case "check":
    case "doctor": {
      const result = await getClaudeDesktopInstallStatus();
      process.stdout.write(json(result));
      return;
    }
    default:
      throw new Error("claude requires one of: setup, install, update, check, doctor");
  }
}

function printCommandHelp(command: string | undefined): void {
  if (!command) {
    printHelp();
    return;
  }
  const text = commandHelpText(command);
  if (!text) {
    throw new Error(`Unknown command: ${command}`);
  }
  process.stdout.write(text);
}

export async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));

  // --version is parsed as a flag by the arg parser, not a positional command
  if (parsed.flags["version"] || parsed.flags["v"]) {
    process.stdout.write(`proton-mail-bridge-client ${await getPkgVersion()}\n`);
    return;
  }

  // --help / -h anywhere prints help and returns: nothing below runs, nothing connects.
  if (parsed.flags["help"]) {
    printCommandHelp(parsed.command === "help" ? parsed.positionals[0] : parsed.command);
    return;
  }

  assertKnownFlags(parsed);

  switch (parsed.command) {
    case "help":
      printCommandHelp(parsed.positionals[0]);
      return;
    case "completion":
      process.stdout.write(completionScript(parsed.positionals[0] ?? ""));
      return;
    case "-v":
    case "version":
      process.stdout.write(`proton-mail-bridge-client ${await getPkgVersion()}\n`);
      return;
    case "setup-claude-desktop":
      await runClaudeDesktopSetupWizard();
      return;
    case "status":
      await runStatus(parsed);
      return;
    case "doctor":
      await runDoctor(parsed);
      return;
    case "connection-status":
      await runConnectionStatus(parsed);
      return;
    case "runtime-status":
      await runRuntimeStatus(parsed);
      return;
    case "sync":
      await runSync(parsed);
      return;
    case "index-status":
      await runIndexStatus(parsed);
      return;
    case "folders":
      await runFolders(parsed);
      return;
    case "create-folder":
      await runCreateFolder(parsed);
      return;
    case "rename-folder":
      await runRenameFolder(parsed);
      return;
    case "delete-folder":
      await runDeleteFolder(parsed);
      return;
    case "empty-folder":
      await runEmptyFolder(parsed);
      return;
    case "labels":
      await runLabels(parsed);
      return;
    case "threads":
      await runThreads(parsed);
      return;
    case "digest":
      await runDigest(parsed);
      return;
    case "followups":
      await runFollowups(parsed);
      return;
    case "drafts":
      await runDrafts(parsed);
      return;
    case "attachments":
      await runAttachments(parsed);
      return;
    case "search":
      await runSearch(parsed);
      return;
    case "read":
      await runRead(parsed);
      return;
    case "move":
      await runMove(parsed);
      return;
    case "archive":
      await runArchive(parsed);
      return;
    case "trash":
      await runTrash(parsed);
      return;
    case "restore":
      await runRestore(parsed);
      return;
    case "mark-read":
      await runMarkRead(parsed);
      return;
    case "star":
      await runStar(parsed);
      return;
    case "delete":
      await runDelete(parsed);
      return;
    case "send":
      await runSend(parsed);
      return;
    case "reply":
      await runReply(parsed);
      return;
    case "forward":
      await runForward(parsed);
      return;
    case "emails":
      await runEmails(parsed);
      return;
    case "thread":
      await runThread(parsed);
      return;
    case "thread-brief":
      await runThreadBrief(parsed);
      return;
    case "actionable":
      await runActionable(parsed);
      return;
    case "document-threads":
      await runDocumentThreads(parsed);
      return;
    case "meeting-context":
      await runMeetingContext(parsed);
      return;
    case "thread-action":
      await runThreadAction(parsed);
      return;
    case "batch":
      await runBatch(parsed);
      return;
    case "bulk-delete":
      await runBulkDelete(parsed);
      return;
    case "bulk-move":
      await runBulkMove(parsed);
      return;
    case "stats":
      await runStats(parsed);
      return;
    case "analytics":
      await runAnalytics(parsed);
      return;
    case "folder-stats":
      await runFolderStats(parsed);
      return;
    case "contacts":
      await runContacts(parsed);
      return;
    case "volume-trends":
      await runVolumeTrends(parsed);
      return;
    case "watch":
      await runWatch(parsed);
      return;
    case "clear-cache":
      await runClearCache(parsed);
      return;
    case "get-logs":
      await runGetLogs(parsed);
      return;
    case "notify":
      await runNotify(parsed);
      return;
    case "test-email":
      await runTestEmail(parsed);
      return;
    case "draft-create":
      await runDraftCreate(parsed);
      return;
    case "draft-read":
      await runDraftRead(parsed);
      return;
    case "draft-update":
      await runDraftUpdate(parsed);
      return;
    case "draft-reply":
      await runDraftReply(parsed);
      return;
    case "draft-forward":
      await runDraftForward(parsed);
      return;
    case "draft-sync":
      await runDraftSync(parsed);
      return;
    case "draft-send":
      await runDraftSend(parsed);
      return;
    case "draft-delete":
      await runDraftDelete(parsed);
      return;
    case "remote-drafts":
      await runRemoteDrafts(parsed);
      return;
    case "draft-thread-reply":
      await runDraftThreadReply(parsed);
      return;
    case "tools":
      await runTools(parsed);
      return;
    case "tool":
      await runTool(parsed);
      return;
    case "claude":
      await runClaude(parsed);
      return;
    default: {
      const toolOnly = TOOL_ONLY_COMMANDS.find((entry) => entry.command === parsed.command);
      if (toolOnly) {
        await runToolOnlyCommand(toolOnly, parsed);
        return;
      }
      throw new Error(`Unknown command: ${parsed.command}`);
    }
  }
}

const isDirectExecution = isMainModule(import.meta.url);

if (isDirectExecution) {
  // `proton-mail-bridge ... | head` closes the pipe early: that is the reader's choice, not an
  // error, so leave quietly. Anything else on stdout is still fatal.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      process.exit(0);
    }
    throw error;
  });
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(error instanceof CliUsageError ? 2 : 1);
  });
}
