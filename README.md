```
  ____  ____   ___ _____ ___  _   _   __  __    _    ___ _
 |  _ \|  _ \ / _ \_   _/ _ \| \ | | |  \/  |  / \  |_ _| |
 | |_) | |_) | | | || || | | |  \| | | |\/| | / _ \  | || |
 |  __/|  _ <| |_| || || |_| | |\  | | |  | |/ ___ \ | || |___
 |_|   |_| \_\\___/ |_| \___/|_| \_| |_|  |_/_/   \_\___|_____|
  Bridge Client  ·  CLI + Claude Desktop MCP for Proton Mail
```

<div align="center">

[![npm version](https://img.shields.io/npm/v/proton-mail-bridge-client?color=%236d4aff&label=npm)](https://www.npmjs.com/package/proton-mail-bridge-client)
[![CI](https://github.com/googlarz/proton-mail-bridge-client/actions/workflows/ci.yml/badge.svg)](https://github.com/googlarz/proton-mail-bridge-client/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 18+](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-blueviolet)](https://modelcontextprotocol.io)
[![GitHub stars](https://img.shields.io/github/stars/googlarz/proton-mail-bridge-client?style=social)](https://github.com/googlarz/proton-mail-bridge-client)
[![Last commit](https://img.shields.io/github/last-commit/googlarz/proton-mail-bridge-client?color=brightgreen&label=last%20commit)](https://github.com/googlarz/proton-mail-bridge-client/commits/main)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)](https://github.com/googlarz/proton-mail-bridge-client)
[![proton-mail-bridge-client MCP server](https://glama.ai/mcp/servers/googlarz/proton-mail-bridge-client/badges/score.svg)](https://glama.ai/mcp/servers/googlarz/proton-mail-bridge-client)

</div>

---

Give Claude Desktop (or Cline, or any MCP client) full access to your Proton Mail inbox: read, search, send, draft, triage threads, manage folders, save attachments, and more — 95 MCP tools in total. Most of the same capabilities are also available as a full CLI for scripting, cron, and piped automation — no Claude required.

## What you get

- **Claude reads and manages your Proton Mail** — triage, reply, draft, archive, search, move, batch-act on threads, pull attachments
- **Full CLI** — a dedicated command for every one of the 95 tools (plus a generic `tool <name>` passthrough), scriptable and pipeable, works in cron and shell scripts
- **Fast local search** — full-text search across your inbox without hitting IMAP on every query
- **Safety controls** — read-only mode, send gate, destructive-action confirmation, per-action allowlist
- **Privacy-native** — no third-party email service involved; your mail stays on your machine

---

## Privacy model

Your emails travel: **Proton Mail → Proton Bridge (local) → this server (local) → your AI client**.

Nothing goes through a third-party email relay. Proton Bridge decrypts your mail locally; this server reads it over a local IMAP connection on `127.0.0.1`. The AI model (Claude Desktop, Cline, etc.) sees the email content you ask it to act on — that's the whole point — but no email leaves your machine except through your own Proton account when you send.

If you use Claude Desktop with the default Anthropic API, conversation content (including email snippets) is sent to Anthropic per their [privacy policy](https://www.anthropic.com/privacy). If you self-host an LLM or use a local-only Claude setup, nothing leaves your machine at all.

---

## Prerequisites

**1. Proton Bridge** — must be installed, signed in, and running.
Download: [proton.me/mail/bridge](https://proton.me/mail/bridge)

> **Bridge password vs Proton password:** Proton Bridge generates a separate local password that is *not* your Proton account password. Find it inside the Bridge app under **Account → Copy password** (or similar — exact label varies by Bridge version). You'll need this for setup.

**2. Node.js 18 or later** — `node --version` to check.

**3. Your Bridge credentials** — from the Bridge app:
- IMAP host/port (default: `127.0.0.1:1143`)
- SMTP host/port (default: `127.0.0.1:1025`)
- Username (your Proton email address)
- Bridge password (see note above)

---

## Install

**npm (recommended):**

```bash
npm install -g proton-mail-bridge-client
```

**Homebrew:**

```bash
brew tap googlarz/tap
brew install proton-mail-bridge-client
```

<details>
<summary>Source install (development)</summary>

```bash
git clone https://github.com/googlarz/proton-mail-bridge-client.git
cd proton-mail-bridge-client
npm install
npm run build
```

The `proton-mail-bridge-client` binary is available inside the repo after build.

</details>

---

## Connect to Claude Desktop

Run the guided setup wizard:

```bash
proton-mail-bridge-client setup-claude-desktop
```

The wizard:
- checks your local Bridge ports
- asks for your Bridge username and Bridge password
- writes the Claude Desktop MCP config entry

**After setup:** restart Claude Desktop, make sure Proton Bridge is open, then check **`+` → Connectors → proton-mail-bridge**.

### Updating

```bash
npm update -g proton-mail-bridge-client
proton-mail-bridge-client setup-claude-desktop
```

### Manual config

The wizard handles config automatically. If you need to set it up by hand, three credential methods are supported:

<details>
<summary>Option 1 — Environment variables (simplest)</summary>

```json
{
  "mcpServers": {
    "proton-mail-bridge": {
      "command": "proton-mail-bridge-mcp",
      "env": {
        "PROTONMAIL_USERNAME": "you@proton.me",
        "PROTONMAIL_PASSWORD": "your-bridge-password",
        "PROTONMAIL_IMAP_HOST": "127.0.0.1",
        "PROTONMAIL_IMAP_PORT": "1143",
        "PROTONMAIL_IMAP_SECURE": "false",
        "PROTONMAIL_SMTP_HOST": "127.0.0.1",
        "PROTONMAIL_SMTP_PORT": "1025"
      }
    }
  }
}
```

</details>

<details>
<summary>Option 2 — File-based secrets (credentials in files, not config)</summary>

```json
{
  "mcpServers": {
    "proton-mail-bridge": {
      "command": "proton-mail-bridge-mcp",
      "env": {
        "PROTONMAIL_USERNAME_FILE": "/path/to/username.txt",
        "PROTONMAIL_PASSWORD_FILE": "/path/to/password.txt",
        "PROTONMAIL_IMAP_HOST": "127.0.0.1",
        "PROTONMAIL_IMAP_PORT": "1143",
        "PROTONMAIL_IMAP_SECURE": "false",
        "PROTONMAIL_SMTP_HOST": "127.0.0.1",
        "PROTONMAIL_SMTP_PORT": "1025"
      }
    }
  }
}
```

</details>

<details>
<summary>Option 3 — Command-based secrets (pass, gopass, or any secret manager)</summary>

```json
{
  "mcpServers": {
    "proton-mail-bridge": {
      "command": "proton-mail-bridge-mcp",
      "env": {
        "PROTONMAIL_USERNAME_COMMAND": "pass proton/username",
        "PROTONMAIL_PASSWORD_COMMAND": "pass proton/password",
        "PROTONMAIL_IMAP_HOST": "127.0.0.1",
        "PROTONMAIL_IMAP_PORT": "1143",
        "PROTONMAIL_IMAP_SECURE": "false",
        "PROTONMAIL_SMTP_HOST": "127.0.0.1",
        "PROTONMAIL_SMTP_PORT": "1025"
      }
    }
  }
}
```

</details>

---

## Connect to Claude Code

Install globally, then register the server with one command:

```bash
npm install -g proton-mail-bridge-client

claude mcp add proton-mail-bridge \
  -e PROTONMAIL_USERNAME=you@proton.me \
  -e PROTONMAIL_PASSWORD=your-bridge-password \
  -- proton-mail-bridge-mcp
```

`your-bridge-password` is the Bridge app's own password (**Bridge → account → Mailbox details**), not your Proton account password — see the note under [Prerequisites](#prerequisites).

By default this registers the server for the current project only. Add `-s user` to make it available in every project:

```bash
claude mcp add proton-mail-bridge -s user \
  -e PROTONMAIL_USERNAME=you@proton.me \
  -e PROTONMAIL_PASSWORD=your-bridge-password \
  -- proton-mail-bridge-mcp
```

Verify it's connected:

```bash
claude mcp list
```

For file-based or command-based credentials instead of plaintext env vars, add `-e PROTONMAIL_USERNAME_FILE=/path/to/file` (or `_COMMAND`) the same way — see the credential methods under [Manual config](#connect-to-claude-desktop) above.

---

## Connect to Cline (VS Code)

Install globally (`npm install -g proton-mail-bridge-client`), then open Cline's MCP settings:

- VS Code → Cline extension panel → MCP servers icon → **Edit MCP Settings**
- Or edit directly: `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` (macOS)

Add the server:

```json
{
  "mcpServers": {
    "proton-mail-bridge": {
      "command": "proton-mail-bridge-mcp",
      "env": {
        "PROTONMAIL_USERNAME": "you@proton.me",
        "PROTONMAIL_PASSWORD": "your-bridge-password",
        "PROTONMAIL_IMAP_HOST": "127.0.0.1",
        "PROTONMAIL_IMAP_PORT": "1143",
        "PROTONMAIL_IMAP_SECURE": "false",
        "PROTONMAIL_SMTP_HOST": "127.0.0.1",
        "PROTONMAIL_SMTP_PORT": "1025"
      }
    }
  }
}
```

For file-based or command-based credentials, use the same `PROTONMAIL_USERNAME_FILE` / `PROTONMAIL_PASSWORD_COMMAND` pattern from the Claude Desktop manual config above.

Reload the Cline extension after saving. Proton Mail tools will appear in Cline's tool list.

---

## Try it: example Claude prompts

**Morning triage**
> "Give me a digest of my inbox. Flag anything that needs a reply today and anything that looks like a bill or invoice."

**Inbox zero**
> "Go through my unread emails from the past 3 days. Archive newsletters, trash anything promotional, and tell me what's left that needs action."

**Folder filing**
> "Find all emails from stripe.com and move them to Folders/Receipts. Create the folder if it doesn't exist."

**Meeting prep**
> "I have a call with alice@example.com in an hour. Pull up our last 5 email threads and summarise the open items."

**Draft review**
> "Show me my drafts, pick the oldest one, and suggest a better subject line and closing paragraph."

> **Tip:** When creating folders, use `Folders/Name` (not just `Name`) — that's the Proton Bridge namespace for real folders vs. labels.

More recipes — expanded triage prompts, cron scripts for scheduled digests, and a Claude Code `/mail-triage` slash command — are in [examples/](examples/).

---

## Recommended System Prompt

Add this to Claude Desktop's system prompt (Settings → Claude Desktop → System Prompt) for safer defaults:

```
You have access to my Proton Mail inbox via the proton-mail-bridge tool.

Rules:
- Always use dryRun: true before any batch operation (batch_email_action, apply_thread_action).
- Before calling send_email, reply_to_email, or forward_email, summarise what you are about to send and ask me to confirm.
- For anything important or hard to walk back (a wide CC list, a sensitive topic, an attachment), offer a short undo window via send_email's undoWindowSeconds instead of sending immediately — remind me it only protects against mistakes noticed in the next few seconds, not a change of mind days later.
- Before calling delete_email, confirm with me — deletion is permanent.
- Prefer create_draft over send_email when composing from scratch.
- Use get_inbox_digest or get_actionable_threads as your starting point for triage sessions.
```

---

## CLI

Every capability is also a scriptable terminal command — no Claude required:

```bash
proton-mail-bridge-client digest                                    # morning triage summary
proton-mail-bridge-client search --from stripe.com --json | jq .    # scriptable search
echo "Deploy done" | proton-mail-bridge-client send --to you@x.com --subject "Deploy"
proton-mail-bridge-client notify &                                  # background new-mail alerts
```

All commands support `--json` for machine-readable output, and any MCP tool is directly callable via `proton-mail-bridge-client tool <name> --args '{...}'`.

**Full command reference: [docs/cli.md](docs/cli.md)** (a named command for every one of the 95 tools, across read, triage, compose, mailbox actions, folders, drafts, templates, analytics, and diagnostics).

---

## Safety controls

All flags work in both the MCP server and CLI:

```bash
PROTONMAIL_TOOL_TIER=core            # expose 19 core tools instead of all 95 — saves context window
PROTONMAIL_READ_ONLY=true            # disable all write operations
PROTONMAIL_ALLOW_SEND=false          # disable SMTP sends only (other writes still work)
PROTONMAIL_CONFIRM_DESTRUCTIVE=true  # require confirmed:true on send, reply, forward, delete
PROTONMAIL_ALLOWED_ACTIONS='mark_read,archive,trash'  # per-action allowlist
```

`batch_email_action` and `apply_thread_action` both support `dryRun: true` regardless of the above flags.

---

## Environment reference

```bash
# Credentials (required)
PROTONMAIL_USERNAME='you@proton.me'
PROTONMAIL_PASSWORD='your-bridge-password'   # Bridge password, not Proton account password
PROTONMAIL_IMAP_HOST='127.0.0.1'
PROTONMAIL_IMAP_PORT='1143'
PROTONMAIL_IMAP_SECURE='false'
PROTONMAIL_SMTP_HOST='127.0.0.1'
PROTONMAIL_SMTP_PORT='1025'
PROTONMAIL_SMTP_SECURE='true'         # Bridge's local SMTP port requires implicit TLS from the first byte; set false only for a non-Bridge SMTP relay

# Secrets via file or command (avoids raw credentials in config)
PROTONMAIL_USERNAME_FILE='/path/to/user.txt'
PROTONMAIL_PASSWORD_FILE='/path/to/pass.txt'
PROTONMAIL_USERNAME_COMMAND='pass proton/username'
PROTONMAIL_PASSWORD_COMMAND='pass proton/password'

# Storage
PROTONMAIL_DATA_DIR="$HOME/.proton-mail-bridge-client"

# Tools
PROTONMAIL_TOOL_TIER='full'          # 'core' exposes 19 essential tools (saves context window); 'full' exposes all 95

# Safety
PROTONMAIL_READ_ONLY='false'
PROTONMAIL_ALLOW_SEND='true'
PROTONMAIL_ALLOW_REMOTE_DRAFT_SYNC='true'
PROTONMAIL_ALLOWED_ACTIONS='mark_read,mark_unread,star,unstar,archive,trash,restore,move,delete'
PROTONMAIL_CONFIRM_DESTRUCTIVE='false'
PROTONMAIL_SEND_DELAY_SECONDS='0'    # >0: send_email queues instead of sending immediately, cancelable via cancel_send. Only fires while this server stays running.
PROTONMAIL_SIGNATURE=''              # Plain text, appended to send_email/reply_to_email/reply_all_email/forward_email bodies (text + HTML), after your own text and before any quoted/forwarded content. Opt out per-message with appendSignature: false. Never applied to send_draft/schedule_draft — draft content is already finalized.

# Sync
PROTONMAIL_AUTO_SYNC='true'
PROTONMAIL_STARTUP_SYNC='true'
PROTONMAIL_SYNC_INTERVAL_MINUTES='5'
PROTONMAIL_IDLE_WATCH='true'
PROTONMAIL_IDLE_MAX_SECONDS='30'
```

---

## Compared with Claude's native Gmail connector

| Capability | Gmail connector | Proton Mail Bridge Client |
|---|---|---|
| Setup | First-party OAuth | Requires Proton Bridge + this client |
| Search and read | Native Claude UX | IMAP + local index |
| Send email | No | Yes |
| Draft workflows | Better first-party UX | Full control incl. remote draft sync |
| Attachment content | Limited | Fetch and save to disk |
| Mailbox actions | Limited | Full (star, move, archive, trash, restore, delete, batch) |
| Folder management | No | Yes (create, rename, delete) |
| CLI access | No | Full parity with MCP |
| Privacy | Google-hosted | Proton E2E encryption, local Bridge |

---

## Tool surface

### Send
`send_email` · `send_test_email` · `reply_to_email` · `reply_all_email` · `forward_email`

### Drafts
`create_draft` · `create_reply_draft` · `create_forward_draft` · `create_thread_reply_draft` · `list_drafts` · `list_remote_drafts` · `get_draft` · `update_draft` · `sync_draft_to_remote` · `send_draft` · `delete_draft`

### Read
`get_emails` · `get_email_by_id` · `count_messages` · `search_emails` · `search_indexed_emails` · `list_attachments` · `get_attachment_content` · `save_attachment` · `save_attachments`

### Triage
`get_folders` · `sync_folders` · `get_labels` · `get_threads` · `get_thread_by_id` · `get_thread_brief` · `get_actionable_threads` · `get_inbox_digest` · `get_follow_up_candidates` · `find_document_threads` · `prepare_meeting_context` · `delete_thread` · `flag_thread` · `move_thread`

### Actions
`mark_email_read` · `star_email` · `move_email` · `archive_email` · `trash_email` · `restore_email` · `delete_email` · `batch_email_action` · `apply_thread_action` · `empty_folder` · `bulk_delete` · `bulk_move` · `bulk_update_flags` · `bulk_update_labels` · `update_message_flags` · `update_message_labels`

### Folder management
`create_folder` · `rename_folder` · `delete_folder` · `create_label` · `rename_label` · `delete_label`

### Analytics
`get_email_stats` · `get_email_analytics` · `get_contacts` · `get_volume_trends` · `folder_stats` · `top_senders`

### Diagnostics
`get_connection_status` · `get_runtime_status` · `run_doctor` · `get_audit_logs` · `run_background_sync` · `wait_for_mailbox_changes` · `sync_emails` · `get_index_status` · `clear_cache` · `clear_index` · `get_logs`

### Unsubscribe & trust
`get_unsubscribe_info` · `unsubscribe_sender` — `get_email_by_id` also returns a `security` block (DKIM/SPF/DMARC, encryption, spam score)

### Undo-send, scheduling & snooze
`cancel_send` · `list_scheduled_sends` · `schedule_draft` · `snooze_email` · `cancel_snooze` · `list_snoozed` — send_email queues instead of sending immediately when `PROTONMAIL_SEND_DELAY_SECONDS` is set; all three only fire while this server process stays running, see [Operational notes](#operational-notes)

### Templates
`create_template` · `list_templates` · `get_template` · `delete_template` · `render_template` — `{{variable}}` substitution, render then pass the result to `send_email`

### Import/export & attachments
`export_email` · `import_email` · `get_attachment_text` · `get_emails_by_ids`

---

## Using it as a library

Beyond the CLI and MCP server, the underlying service classes are importable directly:

```ts
import { SimpleIMAPService, SMTPService } from "proton-mail-bridge-client/services";

const imapService = new SimpleIMAPService(config, logger);
const smtpService = new SMTPService(config);
```

`proton-mail-bridge-client/services` has no side effects on import — unlike the package's
main entry point, which also self-starts the MCP server when run directly. Also exported:
all shared types (`ProtonMailConfig`, `EmailSummary`, `EmailDetail`, …), `planFolderSync`,
`isLikelyAuthenticationError`, and `sanitizeHeader`.

---

## Operational notes

- `get_emails` and `search_emails` return a composite `emailId` — use it for all subsequent reads and actions.
- `search_indexed_emails` supports `from:`, `to:`, `subject:`, `label:`, `domain:` shortcuts.
- The local index lives at `PROTONMAIL_DATA_DIR/mail-index.sqlite`. Background sync and IMAP IDLE keep it warm.
- Audit logs live at `PROTONMAIL_DATA_DIR/audit.log`.
- Draft sync is best-effort — the local draft is always preserved even if remote sync fails.
- System folders (INBOX, Sent, Trash, Spam, Archive, All Mail) are guarded against accidental deletion.

---

## Troubleshooting

**"Wrong password" or connection refused**
Make sure you're using the **Bridge password**, not your Proton account password. Find it in the Bridge app under Account → Copy password. Bridge must be running before the MCP server or CLI can connect.

**macOS native module crash after update**
`better-sqlite3` is a native binary built for your machine. After a major Node.js upgrade or environment change, rebuild it:
```bash
proton-mail-bridge-client setup-claude-desktop
```
This reinstalls the runtime and rebuilds native modules in place.

**Claude can't see the connector**
After changing the MCP config, restart Claude Desktop fully (not just reload). Then check **`+` → Connectors → proton-mail-bridge**. If it's not there, run `proton-mail-bridge-client doctor` to validate the connection.

**Folder not found when moving email**
Use `Folders/Name` for real folders (e.g., `Folders/Receipts`), not just `Name`. Labels and folders share the same namespace in Proton Bridge but are structurally different.

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## Contributing

Bug reports and pull requests welcome: [github.com/googlarz/proton-mail-bridge-client/issues](https://github.com/googlarz/proton-mail-bridge-client/issues)

## License

MIT
