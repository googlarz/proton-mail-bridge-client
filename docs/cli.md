# CLI reference

Full command reference for the `proton-mail-bridge-client` CLI. See the [main README](../README.md) for install and setup.

```bash
proton-mail-bridge-client <command> [options]
```

All commands support `--json` for machine-readable output, and `--help` (or `-h`) anywhere on the
command line to print that command's usage without running it or connecting to Bridge:

```bash
proton-mail-bridge-client clear-index --help
proton-mail-bridge-client help bulk-delete
proton-mail-bridge-client version
```

## Argument syntax

- `--flag value` and `--flag=value` are equivalent. The `=` form splits at the first `=`, so
  `--body=a=b` passes `a=b`.
- A value that starts with `--` must use the `=` form (`--body="--- signature"`) or come after a
  bare `--`. Otherwise it is read as the next flag.
- A bare `--` ends option parsing: everything after it is a plain argument, even if it looks like
  a flag (`search -- --odd-term`).
- An empty value is a value: `--subject=` and `--subject ""` pass an empty string.
- Each flag may be given once; repeating a value flag is an error.
- Unknown flags are an error (exit code 2) that names the flag and lists the valid ones, rather
  than being ignored. Run `<command> --help` to see them.
- Numeric flags (`--limit`, `--offset`, `--days`, `--timeout`, `--max`, `--undo-window`,
  `--age-hours`) take digits only; `5x`, `1.5` and `-1` are rejected.
- Bodies and notes are passed exactly as given. A piped body loses only its final newline.

## Exit codes

- `0`: success.
- `1`: the command failed, including a failed `doctor`, `connection-status`, `run-doctor` or
  `get-connection-status` check (Bridge unreachable or login rejected), and `batch` or
  `bulk-*` runs where at least one item failed. The JSON output is the same as on success, so
  scripts can parse it and still branch on the exit code.
- `2`: usage error: unknown or repeated flag, malformed number, or a `bulk-delete` / `bulk-move`
  without a filter.

```bash
proton-mail-bridge-client doctor && proton-mail-bridge-client sync
```

## Read

```bash
proton-mail-bridge-client emails --folder INBOX --limit 25
proton-mail-bridge-client read INBOX::25642
proton-mail-bridge-client search "invoice" --limit 10
proton-mail-bridge-client search --live --from openai.com
proton-mail-bridge-client attachments INBOX::25642
proton-mail-bridge-client thread <threadId>
proton-mail-bridge-client folder-stats INBOX
proton-mail-bridge-client labels
proton-mail-bridge-client index-status
```

`read`, `attachments`, `search --live` and the single-message actions below call the same tool
handlers the MCP server uses, so an id prefixed with an account slug (`<slug>::INBOX::25642`,
see `list-accounts`) is routed to that account, and `PROTONMAIL_ALLOWED_ACTIONS` and
`PROTONMAIL_CONFIRM_DESTRUCTIVE` apply exactly as they do for Claude.

## Triage

```bash
proton-mail-bridge-client digest
proton-mail-bridge-client threads "quarterly review"
proton-mail-bridge-client get-threads --args '{"folder":"Archive","limit":20}'   # threads with a message in one folder
proton-mail-bridge-client actionable
proton-mail-bridge-client followups
proton-mail-bridge-client thread-brief <threadId>
proton-mail-bridge-client document-threads --category invoice
proton-mail-bridge-client meeting-context alice@example.com
```

Every triage command above covers all configured accounts; add `--args '{"account":"work@example.com"}'` (or the account slug) to the tool forms to look at one.

### Reply reminders

Ask to be told when a message goes unanswered by a date. A reminder is a local note; its state (waiting, due, answered) is worked out from the local index each time you look, and a later message in the thread from one of the people you wrote to settles it (a message from anyone else does not). Due reminders also appear in `digest`.

```bash
proton-mail-bridge-client set-reply-reminder Sent::5195::f6a63249 --args '{"afterDays":5,"note":"ask about the budget"}'
proton-mail-bridge-client list-reply-reminders                  # waiting and due, due first
proton-mail-bridge-client list-reply-reminders --args '{"status":"all"}'
proton-mail-bridge-client cancel-reply-reminder <id>
```

## Compose & send

