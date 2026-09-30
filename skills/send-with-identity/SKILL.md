---
name: send-with-identity
description: Use whenever sending, replying to, forwarding, scheduling, or drafting an email through the proton-mail-bridge MCP tools on a setup with more than one account or a signature. Forces the question "from which address, and with which signature" before anything goes out.
---

# Send with a chosen address and signature

A mail must never go out from a guessed address or with a guessed signature. This skill adds the rule the server cannot enforce by itself: ask first.

## Rule

Before ANY send, reply, forward or schedule (and before creating a draft that will be sent):

1. **Ask which address to send from**, unless the user already named it in this request. List the configured accounts (`list_accounts`). For a reply or forward, suggest the account the original message arrived in (an emailId prefixed `<slug>::` belongs to that account; a plain id is the primary) and let the user confirm.
2. **Ask which signature to use**: the one saved for that address below, or none. If none is saved for it, say so and ask whether to send without one.
3. Pass the choice explicitly:
   - `from: "<address>"` on the tool call (send_email, reply_to_email, reply_all_email, forward_email, create_draft; without it, a reply or forward goes out from the account the original message arrived in).
   - Write the signature into the body yourself and set `appendSignature: false`, so the server's global `PROTONMAIL_SIGNATURE` (if set) is not added on top and the signature does not appear twice.
4. The user's explicit "yes" on the final recipients, subject and body is still required. Choosing an address or signature is not that approval.

Do not skip the questions because a choice "looks obvious" or because the user used an address earlier in the session.

## Addresses and signatures

Fill in your own. Keep this file out of any public repo once it holds real addresses or signatures.

| Address | Account slug | Signature |
|---|---|---|
| you@proton.me | (from `list_accounts`) | none |
| you@yourcompany.com | (from `list_accounts`) | see below |

### you@yourcompany.com

Paste the signature HTML here, or keep it in a file next to this one (e.g. `assets/signature.html`) and reference it. Put a logo in as an inline attachment, not a `data:` URI: reference `<img src="cid:logo">` and send `attachments: [{ filename: "logo.png", content: <base64>, contentType: "image/png", cid: "logo", contentDisposition: "inline" }]`. Gmail and Outlook drop `data:` images (the server's sanitizer does accept them up to 512 KB, but recipients' clients may not show them). Inline `style` attributes on a short allowlist survive, remote images are removed, and links must be http/https/mailto (a `tel:` link is stripped, so write the phone as plain text).

Use `none` for an address without a signature so the question is not repeated with a stale suggestion.

## Install

Copy this folder to `~/.claude/skills/send-with-identity` (Claude Code), or add it to your project's `.claude/skills/`.
