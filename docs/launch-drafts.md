# Launch post drafts

Drafts only; nothing has been posted. Facts last checked against version 2.19.8 (2026-11-20). Edit before use and check each claim against the README at the time you post. Replace `<repo URL>` with the GitHub link.

Facts all three rely on (from the README): unofficial, not made by or affiliated with Proton; talks to Proton Bridge on 127.0.0.1; the index and audit log are on your disk; a new install through the setup wizard (2.18.0 and later) starts in `drafts` mode, while the server's own default with `PROTONMAIL_MODE` unset is still `full`; the mail text the AI model reads goes to the model provider unless the model is local.

## r/ProtonMail

**Title:** Unofficial tool: let an AI assistant use your Proton Mail through Bridge, with read-only and drafts modes

I made an open-source MCP server and command-line tool that sits on top of Proton Bridge. It is unofficial and has nothing to do with Proton.

It talks only to Bridge on localhost and keeps its search index on your disk. To be clear about one thing: if you use it with Claude, the text of the mails Claude reads goes to Anthropic. A local model avoids that (there is a doc on it, experimental). So this is not "your mail never leaves your machine".

What you can set with `PROTONMAIL_MODE`:

- `read-only`: reading and searching only.
- `drafts`: also drafts and flags; no sending, moving or deleting.
- `assisted`: sending and moving allowed, with `confirmed: true`.
- `full`: everything. This is the server's default when the variable is unset; the setup wizard now starts new installs in `drafts`.

There is also an optional approval step through the client and a hash-chained audit log of changes.

Known limits: it needs Bridge running; approval prompts depend on the client supporting them; the audit log is evidence of edits, not protection from someone with the same file access. I have tested it on my own account and setup, not with every Bridge version, OS or client, so expect rough edges. Try it on a test account first. Proton's own features (filters, auto-reply) may already cover what you need.

<repo URL>. Questions and bug reports welcome.

## r/ClaudeAI

**Title:** I built an MCP server for Proton Mail (via Bridge) with read-only/drafts modes and an audit log

Unofficial, open source, MIT. It exposes Proton Mail to Claude Desktop (or any MCP client) through the local Bridge, and there is a CLI for scripts.

What I cared about was limiting what the model can do. `PROTONMAIL_MODE` can be `read-only`, `drafts`, `assisted` or `full`; `PROTONMAIL_APPROVAL=elicit|require` can ask you, not the model, before a send or delete. Mail text is treated as untrusted and the server tells the client not to follow instructions inside messages, but that reduces the prompt-injection risk, it does not remove it. Changes go into a hash-chained audit log you can check with `verify_audit_log`.

Caveats: the server's own default (variable unset) is `full`, though a new setup-wizard install starts in `drafts`; the mail Claude reads is sent to Anthropic like any other conversation content; elicitation depends on the client (only `require` fails closed); I have not tested every client or setup. Try it on a test account first.

<repo URL>

## Show HN

**Title:** Show HN: Proton Mail for AI assistants through Bridge, with read-only and drafts modes

I built an unofficial MCP server and CLI for Proton Mail. It connects to the local Proton Bridge (IMAP/SMTP on 127.0.0.1), so there is no OAuth grant to a third party and no cloud relay. The search index and audit log are on your disk.

The part I spent most time on is limits: `PROTONMAIL_MODE` presets (`read-only`, `drafts`, `assisted`, `full`), optional approval through the client, and a hash-chained audit log. Other flags can tighten a mode but never loosen it. A threat model document says what is not covered.

Honest limits: the server's default with no setting is `full` (the setup wizard starts new installs in `drafts`), so check which mode you run. Whatever the model reads is sent to the model provider unless you run a local model. The audit log is tamper-evident, not tamper-proof against someone who can write both log files. Prompt-injection defences are mitigations. It needs Bridge running, and I have only tested it on my own setups, so other Bridge versions, operating systems and clients may break.

<repo URL>. I would like to hear where the safety model is wrong or unclear.

## Lumo Desktop thread (SKETCH: use only after verifying in Lumo)

Not for posting yet. Lumo Desktop was not installed when this was written, so nothing here was tried in it. Before using any of it, follow the checklist at the end of [lumo-desktop.md](lumo-desktop.md) and keep only what you saw work. What Proton states publicly (https://proton.me/support/lumo-connectors, https://proton.me/blog/lumo-desktop-features): Lumo Desktop has Connectors, including Proton Mail through Bridge and your own local (stdio) or remote MCP servers; every action defaults to Auto-approve and can be set to Ask human or Deny.

**r/ProtonMail, comment or short post (do not argue with Proton's own connector):**
Proton's Lumo Desktop now has a Proton Mail through Bridge connector, and it takes custom MCP servers too. If you want mode presets (`read-only`, `drafts`), an audit log or the same server in several clients, this unofficial server can be added as a custom connector; steps in `docs/lumo-desktop.md`. Please set `PROTONMAIL_MODE` first: Lumo's actions start at Auto-approve and this server's own default is `full`. [After verifying: say what worked and what did not in Lumo.] If the native connector is enough for you, use that.

**Show HN or r/ClaudeAI, one extra line at most:**
Works as a custom stdio MCP server in other clients too, for example Lumo Desktop [only after verifying].

Do not claim: that Lumo supports MCP approval prompts (elicitation), that the tool list loads cleanly, or anything about the native connector's tools beyond what Proton's pages say.