```bash
proton-mail-bridge-client send --to bob@example.com --subject "Hey" --body "Hello"
echo "Hello" | proton-mail-bridge-client send --to bob@example.com --subject "Hey"

# Queue with an undo window instead of sending immediately (overrides
# PROTONMAIL_SEND_DELAY_SECONDS for this one send; 0 forces immediate send
# even if the server has a default window configured)
proton-mail-bridge-client send --to bob@example.com --subject "Hey" --body "Hello" --undo-window 10

# A queued send only fires while an MCP server is running against the same
# data directory — a plain CLI invocation exits right after queuing, so
# without --wait it won't deliver on its own. --wait keeps this command
# open (polling) until the send actually fires or is canceled elsewhere.
proton-mail-bridge-client send --to bob@example.com --subject "Hey" --body "Hello" --undo-window 10 --wait

proton-mail-bridge-client reply INBOX::25642 --body "On it."
proton-mail-bridge-client reply INBOX::25642 --reply-all --body "On it."
proton-mail-bridge-client forward INBOX::25642 --to carol@example.com
```

### Calendar invitations

Answer an invitation in a message. `respond-to-invite` reads the invitation, then sends the organizer a calendar reply from the account that holds the message (or the account the invitation names, when that is exactly one of yours), and warns when the organizer is not the sender of the message; `--args '{"dryRun":true}'` shows who would be answered and what the reply says without sending. It follows the same send settings as `reply`.

```bash
proton-mail-bridge-client respond-to-invite INBOX::25642 accept
proton-mail-bridge-client respond-to-invite INBOX::25642 decline --args '{"comment":"Out that week"}'
proton-mail-bridge-client respond-to-invite INBOX::25642 tentative --args '{"dryRun":true}'
```

## Mailbox actions

```bash
proton-mail-bridge-client move INBOX::25642 Folders/Archive
proton-mail-bridge-client archive INBOX::25642
proton-mail-bridge-client trash INBOX::25642
proton-mail-bridge-client restore Trash::25642
proton-mail-bridge-client mark-read INBOX::25642
proton-mail-bridge-client mark-read INBOX::25642 --unread
proton-mail-bridge-client star INBOX::25642
proton-mail-bridge-client delete INBOX::25642
proton-mail-bridge-client batch archive INBOX::100,INBOX::101,INBOX::102
proton-mail-bridge-client thread-action <threadId> archive
```

### Bulk actions by filter

`bulk-delete` and `bulk-move` act on every message in a folder that matches the filters
`--from`, `--subject`, `--since` and `--before`. At least one filter is required (exit code 2
otherwise, since an empty filter would match the whole folder). Preview with `--dry-run` first.
`bulk-delete` moves to Trash unless `--permanent` is given (which needs `--confirmed` when
`PROTONMAIL_CONFIRM_DESTRUCTIVE` is on); `--max` caps the batch size. Exits 1 if any message failed.

```bash
proton-mail-bridge-client bulk-delete --from newsletter@example.com --before 2025-01-01 --dry-run
proton-mail-bridge-client bulk-delete --from=newsletter@example.com --before=2025-01-01
proton-mail-bridge-client bulk-move Folders/Receipts --subject receipt --folder INBOX --dry-run
```

## Folders & labels

```bash
proton-mail-bridge-client folders
proton-mail-bridge-client create-folder Folders/Receipts
proton-mail-bridge-client rename-folder Folders/Receipts Folders/Bills
proton-mail-bridge-client delete-folder Folders/Bills
proton-mail-bridge-client empty-folder Trash --confirmed
```

`empty-folder` permanently deletes every message in the folder and only runs when
`PROTONMAIL_ALLOW_EMPTY_FOLDER=true` and `--confirmed` is given; without `--confirmed` it returns
a preview.

## Drafts

```bash
proton-mail-bridge-client drafts
proton-mail-bridge-client draft-create --to bob@example.com --subject "Draft" --body "..."
proton-mail-bridge-client draft-read <id>
proton-mail-bridge-client draft-update <id> --subject "Updated subject"
proton-mail-bridge-client draft-reply INBOX::25642 --body "Will do."
proton-mail-bridge-client draft-forward INBOX::25642 --to carol@example.com
proton-mail-bridge-client draft-thread-reply <threadId> --body "Thanks, all."
proton-mail-bridge-client draft-sync <id>
proton-mail-bridge-client draft-send <id>
proton-mail-bridge-client draft-delete <id>
proton-mail-bridge-client remote-drafts
```

## Analytics & diagnostics

