# Launch post drafts

Drafts only; nothing has been posted. Edit before use and check each claim against the README at the time you post. Replace `<repo URL>` with the GitHub link.

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
