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
[![Node.js 24+](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-blueviolet)](https://modelcontextprotocol.io)
[![GitHub stars](https://img.shields.io/github/stars/googlarz/proton-mail-bridge-client?style=social)](https://github.com/googlarz/proton-mail-bridge-client)
[![Last commit](https://img.shields.io/github/last-commit/googlarz/proton-mail-bridge-client?color=brightgreen&label=last%20commit)](https://github.com/googlarz/proton-mail-bridge-client/commits/main)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)](https://github.com/googlarz/proton-mail-bridge-client)
[![proton-mail-bridge-client MCP server](https://glama.ai/mcp/servers/googlarz/proton-mail-bridge-client/badges/score.svg)](https://glama.ai/mcp/servers/googlarz/proton-mail-bridge-client)

</div>

---

Give Claude Desktop (or Cline, or any MCP client) full access to your Proton Mail inbox: read, search, send, draft, triage threads, manage folders, save attachments, and more — 127 MCP tools in total. Most of the same capabilities are also available as a full CLI for scripting, cron, and piped automation — no Claude required.

> **Using Proton Drive too?** See [**proton-drive-mcp**](https://github.com/googlarz/proton-drive-mcp), the companion MCP server and CLI for Proton Drive (upload, download, share and manage your encrypted files from Claude). Run both side by side to handle mail and files in one conversation, for example save an attachment from here, then upload it to Drive. More in [Related projects](#related-projects).

> **Battle-tested at scale (v2.0.0):** full mailbox backfill validated end-to-end against a real account with 57,000+ indexed messages across 62 folders/labels — including a 22,800-message Archive folder backfilled from scratch, UID-window by UID-window, with zero data loss across restarts, transient IMAP disconnects, and connection timeouts.

## Quick start (2 minutes)

> **No terminal?** Follow the [step-by-step guide](docs/install-for-non-developers.md) instead.

1. **Install and sign in to [Proton Mail Bridge](https://proton.me/mail/bridge)**, and leave it running. In the Bridge app, open your account and copy the **Bridge password** (it is not your Proton password).
2. **Connect Claude Desktop**, either way (quit Claude Desktop completely first, so it does not overwrite the config on exit):
   - **Bundle** (needs Node.js 24 or later on the machine): download the `proton-mail-bridge-client-<your-os>.mcpb` for macOS (`darwin-arm64` Apple silicon, `darwin-x64` Intel), Linux (`linux-x64`, `linux-arm64`) or Windows (`win32-x64`) from the [latest release](https://github.com/googlarz/proton-mail-bridge-client/releases/latest) and open it. Claude Desktop asks for your Proton address and the Bridge password, plus optional settings (Bridge IMAP/SMTP host and port, read-only, allow sending, signature, extra accounts, data and download folders, tool tier); the defaults match a standard Bridge install.
   - **npm:** `npm install -g proton-mail-bridge-client`, then `proton-mail-bridge-client setup-claude-desktop` (it checks your Bridge ports and writes the config). Fully quit and reopen Claude Desktop afterwards.
3. **Check it works:** run `proton-mail-bridge-client doctor`, or ask Claude "run the Proton Mail doctor".
4. **Try these prompts:**
   - "Give me a digest of my inbox and flag anything that needs a reply today."
   - "Find the last email from `alice@example.com` and draft a reply for me to review." (nothing is sent until you say so)
   - "Which of my emails have attachments from this month?"
   - "Show me my drafts and tighten the oldest one."
5. **Not sure about handing over control?** Start with `PROTONMAIL_MODE=drafts`: Claude can read, search and prepare drafts, but nothing is sent or deleted until you change the mode. The server also tells the client how to behave (ids, accounts, never obeying instructions found inside a message).
6. **Optional:** `PROTONMAIL_READ_ONLY=true` to browse without being able to change anything, `PROTONMAIL_TOOL_TIER=core` for a smaller tool set (25 instead of 127), and more accounts under [Multi-account support](#multi-account-support-v210). More recipes below in [Try it](#try-it-example-claude-prompts).

---

## What you get

- **Claude reads and manages your Proton Mail** — triage, reply, draft, archive, search, move, batch-act on threads, pull attachments (PDF text and pictures included), answer calendar invitations
- **Safety you choose** — `PROTONMAIL_MODE` presets (`read-only`, `drafts`, `assisted`, `full`), a send gate, confirmation for destructive actions, a per-action allowlist, and a [threat model](docs/threat-model.md) that says what is and is not covered
- **Several addresses at once** — each Proton login (or each address Bridge exposes) is its own isolated account with its own index, drafts and settings
- **Fast local search** — full-text search across your inbox from a local index that keeps its read state in step with the server
- **Rules that suggest themselves** — a scan proposes filters and cleanup from your own mail, applies them to existing mail after a preview, and can forward by condition; see [Mailbox rules](#mailbox-rules-suggestions-filters-cleanup-forwarding)
- **Automatic reply, per address, with rules** — off by default, with a preview of what it would do, draft-for-approval mode and working-hours; see [Autoresponder](#autoresponder-automatic-reply-per-address) (Proton's own auto-reply may be all you need)
- **Full CLI** — a dedicated command for every one of the 127 tools (plus a generic `tool <name>` passthrough), scriptable and pipeable; `doctor` checks every account and `report` prints a diagnostic summary for a bug report
- **Runs where you do** — Claude Desktop bundle, npm, Homebrew, or a [Docker image](#running-in-docker-headless-machines) for a headless machine
- **Privacy-native** — no third-party email service involved; your mail stays on your machine

**How this relates to Proton Bridge.** This is a layer on top of [Proton Mail Bridge](https://proton.me/mail/bridge), not a replacement for it. Bridge is Proton's official, local IMAP/SMTP gateway and the only supported way to reach a Proton mailbox from other software; this project talks to it. Bridge's own `--cli` mode manages Bridge itself (signing in, account details and the Bridge password, ports and other settings), it is not a mail client. Proton does not publish a terminal mail client, so reading, searching, drafting and sending from Claude or a script is what this adds on top, together with the safety controls above. Bridge has to be running and signed in.

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

**2. Node.js 24 or later** — `node --version` to check.

**3. Your Bridge credentials** — from the Bridge app:
- IMAP host/port (default: `127.0.0.1:1143`)
- SMTP host/port (default: `127.0.0.1:1025`); the IMAP and SMTP password is the same Bridge password
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

The runtime is installed into a staging directory first, checked (Node starts, `better-sqlite3` opens a database, `dist` imports, version matches) and only then swapped in; the previous runtime stays next to it as `<runtime dir>.previous`, and a failed install leaves the working one untouched. The config is merged, not replaced: existing `env` keys you added by hand are kept, and the config is rewritten atomically (the newest 5 `.bak-*` copies are kept). Passwords are never printed. Run `npm run check:claude-desktop` to verify an install; it exits non-zero when the command, the runtime or the database module is broken.

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

## Running in Docker (headless machines)

For a server with no desktop, next to a headless Bridge. The image installs the published npm package and is published for each release to `ghcr.io/googlarz/proton-mail-bridge-client` (`:<version>` and `:latest`, linux/amd64 and linux/arm64). To build it yourself from this repo:

```bash
docker build -f docker/Dockerfile --build-arg VERSION=2.17.1 -t proton-mail-bridge-client .
docker run -i --rm --network host \
  -e PROTONMAIL_USERNAME=you@proton.me -e PROTONMAIL_PASSWORD_FILE=/run/secrets/bridge \
  -v /path/to/bridge-password:/run/secrets/bridge:ro -v bridge-client-data:/data \
  proton-mail-bridge-client
```

`docker run -i` speaks MCP over stdio. The container must reach Bridge's IMAP and SMTP ports (`--network host`, or `--network container:<bridge>` to share Bridge's network). The CLI is in the same image: add `--entrypoint proton-mail-bridge-client` and a command such as `doctor`. If Bridge is reached by a host name (for example `host.docker.internal` or another container), its self-signed certificate fails verification: export it from Bridge and point `PROTONMAIL_TLS_CA_FILE` at it, or list the name in `PROTONMAIL_TLS_INSECURE_HOSTS`. The server has no network transport of its own; reaching it from a remote client needs your own wrapper. The image was checked to build, report its version, run as a non-root user and answer an MCP `initialize`, and (by a tester, against a real Bridge) to pass `doctor`, list folders, sync and exit cleanly, with `--network container:<bridge>` or with Bridge reached by host name using `PROTONMAIL_TLS_CA_FILE` or `PROTONMAIL_TLS_INSECURE_HOSTS`.

## Autoresponder (automatic reply per address)

**Proton Mail has its own auto-reply** (Settings → Filters / Forward and auto-reply; Proton lists it on its paid plans). It runs inside Proton, works while your computer is off, and applies to the whole account unless you write a filter. If that is enough, use it and leave this one off: enabling both would send each sender two replies. This one adds what a filter cannot do from a chat, and it only runs while this server runs.

An automatic reply for one address, plus a note that address appends to what it sends. **Off by default**, and it can send mail without asking each time, so it is held to stricter rules than a normal send:

- **Who gets a reply.** Only a person (not a list, not automatic mail, not a `no-reply`/`mailer-daemon` sender) who wrote to this address (To or Cc), after the rule was switched on and inside its dates, and whom you have not already answered since. One reply per sender per `replyEveryDays` days (default 7), at most `dailyLimit` a day (default 50). A reply is recorded before it is sent, so a failure never becomes a second one.
- **When.** After a background sync has indexed new mail, so only while this server runs with `PROTONMAIL_AUTO_SYNC` on; with several clients open, the instance holding the sync lock does it. `outsideHours` (with a `timezone`) limits it to when you are not at work.
- **What it does.** `mode: "send"` sends; `mode: "draft"` leaves a draft in your drafts for you to review and send. If the server may not send (`PROTONMAIL_MODE=drafts`, `ALLOW_SEND` off, or outbound mail confined to yourself), a reply becomes a draft by itself; if it may not write drafts either (read-only), it is refused.
- **Rules**, first match wins: by sender (`boss@example.com`, `*@client.example`), words in the subject, and whether you have written to the sender before (`known: "yes"/"no"`). Each gives `reply`, `draft` or `skip`, optionally with its own text. Mail that matches none gets the default reply.
- **Text.** Placeholders `{senderFirstName}`, `{senderName}`, `{senderAddress}`, `{subject}`, `{startsAt}`, `{endsAt}`, `{returnDate}`, `{backupContact}`. `returnDate` and `backupContact` are plain text you set once (`returnDate` may be a date such as `2027-01-04`, written out in the reply's language); nobody is written to at the backup contact.
- **Language.** `bodies` and `subjects` map a language code (`en`, `pl`, `de`) to a text. If the message answered is detected to be in one of those languages, that text is used and dates are written in it; anything else, or a language with no text, gets `body` / `subject`. Detection is a word-list guess on the subject and the start of the message, so a short or mixed-language message may be taken for the wrong language or none.
- **Draft in your style.** In draft mode, if a style profile exists (`get_style_profile`), the draft opens and closes with your usual greeting and closing for that language instead of a fixed text. Sent replies use the text as written.
- **VIP rules.** A rule's `from` accepts `tag:vip` (or any tag you set with `set_contact`), so a rule can treat people you tagged differently. The tag is looked up by the sender address in the message header.
- **Safety headers.** `Auto-Submitted: auto-replied`, `Precedence: bulk`, `X-Auto-Response-Suppress: All`; the reply threads under the message it answers.
- **Control.** Switching it on needs `confirmed: true` when `PROTONMAIL_CONFIRM_DESTRUCTIVE` is on and the server can send. Switching it off is always allowed, in every mode.

```text
preview_autoresponder  account=work@example.com  days=3        # what it WOULD do with recent mail; changes nothing
set_autoresponder  account=work@example.com  enabled=true  confirmed=true
                   body="Hi {senderFirstName}, I am away until {endsAt} and will answer then."
                   endsAt=2027-01-04  timezone=Europe/Warsaw  outgoingNote="I am away until 4 January."
                   rules=[{"name":"boss","from":["boss@example.com"],"action":"reply","body":"Urgent? Call my mobile."},
                          {"name":"clients","from":["*@client.example"],"action":"draft"},
                          {"known":"no","subjectContains":["unsubscribe"],"action":"skip"}]
get_autoresponder  account=work@example.com                      # state, counts, who wrote, why mail was skipped, the log
```

For a reply in the sender's language add `bodies={"pl":"Dzień dobry {senderFirstName}, wracam {returnDate}.","de":"Guten Tag {senderFirstName}, ich bin ab {returnDate} zurück."}` and `returnDate=2027-01-04`. `preview_autoresponder` shows, for each message, the language it detected, where the text came from (`textFrom`: rule, language or default), whether a draft would be `styled`, and the text itself.

`outgoingNote` is appended, after the signature, to every mail sent from that address while the rule is active (a send with `appendSignature: false` opts out). On the command line: `set-autoresponder`, `autoresponder` and `preview-autoresponder`. The rule, the log and the memory of who was answered live in `autoresponder.json` in the account's data directory; every account (every address Bridge exposes) has its own.

## Mail firewall (prompt-injection guard)

Mail is untrusted text that a model reads. `get_email_by_id` and `get_emails_by_ids` add a `risk` note (`caution` or `high`, with the reasons) when a message looks written to steer an AI or to deceive you: instructions addressed to an assistant (English, Polish, German), text hidden by markup or zero-width characters, a link that reads one address and goes to another, a Reply-To on another domain, a sender name that shows a different address, a failed SPF/DKIM/DMARC check. Normal mail carries no note. The instruction patterns are also checked wherever else text reaches the model: attachment text, thread reads, lists with previews and reading a message as an MCP resource.

After a **high** message has been read, the tools that reach outside (`send_email`, replies, `forward_email`, `send_draft`, `schedule_draft`, `delete_email`, `delete_thread`, `bulk_delete`, `empty_folder`, `unsubscribe_sender`, `respond_to_invite`, and switching on `set_rule` or `set_autoresponder`) ask for `confirmed: true` and quote the reason, even when `PROTONMAIL_CONFIRM_DESTRUCTIVE` is off. Previews (`dryRun`) and switching things off pass. Rules and the autoresponder never act by themselves on a high-risk message. This narrows what a persuaded model can do; it cannot read intent (see the [threat model](docs/threat-model.md)).

**What is scanned.** The scan walks a whole result and reads every string in it: deeply nested ones, any field (not only body and subject), nodes without an `id`, and text split across adjacent fields. Hidden characters (control, zero-width, direction-changing, compatibility forms) are normalised before the patterns are matched, at every size, so a word split by one is still found. A result part that is not JSON is read as plain text, and `structuredContent` and resource parts are scanned too. An object key longer than 24 characters or containing whitespace is scanned as text. Short machine fields (`id`, `date`, `mimeType`, `hash`, `size` and the like) are skipped only while the value looks like what the key claims. A big result that is clean is scanned without tainting the session. `get_events` results are scanned too (sender, subject and `detail` of each event), and a high rating there taints the session like a message does.

**The scan has a budget.** At most 24,000,000 characters and about 1 second of work per result. Only when that runs out is whatever was not looked at reported as **high risk** with the reason `oversized-unscanned`, which taints the session exactly like a message that reads like an instruction, so that padding cannot buy a bypass. The cost: a very slow machine can run out of time on a large result that is entirely harmless and taint the session early; the tools that reach outside then ask for `confirmed: true` as described above (or for your approval, with `PROTONMAIL_APPROVAL`).

**One large mail text.** When a single mail text is longer than 512 KB (512,000 characters), it is not matched whole: its two ends and a few windows between them are assessed, and the assessment reports `oversized-unscanned ... (partially assessed)` as **high risk**, so such a message taints the session like one that reads like an instruction. In short: a single mail text above 512 KB counts as high risk. Ordinary mail below that size is assessed whole.

**Known gaps.** Short object keys (up to 24 characters, no whitespace) are not scanned; a space-free, filename-like value under a key such as `id` is skipped as a machine field and not scanned; a result that is not JSON and is longer than 2,000,000 characters has only its first and last 100,000 characters scanned (and is reported as high risk). Text you own can taint a session as well: logs, templates or rules that contain instruction-like phrases read as such. The patterns remain pattern-based: the scan narrows common tricks and does not read intent.

## Human approval (MCP elicitation)

`confirmed: true` is an argument, so a model that was persuaded (or a mail that says "pass confirmed") can set it itself; the gate above is a speed bump, not a lock. With `PROTONMAIL_APPROVAL` set, the **server asks you**, through the client, and only your answer counts:

| `PROTONMAIL_APPROVAL` | What happens |
|---|---|
| `off` (default) | Nothing changes: `confirmed: true` works as before. |
| `elicit` | For a call that needs approval, the server sends an MCP elicitation request and runs the call only if you accept. If the client does not support elicitation, nothing changes (the model's `confirmed: true` still works). |
| `require` | As `elicit`, but a call that needs approval from a client without elicitation support is refused: it fails closed instead of falling back to `confirmed: true`. |

In `elicit` (with a client that supports it) and in `require`, a `confirmed` the model passes is **ignored**: it is removed from the arguments before anything looks at it, so the model's word never counts, only yours. Which calls ask: the ones the confirmation gate covers (sends, replies, forwards, `send_draft`, `schedule_draft`, deletes, `empty_folder`, `unsubscribe_sender`, `respond_to_invite`, `apply_rules` with `dryRun: false`, bulk and thread deletes and trashes, switching on `set_autoresponder`, `set_rule` with forwarding, adding the `\Deleted` flag), plus `approve_plan`, `send_test_email`, `delete_draft`, `delete_template` and `delete_label`. A preview (`dryRun`) does not ask.

**What you are asked.** A question with the tool, the account and the details that decide the effect: the recipients that will really be used (for a stored draft, those in the draft), the subject, how many messages, or what the plan would change. For the calls that change standing behaviour or touch many messages the question carries the effect too: `set_autoresponder` (on or off, mode, whether it answers people outside your contacts, subject and text, window, limits, rules), `set_rule` (the rule as it would be stored, from the proposal or stored rule it names, and for forwarding the cap of 50 messages a day), `apply_rules` (the matches of a real run, counted per rule), `bulk_delete` with a filter, `empty_folder` and `delete_folder` (a message count from the local index, which may be out of date, shown as "count unknown" when the index has nothing for the folder), `unsubscribe_sender` (by mail or by a link the server does not open), `respond_to_invite` (organiser and event) and `send_test_email`. The summary is **built by the server** from what it knows (its own stores and the call's arguments), never from text the model wrote about the action. Pieces that come from mail (subjects, addresses, ids) are shown as quoted single-line values, stripped of control, bidirectional and zero-width characters and cut short, after a fixed label; the whole text is cut at 1,500 characters (2,500 for `set_rule`, `set_autoresponder` and `apply_rules`) and only the first three messages are listed. A lookup that takes more than 5 seconds or fails leaves that line out; the question is still asked.

For a reply or forward the recipients shown are the ones the reply tool will really use, **Reply-To included**, marked when it differs from the sender. `set_contact` and `import_contacts` show the person, tags, merge target and, for an import, the file with its card count.

**What you approved is what runs.** For `send_draft`, `schedule_draft`, `delete_draft`, `approve_plan`, `import_contacts`, `set_rule` and `set_autoresponder`, the server keeps a digest of the draft, plan, vCard file, rule or automatic reply it showed you, on the call itself under a symbol that JSON from a client cannot carry, so the model can neither set nor forge it. If the content is different when the call runs (a draft edited in between, a file replaced, a rule or automatic reply changed), the call is refused and you are not asked to approve something else by accident. `schedule_draft` sends the snapshot it took when it was scheduled. The confirmation gate and the handlers read `dryRun`, `enabled`, `active` and `action` the same way; a malformed value gives the same error in both, instead of one skipping the gate.

If you decline, dismiss it, do not answer within `PROTONMAIL_APPROVAL_TIMEOUT_SECONDS` (default 120, 1 to 3600), or the question cannot be delivered, the call is **not run** and the model is told not to retry unless you ask.

Limits: **`elicit` on a client that cannot ask falls back to the model's own `confirmed: true`**, so it is not a lock there; only `require` fails closed. This also depends on the client. A client that shows the question without its details, or that answers it automatically, takes the protection away; which clients support elicitation, and how they present it, has not been surveyed here. The question is only as good as the facts the server has, and it cannot judge whether a send is wise. Approval does not replace read-only mode, `PROTONMAIL_ALLOWED_ACTIONS`, the outbound allow-list or the other checks, which run as before.

## Mailbox events (`get_events`, `protonmail://events`)

What happened while nobody was asking, kept as a small log per account in the data directory (`events.jsonl`). `get_events` (CLI: `events`) returns the newest events, or only what is new since a cursor: pass the returned `nextCursor` back as `sinceCursor`. The cursor survives restarts; `missed: true` means older events were dropped to keep the log small. `types` takes event types or a whole group (`mail`, `snooze`, `send`, `autoresponder`, `plan`); `limit` is 1 to 200 (default 50); `account` narrows it.

| Type | Meaning |
|---|---|
| `mail.new`, `mail.new_overflow` | Recent unread INBOX mail from someone else that a sync brought in (at most 25 per sync, from the last 7 days); the overflow event says how many more were not listed |
| `snooze.woke`, `snooze.failed` | A snoozed message returned, or the attempt failed |
| `reply_reminder.due` | A reply reminder came due with no answer |
| `send.sent`, `send.failed` | A queued or scheduled send went out, or failed |
| `rule.acted` | A rule acted on a message |
| `autoresponder.replied`, `.drafted`, `.failed` | The automatic reply was sent, drafted, or failed |
| `plan.applied`, `plan.undone` | A triage plan was applied or taken back |
| `delegation.used` | A delegation grant was spent on a send |

An MCP client that supports resource subscriptions can **subscribe to `protonmail://events`** (the only resource that can be subscribed to) and is told when it changes, instead of polling; nothing is watched until a client subscribes. Notifications are batched (about half a second), and events that another server process wrote to the same data directory are noticed within about 5 seconds.

Retention and content: at most 1000 events or 512 KB per file, two generations kept, then the oldest are dropped; when that happens the newest 200 events of each type that matters (sends, delegation use, plans, rules, reply reminders, snoozes) are kept. **No message bodies**: an event holds a type, a time, an id, and for some the sender address, subject and a short `detail` (cleaned, and cut to 254, 160 and 300 characters). Events with a sender, subject or `detail` carry `untrusted: true`: that text came from a mail, so it is data, never an instruction. The result of `get_events` is scanned by the mail firewall, and a high rating taints the session.

Flood limits: `mail.new` is recorded at most 50 per sender and 200 in all per hour, so a sender or a burst of spam cannot fill the log; the excess is counted in a `mail.new_overflow` event (at most 20 of those per hour).

Limits: events are recorded only while a server (or a command that runs the same code) is running, and new-mail events only while background sync runs; mail that arrives while nothing runs is announced by the first sync afterwards, and only if it is still unread, from the last 7 days and among the newest 25 of that sync. A message already announced is not announced again. The log is a convenience for noticing, not an audit trail (that is the audit log).

## Delegation grants (`PROTONMAIL_DELEGATION=on`)

For narrow, repetitive sends you can hand the assistant a **grant** instead of answering every question: "these tools, to these recipients, this many times, until this date". It is **off by default**; with `PROTONMAIL_DELEGATION=off` grants are ignored.

Grants are made **only by a human, on the command line**: `grant-create --tools send_email,reply_to_email --recipients pat@client.example,@my-team.example --expires 7d --uses 5 --note "weekly report"`. It requires an interactive terminal (stdin and stdout) and a typed confirmation: the whole grant is shown and you type a phrase such as `grant 2 recipients` back; `grant-revoke` asks the same. There is no flag or variable that answers for you, so a script or a shell command run by the assistant is stopped. There is no tool that creates, widens or revokes a grant; the model can only read them with `list_grants` (CLI `list-grants`). The CLI also has `grant-list` (`--all` includes spent, expired and revoked ones) and `grant-revoke <id>`. Grants live in `grants.json` in the account's data directory.

What a grant can cover: only `send_email`, `reply_to_email`, `reply_all_email`, `forward_email`, `send_draft` and `schedule_draft`; recipients as exact addresses or `@domain` (exactly that domain: no wildcards, no subdomains; at most 50); at most 50 uses and at most 30 days; a note of up to 200 characters. **Every** To, Cc and Bcc address that the send will really use must match, so a reply is matched on the recipients worked out from the message and a draft on the ones in the draft. An address that cannot be read exactly (non-ASCII look-alikes, odd formatting) is never covered. What a grant cannot cover: deletes, `empty_folder`, rules, the autoresponder, plans, flags or anything else.

It stands in for the answer only where one would be asked (your approval, or `confirmed: true` under `PROTONMAIL_CONFIRM_DESTRUCTIVE` or a mode that confirms). It **never bypasses** the taint gate (after a message that reads like an instruction to an AI, grants do not apply and you are asked), read-only mode, `PROTONMAIL_ALLOW_SEND`, `PROTONMAIL_ALLOWED_ACTIONS` or the outbound allow-lists; those still run. A use is spent **before** the mail is sent ("claim before send"), in one locked step shared by every server process on the data directory, so two processes cannot both take the last use. The use is written to the audit log and as a `delegation.used` event. It is at most once: **a send that then fails does not give the use back** (and a crash can never create an extra one). A call that a grant answers for carries **no draft digest** (nobody was asked), so a draft edited in the short window between the grant check and the send is not caught by a digest; that gap is known and open. A grant that no longer covers the call at that point (used up, expired, revoked, a draft edited in between) stops the send. An unreadable `grants.json` honours no grant. A stored grant whose `createdAt` is missing, or whose `expiresAt` is more than 30 days after `createdAt`, is not honoured either (the cap is checked on read, not only when the grant is made). A forward grant covers only messages of the grant's own account, and so does a reply: it must be sent from the account of the original message. A mail scheduled with `schedule_draft` goes out as the snapshot taken when it was scheduled.

**The boundary, plainly.** Grants protect against a model that has **only MCP tools**. They do **not** protect against a model that can write files or run a shell: `grants.json` is a plain file in the data directory and is not signed, so such a model can write a grant itself. The terminal and typed phrase stop a shell command, but not a model that drives a pseudo-terminal and types the phrase. If your client gives the model file or shell access, do not rely on grants. A key held in the system keychain, so that a file alone is not enough, is a possible future step; it is not built.

**A forward grant is the whole mailbox.** A grant on `forward_email` lets the model forward **any** message of the grant's own account to the granted recipients, not one thread. Grant forwarding only to addresses you would trust with the entire mailbox.

Limits: a grant is a standing permission for whoever can reach the assistant while it lasts, so keep recipients narrow and expiries short. It does not judge content: within its recipients, a persuaded model can send what it likes until the uses run out.

## Brief (what changed since you last looked)

`get_brief` (CLI: `brief`) reports from the local index how much mail came since the last brief, split into people and automatic mail, what waits for your reply, replies you are waiting for that are overdue, and suspicious mail (see the mail firewall above). `markSeen` moves the "since" mark, so a daily run reports only the day. To get it without opening anything, run it from your system's scheduler:

```bash
proton-mail-bridge-client brief --sync --mark-seen --notify
```

`--notify` shows the few lines as a system notification (macOS and Linux with `notify-send`). `schedule --job brief` prints the launchd, systemd, cron or Windows task definition that runs it every day (it installs nothing).

## Tidy in one approval (`plan_inbox`)

Ask Claude to tidy the inbox and it prepares a **plan**: a numbered list of changes that can all be taken back (archive, move, mark read, label), from its own proposals and from a scan for automatic mail nobody reads (unread for 3 days, or read and over 14 days old). Nothing changes until you approve. `approve_plan` applies everything, only some numbers, or everything except some; each change goes through the same runtime policy as the single tools. `undo_plan` puts the applied changes back (mail returns to its folder, read marks and labels are reverted). Senders of scanned items you left out are not proposed again. A plan never contains delete or trash.

## Commitments ("I'll send it by Friday")

A local ledger of what you promised and what was promised to you. `find_commitments` reads recent sent mail (and, if you ask, mail from people) and returns sentences that look like promises, in English, Polish and German, with the date each names ("by Friday", "do piątku", "bis Freitag", `05.11.`). They are only candidates: Claude confirms with you, then `set_commitment` records the real ones. `list_commitments` shows each open entry as overdue, due today, open or probably done (the person who owed it wrote again in the thread). Overdue and due-today entries appear in the brief. Closing an entry is `set_commitment` with `id` and `status`. Nothing in the mailbox changes.

## Style profile (drafts that sound like you)

`get_style_profile` works out how you write from your own sent mail, on your machine: language, how you open and close ("Dzień dobry {name},", "Cheers"), tone, typical length. It returns a few plain hints for drafting, overall and for a given recipient or company ("to pat@client.example you write in Polish, formally"), and the server tells Claude to call it before drafting. The profile is cached for a week in `style-profile.json` and holds patterns and counts only: no sentences, no names.

## Search by meaning (several wordings)

`search_indexed_emails` takes `queries`: several wordings of one question, up to 8. Claude supplies the variants (synonyms, other languages: `["deposit", "kaucja", "Kaution", "rental agreement"]`), the server searches each in the local index and fuses the results, so a message found by several wordings ranks first and every hit says which wordings found it (`matchedBy`). By default there is no model and no download: the meaning comes from the model you already use. What it cannot find is mail that uses none of the words tried.

**Optional: search by meaning with vectors.** Set `PROTONMAIL_EMBEDDINGS_URL` to an embedding endpoint **you run**, and `search_indexed_emails` gains `mode`: `lexical` (words), `semantic` (vectors) or `hybrid` (both, fused). Unset, which is the default, none of this runs and nothing is built. No model is shipped or downloaded.

- **Endpoint.** Ollama (`http://127.0.0.1:11434/api/embed`) or anything OpenAI-compatible (a URL ending `/v1/embeddings`). `PROTONMAIL_EMBEDDINGS_MODEL` names the model (default `nomic-embed-text`).
- **Privacy.** The text of each indexed message that gets a vector (subject, sender and the first 1000 characters of its preview), and each semantic query, is sent to that endpoint. Only a host on this machine (loopback) is accepted. A remote host is refused unless you set `PROTONMAIL_EMBEDDINGS_ALLOW_REMOTE=true`, which logs a warning; your mail text then goes to that host. Redirects are not followed.
- **What is built.** Vectors for the newest 10000 indexed messages, built in the background and stored in `mail-embeddings.bin` next to the index. It is derived from your mail, so treat it like the index. `get_index_status` has an `embeddings` block: configured, model, vectors built, pending.
- **Fallback.** The default `mode` is `hybrid` once the endpoint is set up and vectors exist, otherwise `lexical`. If semantic ranking cannot run (endpoint down, no vectors yet) you get the lexical result, with `mode` and `semanticNotes` saying why. Semantic hits carry a cosine `similarity`.
- **Quality is your model's.** Results are only as good as the embedding model you pick. A small local model can miss what a person would call obvious or rank a loose match high; treat `similarity` as a hint. This project has not compared models.

## Contacts (people, not addresses)

`find_contact` (CLI: `find-contact`) finds a person by name, part of a name or address and returns them as one identity: their addresses (merged ones included), organisation, tags, your notes, first and last contact, message counts both ways, the last few subjects, and whether you have ever written to them. Counts, dates and names come from the local index each time; only what you say is stored. `set_contact` sets a display name, notes and tags (such as `vip`), merges another address into the same person, or splits one out again. `import_contacts` reads a local `.vcf` file (vCard 2.1, 3.0, 4.0) and takes name, e-mail addresses, organisation and note; it fills only what is not set yet, **never reads `CATEGORIES` and never sets a tag**, so a file cannot mark anyone as a VIP. An import also **never attaches an address to a person who already exists**: a card that names a known person (or whose address belongs to another person) adds nothing for those addresses and is reported under `conflicts` (the first 20, with `conflictCount` for the total). Merging two addresses into one person is something only `set_contact` with `mergeWith` does, so a file cannot give its own address someone's tags. A tag can be used in an autoresponder rule as `tag:vip` in `from`. Because tags change what the autoresponder does, `set_contact` and `import_contacts` are gated like the tools that reach outside: after a suspicious message was read in the session they ask for `confirmed: true` (or for your approval, with `PROTONMAIL_APPROVAL`).

Limits: at most 5 MB and 5000 cards per import (the result says if cards were left); nothing is fetched over the network and nothing changes in the mailbox. This is a store of your own (in the account's data directory, one per account), not Proton's address book, which Bridge does not expose: export your contacts from Proton as vCard if you want them here. A name taken from mail headers is whatever the sender wrote; it is cleaned of control and invisible characters and shown, never followed.

## Own categories (separate from Proton's)

Proton Mail sorts mail into its own categories. According to public sources they are server-side and not exposed over IMAP, so this server cannot read what Proton decided, change it or add to it. These categories are a different thing: yours, kept on this machine, per account. `define_category` gives one a name, a description in your words (shown, never used for sorting), and the signals that put mail in it: example senders (`a@b.example`, or `@b.example` for a domain), subject words, list/bulk mail or not, mail from people you have written to, and optionally a label to add. The name, description, label and keywords are checked for text that reads like an instruction to an AI and are refused if it does; that check folds compatibility forms, drops invisible characters and reads Cyrillic and Greek look-alike letters as Latin, but the folding is **partial**: a heuristic, not a complete list of disguises. `starter: true` adds a starter set (Receipts, Newsletters, Social, Updates, People) when you ask for it. A name that matches one of Proton's is reported as a clash.

`categorize_inbox` sorts the newest INBOX messages (default 30, up to 100) and says why for each one. It is deterministic: no model decides, and who the sender is counts only when the message passed authentication. By default it is a **preview**. With `dryRun: false` it makes a plan that adds each category's label, which goes through `approve_plan` and can be taken back with `undo_plan` like any other plan. Mail that already has the label, categories without a label and labels that do not exist yet are left out and listed. `correct_category` tells it where a message really belongs: the sender's weight towards that category goes up (stored locally), the sender's next mail follows, and the answer lists which other recent messages would change. Corrections are not copied between accounts.

`Reply-To` is no longer used for sorting; the sender, subject words, list headers, whether you wrote to the sender and your corrections are. `define_category` and `correct_category` change a local store, so `PROTONMAIL_READ_ONLY` blocks them, and they are written to the audit log.

What it does not do: see or touch Proton's categories, run by itself (it sorts what is in the INBOX when you ask), or place a message that fits no category.

## Mailbox rules (suggestions, filters, cleanup, forwarding)

Proton's own filters act on **new** mail, the free plan has one custom filter, and auto-delete of Trash and Spam is a paid feature with a fixed 30 days (see Proton's pages on [filters](https://proton.me/support/email-inbox-filters) and [auto-delete](https://proton.me/support/auto-delete-unwanted-messages)). These rules work alongside them: on mail that is already there, with a preview, and with a scan that suggests rules instead of waiting for you to write them. They run on this server, so they only act while it runs.

**Scan, then decide.** `suggest_rules` looks through the mail in the local index and proposes, with the evidence for each: newsletters and other automatic mail you never open (archive and mark as read; or move to Trash when old), people whose mail you always file in the same folder, and an old Trash or Spam that was never emptied. Each says how risky it is (`low`: only moves and marks; `recoverable`: moves to Trash; `permanent`: deletes). **Nothing changes** until you accept one with `set_rule proposalId=...`; `delete_rule` on a proposal dismisses it for good.

**A rule** is `when` (sender or `*@domain`, words in the subject, folder, `olderThanDays`, `hasAttachment`, `automated`, `unread`) and `actions` (`markRead`, `label`, `archive`, `moveTo`, `trash`, `delete`, `forwardTo`). A rule needs a real condition, so it cannot touch a whole folder.

- **By itself, on new mail**, after each background sync: mark read, label, archive, move, forward. Only mail that arrived after the rule was switched on, once per message.
- **Only when you ask:** a rule that trashes or deletes never runs by itself. `apply_rules` runs the rules on mail already in the index and is a **preview unless `dryRun: false`**; deleting for good also needs `confirmed: true`. Every action goes through the same permissions as the other tools (`PROTONMAIL_MODE`, allowed actions), and a disallowed one is refused before anything is touched.
- **Forwarding** (`actions.forwardTo`, up to 3 addresses, optional `forwardNote`) sends mail out on its own, so it is held to the rules of a send: sending must be allowed, the recipients must be allowed (not with `PROTONMAIL_RESTRICT_OUTBOUND_TO_SELF`), switching it on needs `confirmed: true` when `PROTONMAIL_CONFIRM_DESTRUCTIVE` is on, and the rule needs a condition on the sender, the subject or an attachment. It forwards mail that arrives after the rule is switched on, once per message, at most 50 a day, with the original attachments, and by default only mail from people (not lists or automatic mail). The copy carries `Auto-Submitted: auto-generated` and `X-Forwarded-By`.

```text
suggest_rules  days=90                                        # proposals, with evidence; nothing is changed
set_rule  proposalId=p-1a2b3c4d5e                              # accept one
set_rule  name="Clients to Projects"  when={"from":["*@client.example"]}  actions={"moveTo":"Projects","markRead":false}
set_rule  name="Boss to phone"  when={"from":["boss@example.com"]}  actions={"forwardTo":["me@elsewhere.example"]}  confirmed=true
apply_rules                                                    # preview of what the rules would do to existing mail
apply_rules  dryRun=false  limit=100
get_rules                                                      # rules, waiting proposals, what the rules did lately
```

**Export to Proton's own filters (`export_sieve`).** Proton's filters run on Proton's servers, also while this server and your computer are off, and accept [Sieve](https://proton.me/support/sieve-advanced-custom-filters). `export_sieve` (CLI: `export-sieve`) compiles the enabled rules, in order, to one script you paste into a new Sieve filter in Proton's settings. It changes nothing and sends nothing.

- **Checked against** Proton's Sieve page and the public source of Proton's web client (read 2026-10-29): the extensions, the `address` / `header` / `exists` tests and the `fileinto`, `addflag` and `stop` actions the script uses, and the names `archive`, folders and labels are given by.
- **Assumed, not verified:** that a custom folder is named by its path without `Folders/`, a label by its name without `Labels/`, and that `exists "X-Attached"` means an attachment (taken from Proton's web client). **The script has not been run on a real Proton account.** Paste it into the filter editor, which checks the syntax, and try it on a test message before you rely on it. The folders and labels it names must already exist.
- **Not exported, each listed in `unsupported` with its reason:** rules on a folder other than INBOX or on age (`olderThanDays`), since Proton filters run once, as mail arrives; anything that trashes or deletes (here those run only on request, after a preview); `forwardTo` (Proton's Sieve documents no redirect, and a forward on Proton's side would skip this server's send checks); switched-off rules; rules whose only condition is `unread`. A condition that cannot be expressed keeps the whole rule out, because dropping it would widen what the rule matches; an action that cannot be expressed is left out of an otherwise exported rule.
- **Known limit:** locally the first matching rule that archives or moves a message decides where it goes, and the script keeps a later move from overriding an earlier one by guarding it with the earlier rule's condition. That guard can only name an earlier rule whose conditions could be exported. If an earlier rule's conditions cannot be expressed in Sieve, that rule is left out and a **later rule's move is not guarded by it**: on Proton a message may be moved by the later rule where locally the earlier rule would have decided. Read the `unsupported` list for rules left out before you paste the script.
- **Behaviour differs:** the script acts on every new message, which on Proton may include mail it puts in Spam (the local rules never touch it), and your existing Proton filters run as well. Locally the first matching rule that moves a message decides where it goes; the script guards later moves the same way. A rule name, folder or label containing a control character or `${` is kept out, since Proton's Sieve can read `${` as a variable.

The scan and `apply_rules` work from the local index (by default INBOX and Sent; run `sync_emails` for other folders), so check that it is fresh. Rules, proposals and the log live in `rules.json` in the account's data directory; each account has its own.

## Audit log (tamper-evident)

Tool calls that change something are recorded in `audit.log` in the data directory, with credentials and message bodies redacted. Each entry carries a sequence number and the SHA-256 hash of the entry before it, so `verify_audit_log` (CLI: `verify-audit-log`) can tell that an entry was **edited, deleted from the middle or reordered**. It returns `ok`, how many entries it checked, the first broken `seq` with the reason, and the head hash. Entries written before the chain existed have no hash and are counted as `legacyEntries`, not checked.

What it does not catch:

- **Someone who can write both files.** Next to `audit.log` the server keeps `audit.head`, the sequence number and hash of the newest entry (written after each append). Someone who can write only `audit.log` cannot hide anymore: deleting or truncating the newest entries, emptying or removing the file, or stripping the chain fields makes verification fail (reported as `deleted` or `edited`), and a new entry carries on from the head `audit.head` recorded. But whoever can write **both** files can rewrite the chain, recompute every hash and write a matching `audit.head`, and that is not detected. Only a **head hash kept somewhere else** catches it: note the one `verify_audit_log` returns and compare it later; this server cannot store one out of its own reach. So this is evidence against a careless or partial edit, not a defence against someone with the same access as the server. `audit.head` is in the same directory as the log, so anyone (or any model with file access) who can write one can write the other; for real evidence, store the head hash elsewhere, outside the machine or at least outside the data directory.
- **A repaired head.** If `audit.head` is damaged, or is unreadable and then replaced, the next entry the server records writes a new `audit.head` from the log's own newest entry. Verification reports the problem until then, but the signal can disappear after the next append, so check `verify_audit_log` (and keep the head hash) rather than relying on seeing an old failure later. An `audit.head` that cannot be read at all makes verification return `ok: false` with the reason `head-unreadable`; the server keeps appending to the log regardless.
- **Planted files.** Every file the server reads from its own data directory, `audit.log` and `audit.head` included, is read through a regular-file guard: a FIFO, device or dangling symlink in its place is refused (`ENOTREG`) instead of hanging the server, and an oversized file is refused (`EFBIG`). An `audit.head` that cannot be read gives `head-unreadable`.
- **Rotation.** The log rotates at 5 MB into `audit.log.1` and `audit.log.2`, and the oldest is dropped. Verification reads all three files and reports `rotatedBeforeSeq` when older entries have been rotated away; that is not treated as tampering, but entries before it can no longer be checked, and a head hash saved before the rotation drops out of the log cannot be found in it.

- **A write cut short.** A last line left half-written by a crash is skipped and counted (`detail` says how many), the next entry starts on a fresh line, and the entries around it are checked as usual. An unreadable line in the middle of the chain is still reported as an edit.

`verify_audit_log` only reads.

## Multi-account support (v2.1.0+)

Use more than one Proton mailbox from the same server: either several addresses of one account (Bridge's **Split Addresses** feature) or separate Proton accounts signed in to the same Bridge. Each one gets its own isolated service stack, local index, and drafts storage.

### Setup

In Proton Bridge, make each address or account its own login: with **Split Addresses** on, every address has a login; separate accounts each have their own. Bridge generates a separate password for each login, and the same password works for IMAP and SMTP. The first account is `PROTONMAIL_USERNAME` / `PROTONMAIL_PASSWORD`; **`PROTONMAIL_ACCOUNTS_JSON` lists only the additional ones**, as a JSON array on one line:

```json
{
  "mcpServers": {
    "proton-mail-bridge": {
      "command": "proton-mail-bridge-mcp",
      "env": {
        "PROTONMAIL_USERNAME": "primary@proton.me",
        "PROTONMAIL_PASSWORD": "primary-bridge-password",
        "PROTONMAIL_ACCOUNTS_JSON": "[{\"address\": \"alias@proton.me\", \"password\": \"alias-bridge-password\"}, {\"address\": \"business@custom.com\", \"password\": \"business-bridge-password\"}]"
      }
    }
  }
}
```

Instead of `password` an entry can use `passwordFile` (path to a file with the Bridge password) or `passwordCommand` (a command that prints it), so the password need not sit in the client config; use only one of the three. `autoSyncFolder` sets that account's folders for background sync (default `PROTONMAIL_AUTO_SYNC_FOLDER`). Folders in a list that an account does not have are skipped and reported as `skippedFolders`.

Listing the primary address again is refused at startup ("duplicate address"). Host, ports and the TLS mode default to the primary account's; an entry can override them with `imapHost`, `imapPort`, `imapSecure`, `smtpHost`, `smtpPort` and `smtpSecure`.

**Note:** The password is the **Bridge password for each login**, not your Proton account password.

### How it works

- **Primary account:** the `PROTONMAIL_USERNAME`/`PROTONMAIL_PASSWORD` pair. Email IDs from the primary account have no prefix.
- **Additional accounts:** each has an auto-generated slug (e.g., `alias`, `business`). Email IDs carry an account prefix: `alias::message-id`, `business::message-id`.
- **Sending:** `send_email`, `reply_to_email`, etc. route through the account matching the `from` address. If no account matches, the primary connection is used with a header override (for non-configured aliases).
- **Search and read:** all read tools (search, threads, analytics, digest) automatically fan out across all configured accounts and merge results, preserving the account prefix in returned IDs.
- **One account only:** the triage, statistics, draft and folder tools (`get_threads`, `get_inbox_digest`, `get_follow_up_candidates`, `get_labels`, `list_drafts`, `get_folders`, `top_senders`, ...) take an optional `account` (address or slug) to look at a single account instead of all of them; an unknown value is an error.

### Tools across accounts

**Fan out across all accounts:**
- Search & read: `search_indexed_emails`, `get_emails`, `get_threads`, `get_thread_by_id`, `count_messages`, `get_labels`, `folder_stats`, `top_senders`, `get_contacts`, `get_volume_trends`, `get_email_analytics`, `get_email_stats`, `get_folders`
- Triage: `get_inbox_digest`, `get_follow_up_candidates`, `get_actionable_threads`, `find_document_threads`, `prepare_meeting_context`
- Diagnostics: `get_connection_status`, `get_runtime_status`, `run_doctor` (include an `accounts` array showing per-account status)
- Drafts: `list_drafts` — lists every configured account's drafts, merged and re-sorted by last update; supports optional `limit`/`offset`

**Account-specific (prefix to target):**
- Actions: `mark_email_read`, `star_email`, `move_email`, `delete_email`, etc. — prefix the `emailId` with account slug if targeting a non-primary account
- Drafts: `create_draft`, `get_draft`, `send_draft`, etc. — drafts live per account; prefix `draftId` to access non-primary drafts
- Send: `send_email`, `reply_to_email`, `forward_email` — match the `from` address to route through the correct account's SMTP
- Sync and index maintenance: `sync_emails`, `sync_folders`, `run_background_sync`, `wait_for_mailbox_changes` — pass `account` (address or slug) to act on a non-primary account; without it they act on the primary account, and an unknown value is an error

**Primary-only (for now):**
- `list_remote_drafts` — shows the primary account's remote Proton Drafts folder only
- Thread actions (`move_thread`, `delete_thread`, `flag_thread`) — operate on the account the thread ID's prefix names

### Verify setup

Use `list_accounts` to check configured accounts and verify connection status:

```bash
proton-mail-bridge-client list_accounts --json
```

Output:
```json
[
  { "slug": "primary", "address": "primary@proton.me", "isPrimary": true, "index": "fresh", "imap": "ok", "smtp": "ok" },
  { "slug": "alias", "address": "alias@proton.me", "isPrimary": false, "index": "fresh", "imap": "ok", "smtp": "ok" },
  { "slug": "business", "address": "business@custom.com", "isPrimary": false, "index": "stale", "imap": "timeout", "smtp": "ok" }
]
```

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

**Calendar invitations**
> "Do I have any unanswered meeting invitations this week? Accept the ones that don't clash with each other and show me the rest."

**Follow-up**
> "I just sent the proposal to Ann. If she hasn't answered in five days, remind me."

> **Tip:** When creating folders, use `Folders/Name` (not just `Name`) — that's the Proton Bridge namespace for real folders vs. labels.

More recipes — expanded triage prompts, cron scripts for scheduled digests, and a Claude Code `/mail-triage` slash command — are in [examples/](examples/).

**Ready-made workflows.** The server offers seven prompts that clients can show as menu items: *Morning brief*, *Who is waiting on me*, *Waiting on others*, *Prepare for a meeting*, *Answer calendar invitations*, *Clean up newsletters* and *Draft replies*. Each only instructs the assistant and says to ask before sending or changing anything. To get a digest written to a file every morning without opening Claude, see `proton-mail-bridge-client schedule` in [docs/cli.md](docs/cli.md#scheduled-digest).

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
- When revising a draft, change parts of it with update_draft's bodyEdits (find/replace) instead of resending the whole body, and pass syncToRemote:false while iterating; call sync_draft_to_remote once when I say the draft is ready. Each synced edit costs seconds (see "Performance and token cost").
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

`<command> --help` prints that command's usage without running it. Flags accept `--flag value` or `--flag=value` (a value starting with `--` needs the `=` form, or must come after a bare `--`); unknown flags are an error. Exit codes: `0` success, `1` failure (including a failed `doctor` or `connection-status` check, or a failed item in a `batch`/`bulk-*` run), `2` usage error.

**Full command reference: [docs/cli.md](docs/cli.md)** (a named command for every one of the 127 tools, across read, triage, compose, mailbox actions, folders, drafts, templates, analytics, and diagnostics).

---

## Safety controls

### One switch: `PROTONMAIL_MODE`

If you would rather not combine the flags below yourself, pick how much the assistant may do:

| `PROTONMAIL_MODE` | Reads | Drafts | Flags (read, star) | Archive, trash, move | Send | Permanent delete |
|---|---|---|---|---|---|---|
| `read-only` | yes | no | no | no | no | no |
| `drafts` | yes | yes | yes | no | no | no |
| `assisted` | yes | yes | yes | yes | yes, with `confirmed:true` | no |
| `full` (the default) | yes | yes | yes | yes | yes | yes |

A mode is a floor: the individual flags below can make things stricter (`PROTONMAIL_MODE=full` with `PROTONMAIL_READ_ONLY=true` is read-only; `assisted` with `PROTONMAIL_ALLOWED_ACTIONS=mark_read` allows only that) but never looser (`drafts` with `PROTONMAIL_ALLOW_SEND=true` still does not send). If you want a combination a mode does not give you, leave `PROTONMAIL_MODE` unset and use the flags. An unknown value is an error that lists the valid ones. The mode in force is shown by `get_runtime_status`, and the Claude Desktop bundle has a *Safety mode* setting for it.

All flags work in both the MCP server and CLI:

```bash
PROTONMAIL_TOOL_TIER=core            # expose 25 core tools instead of all 127 — saves context window
PROTONMAIL_READ_ONLY=true            # disable all write operations
PROTONMAIL_ALLOW_SEND=false          # disable SMTP sends only (other writes still work)
PROTONMAIL_CONFIRM_DESTRUCTIVE=true  # require confirmed:true on send, reply, forward, delete
PROTONMAIL_RESTRICT_OUTBOUND_TO_SELF=true  # every send may only go to your own address — the safe way to try the server
PROTONMAIL_ALLOW_EMPTY_FOLDER=true   # enable empty_folder (off by default): permanently deletes ALL messages in a folder
PROTONMAIL_ALLOWED_ACTIONS='mark_read,archive,trash'  # per-action allowlist
```

`batch_email_action` and `apply_thread_action` both support `dryRun: true` regardless of the above flags.

`PROTONMAIL_ALLOWED_ACTIONS` gates message actions (mark read/unread, star/unstar, archive, trash, restore, move, delete, and the flag/bulk/thread variants) and deleting folders or labels (as `delete`). Creating or renaming folders and labels, creating or deleting templates, importing messages, and clearing the cache or index are not in that list: they are blocked by `PROTONMAIL_READ_ONLY=true` and nothing else. To forbid them, run read-only.

**Trying it safely: `PROTONMAIL_RESTRICT_OUTBOUND_TO_SELF=true`.** With this on, the server can compose, draft, reply, forward and send for real, but every recipient (To, CC and BCC) must be your own Bridge login address; a `+tag` alias of it counts as yours. Anything else is refused with `RESTRICT_OUTBOUND_TO_SELF is enabled. Cannot send to: …` before any mail is built or queued. It covers `send_email`, `reply_to_email`, `reply_all_email`, `forward_email`, `send_draft`, `schedule_draft`, `send_test_email` and `unsubscribe_sender`, and it is checked again when a queued or scheduled send fires, so a send queued before you turned it on cannot slip out later. It does not stop the model from *writing* a message to someone else into a draft; it stops it from being sent.

**`PROTONMAIL_ALLOW_EMPTY_FOLDER`.** `empty_folder` deletes every message in a folder at once and cannot be undone, so it is switched off unless this is `true` (the call then fails with a message naming the variable). When enabled it still needs an explicit `confirmed: true` to delete: without it, it only returns a preview of what would be removed. For anything less than an entire folder use `bulk_delete`.

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
PROTONMAIL_SMTP_SECURE='true'         # true = implicit TLS, false = STARTTLS. Unset, the server tries the other mode itself if Bridge's SMTP mode differs
PROTONMAIL_IMAP_USERNAME=''           # optional: log in to IMAP as a different user than PROTONMAIL_USERNAME (default: the same). The send identity, and RESTRICT_OUTBOUND_TO_SELF, still use PROTONMAIL_USERNAME.
PROTONMAIL_IMAP_PASSWORD=''           # optional: a different IMAP password than PROTONMAIL_PASSWORD (default: the same)

# Secrets via file or command (avoids raw credentials in config)
PROTONMAIL_USERNAME_FILE='/path/to/user.txt'
PROTONMAIL_PASSWORD_FILE='/path/to/pass.txt'
PROTONMAIL_USERNAME_COMMAND='pass proton/username'
PROTONMAIL_PASSWORD_COMMAND='pass proton/password'

# Storage
PROTONMAIL_DATA_DIR="$HOME/.proton-mail-bridge-client"

# Tools
PROTONMAIL_TOOL_TIER='full'          # 'core' exposes 25 essential tools, incl. draft review/edit and list_accounts (saves context window); 'full' exposes all 127

# Safety
PROTONMAIL_READ_ONLY='false'
PROTONMAIL_ALLOW_SEND='true'
PROTONMAIL_ALLOW_REMOTE_DRAFT_SYNC='true'
PROTONMAIL_ALLOWED_ACTIONS='mark_read,mark_unread,star,unstar,archive,trash,restore,move,delete'
PROTONMAIL_CONFIRM_DESTRUCTIVE='false'
PROTONMAIL_APPROVAL='off'             # off | elicit | require: ask the person through MCP elicitation instead of trusting the model's confirmed:true (see Human approval)
PROTONMAIL_APPROVAL_TIMEOUT_SECONDS='120'  # 1-3600: how long the question waits; no answer means the call is not run
PROTONMAIL_DELEGATION='off'          # off | on: honour delegation grants made with grant-create (see Delegation grants)
PROTONMAIL_RESTRICT_OUTBOUND_TO_SELF='false'  # true: sends may only go to your own Bridge login address (To, CC and BCC; +tag aliases count as yours); anything else is refused, and queued/scheduled sends are re-checked when they fire. Covers send_email, reply_to_email, reply_all_email, forward_email, send_draft, schedule_draft, send_test_email, unsubscribe_sender. The safest way to try the server.
PROTONMAIL_ALLOW_EMPTY_FOLDER='false'         # true: enables empty_folder, which permanently deletes ALL messages in a folder (still needs confirmed:true; without it only a preview is returned). Off by default; use bulk_delete for a subset.
PROTONMAIL_ALLOW_UNSAFE_HTML='false'          # HTML in outgoing mail is always sanitized (scripts, event handlers and remote images/beacons removed). A send that passes sanitizeHtml:false is IGNORED — still sanitized, with a warning logged — unless this is exactly 'true'. Leave it off unless you deliberately send raw HTML.
PROTONMAIL_SEND_DELAY_SECONDS='0'    # >0: send_email, reply_to_email, reply_all_email and forward_email queue instead of sending immediately, cancelable via cancel_send (undoWindowSeconds overrides per call). send_draft is not delayed; use schedule_draft. Only fires while this server stays running.
PROTONMAIL_SIGNATURE=''              # Plain text, appended to send_email/reply_to_email/reply_all_email/forward_email bodies (text + HTML), after your own text and before any quoted/forwarded content. Every send now goes out multipart (a plain-text send auto-gets an html alternative too), so the signature always gets its HTML treatment, not just the text/plain part. Opt out per-message with appendSignature: false. Never applied to send_draft/schedule_draft — draft content is already finalized.
#
# Note: a signature configured inside Proton Mail itself (Settings → Identity and addressing)
# is only inserted by Proton's own web/app compose UI — it is NEVER applied to mail submitted
# over SMTP by an external client, including this one. There is no way to make Bridge apply it
# for you. Set PROTONMAIL_SIGNATURE above instead if you want a signature on messages this
# server sends.

# Sync
PROTONMAIL_AUTO_SYNC='true'
PROTONMAIL_AUTO_SYNC_FOLDER='INBOX,Sent'      # comma-separated folders the background sync keeps indexed
PROTONMAIL_AUTO_SYNC_FULL='false'             # true: each background pass is a full sync (larger sample per folder, and messages moved/deleted elsewhere are pruned from the index) instead of incremental
PROTONMAIL_AUTO_SYNC_LIMIT_PER_FOLDER='100'  # messages fetched per folder per background pass (1-500)
PROTONMAIL_STARTUP_SYNC='true'
PROTONMAIL_SYNC_INTERVAL_MINUTES='5'
PROTONMAIL_IDLE_WATCH='true'
PROTONMAIL_IDLE_MAX_SECONDS='30'

# Attachments
PROTONMAIL_TLS_CA_FILE=''              # PEM file with Bridge's exported certificate: trusted when Bridge is reached by a name other than localhost (another container, another machine)
PROTONMAIL_TLS_INSECURE_HOSTS=''      # comma-separated host names whose certificate is not verified, like localhost is (only for a private network you trust)
PROTONMAIL_SHORTEN_LINKS='false'     # true = long tracking links in Markdown bodies become host/… (unsubscribe, confirm, reset links are kept)
PROTONMAIL_MAX_INLINE_KB='40'         # in KB (older name PROTONMAIL_MAX_INLINE_BYTES still works, also in KB): largest attachment get_attachment_content returns inline as base64
PROTONMAIL_PDF_MAX_MB='10'            # largest PDF get_attachment_text extracts text from (1-100 MB); bigger ones are refused with a message
PROTONMAIL_PDF_MAX_PAGES='50'         # pages get_attachment_text reads from a PDF (1-2000); a longer PDF is cut off with a note saying how many pages are missing
PROTONMAIL_OCR_COMMAND=''             # optional: a program run as '<command> <image file> stdout' (tesseract's convention) so get_attachment_text can read images and PDF pages without a text layer. Started without a shell, 60 s limit; unset, such images and scans fail
PROTONMAIL_INDEX_ATTACHMENTS='false'  # true: text of PDF, DOCX, XLSX and PPTX attachments is added to the local index so search finds it (bounded, no OCR); more disk, slower sync

# Semantic search (optional; nothing runs unless the URL is set)
PROTONMAIL_EMBEDDINGS_URL=''          # http://127.0.0.1:11434/api/embed (Ollama) or an OpenAI-compatible .../v1/embeddings; mail text is sent there
PROTONMAIL_EMBEDDINGS_MODEL='nomic-embed-text'
PROTONMAIL_EMBEDDINGS_ALLOW_REMOTE='false'  # true: accept an endpoint on another machine (your mail text goes to that host)

# Tuning and diagnostics
PROTONMAIL_OP_DELAY_MS='0'            # minimum gap in ms between IMAP mailbox operations (0-5000); raise it to be gentler on a slow Bridge. 0 = no throttling
PROTONMAIL_DEBUG='false'              # true: get_connection_status and run_doctor include the raw underlying connection error text (otherwise only a classified cause and suggestion)
PROTONMAIL_CLAUDE_RUNTIME_DIR=''      # where the Claude Desktop installer puts its runtime copy (default: ~/Library/Application Support/Proton Mail Bridge Client on macOS, %APPDATA%\Proton Mail Bridge Client on Windows, ~/.local/share/proton-mail-bridge-client on Linux)
```

---

## Ask before sending: address and signature (optional skill)

With several accounts or a signature, the server sends from whichever `from` the caller passes and cannot know which one you meant. [`skills/send-with-identity`](skills/send-with-identity/SKILL.md) is a Claude skill that makes the agent ask "from which address, and with which signature?" before every send, reply, forward or schedule, then pass `from` and its own signature. On the four immediate-send tools (`send_email`, `reply_to_email`, `reply_all_email`, `forward_email`) that means `appendSignature: false` plus `isHtml: true` for an HTML signature, so nothing is doubled; drafts never get `PROTONMAIL_SIGNATURE` appended, so the skill writes the signature into the draft body, and `send_draft`/`schedule_draft` take no `from`, so the address and signature are settled on the draft first. It does not replace your explicit approval to send. Copy the folder to `~/.claude/skills/send-with-identity`, and fill in your addresses and signatures there (keep that copy private).

## Compared with Claude's native Gmail connector

| Capability | Gmail connector | Proton Mail Bridge Client |
|---|---|---|
| Setup | First-party OAuth | Requires Proton Bridge + this client |
| Search and read | Native Claude UX | IMAP + local index |
| Send email | No | Yes |
| Draft workflows | Better first-party UX | Full control incl. remote draft sync |
| Attachment content | Limited | Fetch, save to disk, read text from PDFs |
| Mailbox actions | Limited | Full (star, move, archive, trash, restore, delete, batch) |
| Folder management | No | Yes (create, rename, delete) |
| CLI access | No | Full parity with MCP |
| Privacy | Google-hosted | Proton E2E encryption, local Bridge |

---

## Tool surface

### Send
`send_email` · `send_test_email` · `reply_to_email` · `reply_all_email` · `forward_email` · `respond_to_invite` (answer a calendar invitation)

### Drafts
`create_draft` · `create_reply_draft` · `create_forward_draft` · `create_thread_reply_draft` · `list_drafts` · `list_remote_drafts` · `get_draft` · `update_draft` · `sync_draft_to_remote` · `send_draft` · `delete_draft`

### Read
`get_emails` · `get_email_by_id` · `count_messages` · `search_emails` · `search_indexed_emails` · `list_attachments` · `get_attachment_content` · `save_attachment` · `save_attachments`

### Triage
`get_folders` · `sync_folders` · `get_labels` · `get_threads` · `get_thread_by_id` · `get_thread_brief` · `get_actionable_threads` · `get_inbox_digest` · `get_follow_up_candidates` · `set_reply_reminder` · `list_reply_reminders` · `cancel_reply_reminder` · `find_document_threads` · `prepare_meeting_context` · `delete_thread` · `flag_thread` · `move_thread`

### Actions
`mark_email_read` · `star_email` · `move_email` · `archive_email` · `trash_email` · `restore_email` · `delete_email` · `batch_email_action` · `apply_thread_action` · `empty_folder` · `bulk_delete` · `bulk_move` · `bulk_update_flags` · `bulk_update_labels` · `update_message_flags` · `update_message_labels`

### Folder management
`create_folder` · `rename_folder` · `delete_folder` · `create_label` · `rename_label` · `delete_label`

### Analytics
`get_email_stats` · `get_email_analytics` · `get_contacts` · `get_volume_trends` · `folder_stats` · `top_senders`

### Diagnostics
`get_connection_status` · `get_runtime_status` · `run_doctor` · `get_audit_logs` · `verify_audit_log` · `get_events` · `list_grants` · `run_background_sync` · `wait_for_mailbox_changes` · `sync_emails` · `get_index_status` · `clear_cache` · `clear_index` · `get_logs`

### Unsubscribe & trust
`get_unsubscribe_info` · `unsubscribe_sender` — `get_email_by_id` also returns a `security` block (DKIM/SPF/DMARC, encryption, spam score)

### Undo-send, scheduling & snooze
`cancel_send` · `list_scheduled_sends` · `schedule_draft` · `snooze_email` · `cancel_snooze` · `list_snoozed` — send_email, reply_to_email, reply_all_email and forward_email queue instead of sending immediately when `PROTONMAIL_SEND_DELAY_SECONDS` is set; all three only fire while this server process stays running, see [Operational notes](#operational-notes)

### Templates
`create_template` · `list_templates` · `get_template` · `delete_template` · `render_template` — `{{variable}}` substitution, render then pass the result to `send_email`

### Contacts & categories
`find_contact` · `set_contact` · `import_contacts` · `define_category` · `list_categories` · `categorize_inbox` · `correct_category` — see [Contacts](#contacts-people-not-addresses) and [Own categories](#own-categories-separate-from-protons)

### Import/export & attachments
`export_email` · `import_email` · `get_attachment_text` · `get_emails_by_ids`

`get_attachment_text` reads text-like attachments and PDFs. A PDF comes back page by page, each page headed `--- Page N of M ---`, and the result has a `pdf` field with `totalPages`, `extractedPages`, `omittedPages` and `truncated`. It is limited by `PROTONMAIL_PDF_MAX_MB` (default 10) and `PROTONMAIL_PDF_MAX_PAGES` (default 50); past the page limit the text ends with a line saying how many pages were left out. A password-protected PDF, a damaged file and a scan without a text layer each fail with a short explanation. The PDF is read in memory with [unpdf](https://github.com/unjs/unpdf) (pure JavaScript, no native module): nothing is written to disk, nothing is downloaded, and a document that takes longer than 30 seconds is stopped.

It also reads **Word, Excel and PowerPoint files** (`.docx`, `.xlsx`, `.pptx`): a DOCX as its text, an XLSX as each sheet's name followed by its cells row by row, a PPTX slide by slide. They are opened in memory by a small built-in reader (no Office, no macros run, nothing written to disk). Limits: files up to 20 MB, the text cut at 500000 characters, and a ZIP with too many or too large parts is refused. Not supported: the old binary `.doc`, `.xls` and `.ppt`, password-protected files, and files with a DTD declaration; they are not read. Text inside images or embedded objects is not read either. Office files are read in a worker thread with a 10 second limit, so a heavy file cannot stall the server; control characters in the text are dropped. With `PROTONMAIL_OCR_COMMAND` set (for example `tesseract`, or with arguments such as `tesseract --psm 6`; words are split on spaces, single and double quotes group, and there is no shell, no variable or glob expansion), an image, and up to 10 pages of a PDF that has no text layer, are read by that program instead of failing; it is run without a shell as `<program> <arguments> <image file> stdout`, with a 60 second limit (the process is killed with SIGKILL at the limit), on images up to 20 MB. OCR is off unless you set it, and its output is only as good as the program's. With `PROTONMAIL_INDEX_ATTACHMENTS=true` the text of PDF and Office attachments (up to 8000 characters per attachment and 32000 per message, the first 20 pages of a PDF, no OCR) is added to the local index when a message is synced, so `search_indexed_emails` finds words that appear only in an attachment; an attachment that cannot be read is skipped.

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

## Performance and token cost

Measured against a real Proton Bridge with a ~57,000-message mailbox (INBOX 29k, Archive 23k, Sent 5k), September 2026. Your numbers depend on mailbox size and machine; the ratios are what to rely on.

| Call | Typical time |
|---|---|
| `search_indexed_emails` (local SQLite index) | ~10 ms |
| `get_emails` (3 messages) | ~0.2 s |
| `search_emails` with a `label`, or `folder` set to a small folder | < 1 s |
| `search_emails` in one large folder (INBOX, 29k) | ~2 s |
| `search_emails` with only `dateFrom`/`dateTo` in INBOX (29k) | ~1 s |
| `search_emails` with only `dateFrom`/`dateTo`, every real folder | ~2–2.5 s |
| `search_emails` with `subject` or `from` in INBOX | ~1.6 s |
| `search_emails` with free-text `query` in INBOX | ~2.5 s |
| `search_emails` with `subject` or `query`, every real folder | ~5.5–7 s |
| `search_emails` in a 50k-message label folder | ~3 s |
| `list_remote_drafts` (79 drafts) | ~15 ms |

Bridge answers IMAP `SEARCH` itself, and its cost grows with folder size. That is why a live search is slower than the local index, and why narrowing the scope matters most.

**Local index: filters and thread tools**

Measured in October 2026 (v2.7.0) on a copy of the same ~57,000-message index. "Warm" is a second call; the first call after the index changes (a sync, or another process writing to it) builds a map of which thread every message belongs to, which takes about 0.5 s (0.8 s for follow-ups and the digest) and about 31 MB of memory.

| Call | Warm |
|---|---|
| filter by `subject` or `from` | ~20 ms |
| filter by `to` | ~40 ms |
| `get_threads` with `query`, `label` or `folder` | ~25 ms |
| `get_threads` without a filter | ~40 ms |
| `get_thread_by_id` | ~1 ms |
| `get_follow_up_candidates` | 20-40 ms |
| `get_inbox_digest` | ~80 ms |
| `get_actionable_threads` | 17-35 ms |
| `prepare_meeting_context` with `person` or `domain` | ~30 ms |
| `find_document_threads` | ~225 ms |

**Make searches faster**

- **Prefer `search_indexed_emails`** when the index is current (`get_index_status`, `sync_emails`). It does not touch Bridge at all.
- **Pass `folder`** when you know it. With no `folder`, `search_emails` covers every *real* folder and skips **All Mail**, **Labels/\*** and **Starred**: those are views of mail that already lives in INBOX/Sent/Archive, and scanning them made an all-folders search about three times slower and inflated `totalMatched`. Pass `folder: "All Mail"` (or `"Labels/x"`) to search a view on purpose.
- **Use `label` for labels.** On Proton Bridge a label is the folder `Labels/<name>`, so `label: "Newsletters"` searches only that folder. A name that matches no label answers immediately with nothing instead of scanning.
- **Date filters are the cheapest filter Bridge offers** — about 1 s in INBOX and 2–2.5 s across every real folder, against 1.6 s / 5.5 s for `subject` and 2.5 s / 6–7 s for free-text `query`. When you can say *when* ("last week", "this month"), lead with `dateFrom`/`dateTo`. Even a wide range is fine: everything older than a year (about 20,000 messages) still took under 2 s.
- **Adding a date range to a text search does not make the text search faster.** In INBOX, `dateFrom` (last 30 days) + `subject` took about as long as `subject` alone (1.6 s vs 1.6 s), and + `query` 2.1 s vs 2.5 s: Bridge still does the text work. Use dates on their own to find the window, then search inside it (for example by `folder`, or by fetching that window and reading it).
- Free-text `query` searches message bodies on Bridge's side and is the slowest filter; `subject` and `from` are cheaper.
- (Single runs on one machine, so read them as ratios, not guarantees.)

**Keep responses (and token use) small**

- List and search results are compact by default: attachments are metadata only, and empty or derivable fields are left out. Pass `fields: ["subject","from","date"]` to trim further — 10 results is roughly 800 tokens that way, versus about 11,000 for 50 full results.
- Defaults are bounded: `search_emails`/`search_indexed_emails` return 50 (pass `limit` for more), `list_drafts` 20, `list_scheduled_sends` 50 newest first. Each reports `hasMore`; page with `offset`.
- Draft and queued-message bodies are shortened to a preview in list and update responses (`bodyTruncated`, `bodyLength`); use `get_draft` for one full draft. Attachment content is never inlined in a listing.
- Large attachments: set `PROTONMAIL_ALLOW_FILE_DOWNLOAD_DIR` and pass `saveTo`, rather than raising `PROTONMAIL_MAX_INLINE_KB`. **Do not point `PROTONMAIL_ALLOW_FILE_DOWNLOAD_DIR` at a broad directory such as `$HOME`:** `save_attachment` could then overwrite shell startup files, LaunchAgents or `~/.claude/settings.json`. The server refuses destinations inside any account's data directory (its `attachments` folder excepted) and the trusted CA file (`save_attachment(s)`, `export_email`), even when the download directory contains them, but it protects nothing else. This was already true before 2.17.
- Office files are read in a small pool: at most 2 documents at a time, up to 16 waiting (further ones fail with a `busy` error), each worker memory-limited and each job stopped after 10 seconds from its start.
- **`PROTONMAIL_TOOL_TIER=core`** exposes 25 tools instead of 127: about 7k tokens of tool definitions instead of about 21k (measured with 116 tools, before the eleven tools of 2.17 were added and not re-measured; the full set now costs somewhat more) (roughly 67% less; the earlier measurement with a reference tokenizer, 7k against 20k for 96 tools, scaled by the 3.7% the four newest tool definitions add), paid on every conversation that loads the server.
- Repeating an `update_draft` that changes nothing on a draft whose remote copy is already in sync does no store write and no IMAP upload. (A draft whose last sync failed, or that was edited with `syncToRemote:false`, still syncs.)

**Working with drafts**

Drafts live in a local store first; the copy in Proton's Drafts folder is a separate upload.

- **Edit a long draft with `bodyEdits`, not by resending `body`.** `update_draft` takes `bodyEdits: [{find, replace}]` (optionally `all:true`) and changes just those fragments of the stored body: a two-sentence change to a ~14,000-character draft is a request of about 200 characters instead of about 14,000 (roughly 70 times smaller), and the model only has to write the words that change. Each `find` must match exactly once (add surrounding text, or set `all:true`); otherwise nothing is changed and the error says which edit failed and why. Edits apply in order, all-or-nothing, and match the stored text literally — for an HTML draft, the HTML source. Pass either `body` or `bodyEdits`, not both. The response reports `bodyEditsApplied`.
- **Each `update_draft` uploads the whole draft to the Drafts folder** (the full message, attachment bytes included — about 1.4 MB of MIME for a 1 MiB attachment) unless you pass `syncToRemote:false`. That upload is the slow part, and it is Bridge's, not ours: on the reference mailbox a local edit takes 2–6 ms, the first sync of a draft about 1.5 s, and a later sync that *replaces* the previous remote copy about 3.5 s (upload ≈ 1.4 s, then Bridge deleting the old copy ≈ 2.1 s; Bridge does not replace a draft appended with the same Message-ID, so the delete is required). Sending a change as `bodyEdits` or as a full `body` costs the same on the server side; `bodyEdits` saves the model's tokens, not Bridge time. So when you are making several edits in a row, do them with `syncToRemote:false` and finish with one `sync_draft_to_remote` — six edits are then about 3.5 s of waiting instead of about 20 s.
- **The response stays small however big the draft is.** `create_draft`, the reply/forward/thread-reply draft creators, `update_draft` and `sync_draft_to_remote` return a body preview and attachment metadata only (an edit of a ~200 KB draft cost about 300 tokens; a draft with a 1 MiB attachment about 220–300). Only `get_draft` returns the full body and attachment content.
- **Nothing to do if nothing changed:** repeating an `update_draft` that changes nothing on an already-synced draft does no write and no upload.
- `list_drafts` is local and returns the 20 most recently updated (`hasMore`, `offset` to page); `list_remote_drafts` reads the Drafts folder over IMAP (about 15 ms for 79 drafts).
- **Large attachments make every draft operation slower.** The store is one JSON file, so an edit reads and rewrites the whole file, attachment content of *every* draft included. In a benchmark (mocked IMAP), a tiny edit took about 1 ms normally and about 15 ms when a different draft held a 10 MiB attachment. If you edit drafts constantly, attach big files as late as possible.
- A draft cannot be edited while it is being sent, and simultaneous syncs of the same draft are serialized (so two clients cannot upload two copies).

**IMAP IDLE and the shared connection.** The server keeps one IMAP connection per account. The IDLE watcher (`PROTONMAIL_IDLE_WATCH`, on by default) waits on it, and since 2.1.25 it steps aside as soon as another operation needs the mailbox, so it no longer adds delay. Before that, with IDLE on, a single-folder search took 26–31 s and a multi-folder search did not finish.

To check a real Bridge yourself, run the read-only smoke test: `PROTONMAIL_USERNAME=… PROTONMAIL_PASSWORD=… node test/live/readonly-smoke.mjs`. It uses `PROTONMAIL_READ_ONLY=true` and a throwaway data directory, sends nothing, and prints counts and timings only.

---

## Operational notes

- `get_emails` and `search_emails` return a composite `emailId` — use it for all subsequent reads and actions.
- `search_indexed_emails` supports `from:`, `to:`, `subject:`, `label:`, `domain:` shortcuts.
- The local index lives at `PROTONMAIL_DATA_DIR/mail-index.sqlite`. Background sync and IMAP IDLE keep it warm.
- **Several clients at once.** Every MCP client starts its own server. Per data directory, only one of them runs the background sync and the IDLE watch (it holds `background-sync.lock`); the others serve tools from the index and take over when it exits. `get_runtime_status` shows `backgroundSync.leader`. A manual `sync_emails` / `run_background_sync` always runs.
- Filters on the local index ignore case and accents, and match spelling variants: `Müller` finds `Mueller`, `lodz` finds `Łódź`, `strasse` finds `Straße`. Live `search_emails` and `count_messages` go through Bridge: a query with umlauts or other non-ASCII letters also matches the spelled-out form (`Müller` finds `Mueller`), but a plain ASCII query is sent as typed, so `Mueller` does not find `Müller` there. Use `search_indexed_emails` for that.
- Audit logs live at `PROTONMAIL_DATA_DIR/audit.log`.
- Draft sync is best-effort — the local draft is always preserved even if remote sync fails.
- System folders (INBOX, Sent, Trash, Spam, Archive, All Mail) are guarded against accidental deletion.

---

## Troubleshooting

**"Wrong password" or connection refused**
Make sure you're using the **Bridge password**, not your Proton account password. Find it in the Bridge app under Account → Copy password. Bridge must be running before the MCP server or CLI can connect.

**Every tool answers "not configured"**
`PROTONMAIL_USERNAME` and `PROTONMAIL_PASSWORD` are not set for the server. Since 2.7.2 it still starts without them, lists its tools and answers each call with that message (it used to exit at once, which clients showed as "Connection closed"). Set both (the password is the Bridge password) and restart; `proton-mail-bridge-client setup-claude-desktop` does it for Claude Desktop. Any other configuration mistake, such as a bad port, still stops the server at start.

**macOS native module crash after update**
`better-sqlite3` is a native binary built for your machine. After a major Node.js upgrade or environment change, rebuild it:
```bash
proton-mail-bridge-client setup-claude-desktop
```
This reinstalls the runtime and rebuilds native modules in place.

**Claude can't see the connector**
After changing the MCP config, restart Claude Desktop fully (not just reload). Then check **`+` → Connectors → proton-mail-bridge**. If it's not there, run `proton-mail-bridge-client doctor` to validate the connection.

**Searches take ~30 seconds, or time out**
Upgrade to 2.1.25 or later. Before that, the IMAP IDLE watcher held the shared connection for its whole idle period and every other operation waited behind it (see [Performance and token cost](#performance-and-token-cost)). On a current version, a slow `search_emails` is Bridge's own `SEARCH` over a large folder: pass `folder` or `label`, or use `search_indexed_emails`.

**Folder not found when moving email**
Use `Folders/Name` for real folders (e.g., `Folders/Receipts`), not just `Name`. Labels and folders share the same namespace in Proton Bridge but are structurally different.

---

## Related projects

- **[proton-drive-mcp](https://github.com/googlarz/proton-drive-mcp)** — the companion MCP server and CLI for **Proton Drive**: upload, download, share and manage your end-to-end encrypted files from Claude. Run it next to this server to work with Proton Mail and Proton Drive in one conversation, for example by saving an attachment with `save_attachment` and then uploading it to Drive. If `PROTONMAIL_ALLOW_FILE_DOWNLOAD_DIR` points inside a folder that the Proton Drive desktop app syncs, attachments saved there also end up in Drive without any extra step.

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## Contributing

Bug reports and pull requests welcome: [github.com/googlarz/proton-mail-bridge-client/issues](https://github.com/googlarz/proton-mail-bridge-client/issues)

Testers wanted: some things (answering invitations from Outlook, Proton Calendar and Apple Calendar, Windows and Linux with a real Bridge, `brew install`) could not be verified by the maintainer. See [issue #32](https://github.com/googlarz/proton-mail-bridge-client/issues/32).

## License

MIT