```bash
proton-mail-bridge-client stats
proton-mail-bridge-client analytics
proton-mail-bridge-client contacts
proton-mail-bridge-client volume-trends --days 14
proton-mail-bridge-client watch --timeout 30
proton-mail-bridge-client test-email you@example.com
proton-mail-bridge-client doctor
proton-mail-bridge-client status
proton-mail-bridge-client connection-status
proton-mail-bridge-client runtime-status
proton-mail-bridge-client get-logs --limit 50 --level error
proton-mail-bridge-client clear-cache
proton-mail-bridge-client sync --folder INBOX --limit 150

# --full also detects and prunes messages no longer in this folder (moved,
# archived, trashed, or deleted by any client) — the default incremental sync
# only ever adds/updates messages, so a trashed email can keep showing up in
# search/digest/thread results indefinitely without this. Sync each folder
# you want cleaned up.
proton-mail-bridge-client sync --folder INBOX --full
```

## Shell completion

```bash
source <(proton-mail-bridge-client completion bash)     # bash
source <(proton-mail-bridge-client completion zsh)      # zsh, after compinit
proton-mail-bridge-client completion fish | source      # fish
```

Completes the command names and each command's flags. The scripts are generated from the same tables the parser uses, so they match the installed version. Put the line in your shell's startup file to keep it.

## Ambient notifications

Run as a background daemon — sends a system notification (macOS / Linux) whenever new mail arrives:

```bash
proton-mail-bridge-client notify                              # foreground (Ctrl+C to stop)
proton-mail-bridge-client notify &                            # background
proton-mail-bridge-client notify --folder INBOX --timeout 60  # custom folder and idle timeout
```

Each event is also written as a JSON line to stdout:

```json
{"event":"new_mail","folder":"INBOX","count":2,"at":"2026-05-18T14:32:01.000Z"}
```

Uses IMAP IDLE — no polling between events. Reconnects automatically on transient errors.

## Claude Desktop

```bash
proton-mail-bridge-client claude setup      # interactive setup wizard
proton-mail-bridge-client claude install    # install or update the Claude Desktop runtime
proton-mail-bridge-client claude update     # alias for install
proton-mail-bridge-client claude check      # integration status (alias: claude doctor)
proton-mail-bridge-client setup-claude-desktop   # the wizard, runnable from any install
```

## 1:1 tool commands

Every MCP tool has a dedicated CLI subcommand: either one of the friendlier
named commands above, or, for tools without a hand-tuned command, a command
matching the tool name (e.g. `snooze-email`, `create-template`,
`get-attachment-text`). Required fields are positional; anything else
(optional flags, arrays, nested objects) goes through `--args '{...}'` or
`--args-file <path>`, same as `tool` below. Run
`proton-mail-bridge-client help <command>` for one command's usage, or
`proton-mail-bridge-client help` for the full list.

### Sending and queued sends

```bash
proton-mail-bridge-client reply-to-email INBOX::123 "Sounds good, thanks!"
proton-mail-bridge-client reply-all-email INBOX::123 "Thanks, all."
proton-mail-bridge-client forward-email INBOX::123 carol@example.com
proton-mail-bridge-client schedule-draft <draftId> 2026-01-15T09:00:00.000Z
proton-mail-bridge-client list-scheduled-sends
proton-mail-bridge-client cancel-send <id>
proton-mail-bridge-client list-drafts
proton-mail-bridge-client unsubscribe-info INBOX::123
proton-mail-bridge-client unsubscribe-sender INBOX::123 --args '{"confirmed":true}'
```

### Reading and searching (tool forms)

```bash
proton-mail-bridge-client get-email-by-id INBOX::123
proton-mail-bridge-client get-emails-by-ids INBOX::1,INBOX::2
proton-mail-bridge-client search-emails --args '{"from":"stripe.com","limit":5}'
proton-mail-bridge-client search-indexed-emails --args '{"query":"invoice"}'
proton-mail-bridge-client count-messages --args '{"folder":"INBOX","from":"stripe.com"}'
proton-mail-bridge-client top-senders --args '{"folder":"INBOX","limit":10}'
proton-mail-bridge-client get-folders
proton-mail-bridge-client sync-folders
proton-mail-bridge-client get-labels
proton-mail-bridge-client get-threads
proton-mail-bridge-client get-inbox-digest
proton-mail-bridge-client get-follow-up-candidates
```

### Actions on one message (tool forms)

