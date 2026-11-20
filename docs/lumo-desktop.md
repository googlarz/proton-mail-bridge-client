# Using this server with Lumo Desktop

Written against version 2.19.8. This server is unofficial and is not made by or affiliated with Proton.

## Verification status (read this first)

- **Not tested in Lumo.** Lumo Desktop was not installed when this was written. Nothing below was run inside Lumo. The server side (command, environment variables, modes) matches how the README documents Claude Desktop, Claude Code and Cline; the Lumo side comes only from Proton's public pages, read on 2026-11-20:
  - https://proton.me/support/lumo-connectors
  - https://proton.me/blog/lumo-desktop-features
- Lumo's "Add MCP server" form was not seen. The pages say it exists and takes "the server details", for local (stdio) and remote HTTP servers, but do not list its fields. The field names below (command, arguments, environment variables) are an assumption taken from how other MCP clients work. Check the form and adjust.
- Anything marked **unverified** needs Lumo installed to confirm.

## What Proton says (confirmed on the pages above)

- Lumo Desktop for macOS, Windows and Linux has Connectors, Schedules and Skills.
- Connector types: local tools (filesystem, shell, browser content fetching), Proton Mail through Proton Mail Bridge, third-party services, and your own local or remote MCP servers.
- Add a connector: Customize > Connectors, select it and click Connect; for a custom server click Add MCP server and enter its details.
- Every action of a connector has a permission: Auto-approve, Ask human, or Deny. **All actions are Auto-approve by default.** Change it per action in Customize > Connectors > the connector > Functions tab.
- Connectors are on in every conversation by default; turn them off per conversation under Tools > Connectors.
- Proton states that connectors are covered by Lumo's zero-access encryption, are not logged and are not used to train models.
- Connectors can be combined with Schedules (for example a weekly inbox summary).

## Add this server as a custom MCP server

1. Install the server and check it works (Bridge running, signed in):

   ```bash
   npm install -g proton-mail-bridge-client
   proton-mail-bridge-client doctor
   ```

