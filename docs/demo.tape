# VHS tape (https://github.com/charmbracelet/vhs) for the CLI part of docs/demo-script.md.
# Render: vhs docs/demo.tape      (writes docs/demo.gif; nothing is committed or published)
#
# Needs Proton Bridge running and signed in, the CLI installed
# (npm install -g proton-mail-bridge-client) and PROTONMAIL_USERNAME /
# PROTONMAIL_PASSWORD set in the shell that runs vhs. Use a test account.
# Nothing here sends mail or writes to the mailbox: the one `send` is refused
# by drafts mode before it reaches Bridge. The audit-log steps only read.

Output docs/demo.gif

Set Shell "bash"
Set FontSize 18
Set Width 1200
Set Height 700
Set TypingSpeed 40ms
Set Padding 20

# Hide setup so the viewer sees clean commands.
Hide
Type "export PROTONMAIL_MODE=drafts" Enter
Type "clear" Enter
Show

# 1. Connection check (read-only).
Type "proton-mail-bridge-client doctor" Enter
Sleep 4s

# 2. Read the inbox (read-only).
Type "proton-mail-bridge-client emails --folder INBOX --limit 5" Enter
Sleep 4s

# 3. Try to send while in drafts mode: refused by the server's policy.
Type "proton-mail-bridge-client send --to you@example.com --subject Test --body Hi" Enter
Sleep 4s

# 4. The policy in force.
Type "proton-mail-bridge-client runtime-status" Enter
Sleep 4s

# 5. Audit log: recent entries, then check the hash chain.
Type "proton-mail-bridge-client get-audit-logs" Enter
Sleep 4s
Type "proton-mail-bridge-client verify-audit-log" Enter
Sleep 5s