```bash
proton-mail-bridge-client mark-email-read INBOX::123
proton-mail-bridge-client star-email INBOX::123
proton-mail-bridge-client move-email INBOX::123 Folders/Archive
proton-mail-bridge-client archive-email INBOX::123
proton-mail-bridge-client trash-email INBOX::123
proton-mail-bridge-client restore-email Trash::123
proton-mail-bridge-client delete-email INBOX::123 --args '{"confirmed":true}'
proton-mail-bridge-client update-message-labels INBOX::123 --args '{"labelsToAdd":["Receipts"]}'
proton-mail-bridge-client update-message-flags INBOX::123 --args '{"flagsToAdd":["\\Flagged"]}'
```

### Snooze

```bash
proton-mail-bridge-client snooze-email INBOX::123 2026-01-15T09:00:00.000Z
proton-mail-bridge-client list-snoozed
proton-mail-bridge-client cancel-snooze <id>
```

### Templates

```bash
proton-mail-bridge-client create-template welcome "Welcome, {{firstName}}!" "Hi {{firstName}}, thanks for joining."
proton-mail-bridge-client list-templates
proton-mail-bridge-client get-template <id>
proton-mail-bridge-client render-template <id> --args '{"variables":{"firstName":"Alex"}}'
proton-mail-bridge-client delete-template <id>
```

### Many messages and threads

`bulk-update-flags` and `bulk-update-labels` take their ids or match filter through `--args`; both
exit 1 if any message failed.

```bash
proton-mail-bridge-client bulk-update-flags --args '{"emailIds":["INBOX::1","INBOX::2"],"flagsToAdd":["\\Seen"]}'
proton-mail-bridge-client bulk-update-labels --args '{"emailIds":["INBOX::1"],"labelsToAdd":["Receipts"]}'
proton-mail-bridge-client move-thread <messageId> Folders/Archive
proton-mail-bridge-client delete-thread <messageId>
proton-mail-bridge-client flag-thread <messageId> --args '{"flagsToAdd":["\\Seen"]}'
```

### Labels

```bash
proton-mail-bridge-client create-label Receipts
proton-mail-bridge-client rename-label Receipts Bills
proton-mail-bridge-client delete-label Bills
```

### Attachments, import and export

```bash
proton-mail-bridge-client list-attachments INBOX::123
proton-mail-bridge-client get-attachment-content INBOX::123 <attachmentId>
proton-mail-bridge-client get-attachment-text INBOX::123 <attachmentId>
proton-mail-bridge-client save-attachment INBOX::123 <attachmentId> --args '{"outputPath":"/tmp/out"}'
proton-mail-bridge-client save-attachments INBOX::123 --args '{"outputPath":"/tmp/out"}'
proton-mail-bridge-client export-email INBOX::123
proton-mail-bridge-client import-email --file message.eml
```

### Status, accounts and maintenance (tool forms)

```bash
proton-mail-bridge-client list-accounts --checkConnections
proton-mail-bridge-client get-connection-status
proton-mail-bridge-client get-runtime-status
proton-mail-bridge-client run-doctor
proton-mail-bridge-client run-background-sync
proton-mail-bridge-client sync-emails
proton-mail-bridge-client get-index-status
proton-mail-bridge-client get-audit-logs
proton-mail-bridge-client clear-index
```

`clear-index` deletes the local SQLite index (it is rebuilt by the next sync); it never touches
mail on the server.

## MCP tool passthrough

Any MCP tool is also callable directly from the CLI by name — useful for
one-offs or tools you don't want a dedicated command name for:

```bash
proton-mail-bridge-client tools
proton-mail-bridge-client tool get_connection_status --json
proton-mail-bridge-client tool search_indexed_emails --args '{"query":"invoice","limit":3}'
```

## Pipe and script

```bash
# Morning digest to a file
proton-mail-bridge-client digest --json > ~/morning-mail.json

# Pull every email from a domain
proton-mail-bridge-client search --from stripe.com --json | jq '.[].subject'

# Pipe a script's output directly into an email
echo "Deploy complete on $(hostname) at $(date)" \
  | proton-mail-bridge-client send --to alerts@example.com --subject "Deploy done"

# Scheduled digest every weekday at 8am (cron)
0 8 * * 1-5 proton-mail-bridge-client digest >> ~/mail-log.txt

# Count unread in INBOX
proton-mail-bridge-client emails --folder INBOX --json | jq '[.[] | select(.isRead == false)] | length'
```