2. In Lumo Desktop: Customize > Connectors > Add MCP server, choose the local (stdio) type, and enter:

   | Setting (field names unverified) | Value |
   |---|---|
   | Command | `proton-mail-bridge-mcp` |
   | Arguments | none |
   | `PROTONMAIL_USERNAME` | your Bridge login, for example `you@proton.me` |
   | `PROTONMAIL_PASSWORD` | the **Bridge password** (Bridge > account > Mailbox details), not your Proton account password |
   | `PROTONMAIL_IMAP_HOST` / `_PORT` / `_SECURE` | `127.0.0.1` / `1143` / `false` (use your Bridge's values) |
   | `PROTONMAIL_SMTP_HOST` / `_PORT` | `127.0.0.1` / `1025` |
   | `PROTONMAIL_MODE` | `drafts` (see below) |

   As a JSON block, in the same shape the README uses for Claude Desktop and Cline (use this if Lumo takes pasted JSON; unverified):

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
           "PROTONMAIL_SMTP_PORT": "1025",
           "PROTONMAIL_MODE": "drafts"
         }
       }
     }
   }
   ```

3. If Lumo does not find `proton-mail-bridge-mcp` (a desktop app may not inherit your shell `PATH`; unverified), use the absolute path from `which proton-mail-bridge-mcp`.
4. For credentials in files or from a command instead of plain text, use `PROTONMAIL_USERNAME_FILE`, `PROTONMAIL_PASSWORD_FILE` or the `_COMMAND` variants, as in the README's Claude Desktop section.

The `proton-mail-bridge-client setup-claude-desktop` wizard only configures Claude Desktop; it does not touch Lumo.

## Auto-approve is the default: decide before you connect

Lumo starts every action of a new connector at Auto-approve. For a mailbox that is the opposite of a safe start. Two layers, use both:

1. **The server's mode (works in any client).** Set `PROTONMAIL_MODE=drafts` (reading, searching and drafts; nothing sent, moved or deleted) or `read-only`. The server refuses the rest itself, whatever Lumo's setting says. Note the server's own default with the variable unset is `full`, so set it explicitly.
2. **Lumo's per-action permissions (Functions tab).** Set the actions that reach outside or destroy to **Ask human** or **Deny**: `send_email`, `reply_to_email`, `reply_all_email`, `forward_email`, `send_draft`, `schedule_draft`, `delete_email`, `delete_thread`, `bulk_delete`, `empty_folder`, `bulk_move`. Proton's blog gives the same pattern as an example (search the inbox, ask before sending, block deleting).

About `PROTONMAIL_APPROVAL`:

- `elicit` and `require` make the server ask you through the MCP client (elicitation). **Whether Lumo supports MCP elicitation is unverified.** If it does not, `elicit` falls back to the model's own `confirmed: true`, which is not a lock; `require` refuses the call instead, so it fails closed.
- Until you have checked, treat Lumo's **Ask human** setting and `PROTONMAIL_MODE` as the real controls, and `PROTONMAIL_APPROVAL=require` as the fail-closed option if you want the server to insist.
- The server's other defences (mode presets, audit log, taint gates for suspicious mail text) are in the [threat model](threat-model.md) and do not depend on the client.

## Privacy

The server and its search index run on your computer and talk only to Bridge on 127.0.0.1. The mail text a tool returns is then read by the model Lumo uses. Proton describes Lumo's encryption and no-training policy (links above); this document does not evaluate those claims. The mail text still leaves your machine for whatever model answers.

## Native "Proton Mail through Bridge" connector vs this server

Only what the Proton pages state is marked as confirmed. Anything else needs Lumo installed.

| Topic | Lumo native connector | This server |
|---|---|---|
| Exists in Lumo Desktop, uses Bridge | Confirmed: "Proton Mail through Proton Mail Bridge" | Uses Bridge (IMAP/SMTP on 127.0.0.1) |
| Who makes it | Proton | Unofficial, independent, MIT |
| Find emails, draft and send replies | Confirmed as examples on the pages | Yes (README) |
| Per-action Auto-approve / Ask human / Deny | Confirmed for connectors in general (Functions tab) | Same Lumo controls apply when added as a custom MCP server (expected, unverified for this server) |
| Default permissions | Confirmed: all actions Auto-approve | Lumo applies the same default; set `PROTONMAIL_MODE` yourself |
| Server-side safety modes (`read-only`, `drafts`, `assisted`, `full`) | Not on the pages; unverified | Yes |
| Hash-chained audit log | Not on the pages; unverified | Yes (`verify_audit_log`) |
| Prompt-injection mitigations for mail text | Not on the pages; unverified | Mitigations only, see threat model |
| Which actions/tools it offers | Not listed on the pages; unverified | See the README and `docs/cli.md` |
| Search over a local index, rules, templates, multi-account | Unverified | Yes (README) |
| Works with Schedules | Pages say connectors can be combined with Schedules | Expected to work as a connector; unverified. Scheduled runs with a write-capable mode need care |
| Zero-access encryption, no logging, no training | Confirmed as Proton's statement for connectors | Applies to what Lumo does with data; this server logs only to your own disk |
| Works in other clients (Claude, Cline, CLI) | No | Yes |

If the native connector already does what you need, use it: fewer moving parts. This server is for people who want the mode presets, the audit log, the CLI, or the same server across several clients.

## What to check once Lumo is installed

- The Add MCP server form: real field names, whether it takes a JSON block, whether it inherits `PATH`.
- Whether the tool list loads (a large tool list may be shown or limited differently; unverified).
- That `PROTONMAIL_MODE=drafts` produces the refusal text when Lumo asks to send ("Send operations are disabled by the current runtime policy.").
- Whether `PROTONMAIL_APPROVAL=elicit` actually shows a prompt in Lumo.
- Whether Lumo's Ask human prompt shows enough detail (recipient, subject) to decide.
- Then update this file and remove the unverified markers that no longer apply.
