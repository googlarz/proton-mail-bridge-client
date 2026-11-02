# Headless Bridge plus this server in Docker (home server / NAS)

**Status: untested end to end.** This recipe was written without a real Proton Bridge. What was and was not checked is listed at the bottom. Treat it as a starting point and report what breaks.

## What you get

Two containers on a private Docker network: Proton Mail Bridge without a GUI, and this MCP server. Nothing is published on the host. An MCP client on the same machine starts the server on demand.

## Read this first

- **The server speaks MCP over stdio only.** It has no HTTP or network transport. A client reaches it by starting a process whose stdin and stdout are the MCP stream, here `docker compose run -i ...` (or `docker exec -i`). A client on another computer needs something that carries stdio over the network, for example `ssh nas docker compose ... run -i ...` as the client's command. Nothing in this repo provides that for you.
- **Proton publishes no official Bridge container image.** The compose file uses the community image `shenxn/protonmail-bridge`, which is not made or reviewed by Proton or by this project. Read its repository before trusting it with your mailbox. Alternatives: install Bridge's Linux package yourself on the host or in your own image.
- **Signing in to Bridge is a one-time, interactive step** (your Proton password, and 2FA if enabled). It cannot be scripted away.
- The password this server needs is the **Bridge password** printed by `info`, not your Proton account password.

## Steps

1. Copy `docker/docker-compose.example.yml` somewhere, edit `PROTONMAIL_USERNAME` (your Proton address), and pin the image tags.
2. One-time sign-in of Bridge, using the community image's init step:

   ```bash
   docker compose -f docker-compose.example.yml run --rm bridge init
   ```

   At the Bridge prompt: `login` (follow the questions: Proton username, password, 2FA code), then `info` to show the Bridge username and **Bridge password**, then `exit`. Proton's own guide only documents starting the CLI (`protonmail-bridge -c`, long form `--cli`, on Linux) and says `help` lists the current commands; `login` and `info` come from the community image's README, so confirm with `help`. The `init` step starts Bridge in that CLI mode for you. Credentials stay in the named volume `bridge-data`.
3. Put the Bridge password from `info` into a file, readable only by you:

   ```bash
   mkdir -p secrets && umask 077 && printf '%s' 'BRIDGE-PASSWORD-FROM-INFO' > secrets/bridge_password.txt
   ```

4. Start Bridge: `docker compose -f docker-compose.example.yml up -d bridge`.
5. Check the connection (reads nothing from your mail beyond folder names; run it before connecting a client):

   ```bash
   docker compose -f docker-compose.example.yml run --rm --no-deps --entrypoint proton-mail-bridge-client mcp doctor
   ```

6. Point your MCP client at the server. The command is `docker`, the arguments:

   ```
   compose -f /absolute/path/docker-compose.example.yml run -i --rm --no-deps -T mcp
   ```

   (In a client's JSON config that is `"command": "docker"` and the words above as `"args"`.) Do not let Compose print anything else to stdout; `-T` and `--no-deps` keep it quiet. If your client misbehaves, the plain form `docker run -i --rm --network <compose network> ...` from the README Docker section is the fallback.

## Why the compose file looks the way it does

- **No `ports:` at all.** The server reaches Bridge as `bridge:143` (IMAP) and `bridge:25` (SMTP) over the private compose network. Those are the community image's internal ports, which it relays to Bridge's own 1143 and 1025. If you also want a desktop mail client on the host, uncomment the loopback-only mapping (`127.0.0.1:...`) in the file; never publish them on all interfaces, because anyone who reaches those ports and knows the Bridge password can read and send your mail.
- **TLS by host name (issue #56).** Bridge's certificate is self-signed for `localhost`, so connecting to `bridge` fails verification. The repo offers two settings: `PROTONMAIL_TLS_INSECURE_HOSTS=bridge` (not verified; the example's default because it needs no extra step, acceptable on a private network you control) and `PROTONMAIL_TLS_CA_FILE` (a PEM file with Bridge's exported certificate; preferred, shown commented out). Use one of them.
- **`PROTONMAIL_MODE=drafts`.** Claude can read, search and prepare drafts; nothing is sent or deleted until you change the mode. See the README for the other modes.
- **`mcp-data` volume** holds the local index (`/data`, set by the image).
- The `mcp` service is in the `client` profile so `up` does not start a server that nobody is talking to.

## What was validated, and what was not

Validated:
- `docker compose -f docker/docker-compose.example.yml --profile client config -q` parses (Docker Compose v5.6.0, on the author's machine).
- The environment variable names used (`PROTONMAIL_IMAP_HOST`, `_IMAP_PORT`, `_IMAP_SECURE`, `_SMTP_HOST`, `_SMTP_PORT`, `PROTONMAIL_TLS_INSECURE_HOSTS`, `PROTONMAIL_TLS_CA_FILE`, `PROTONMAIL_PASSWORD_FILE`, `PROTONMAIL_MODE`) exist in the source and README.
- Per the README, the image itself was tested by another person against a real Bridge using a shared network namespace and a host-name connection with the TLS settings above.

**Not validated (no real Bridge, nothing was run):**
- That the community `bridge` image starts, accepts `init`, `login` and `info` as described, and keeps its sign-in in the volume across restarts.
- That the internal ports 143 and 25 and the STARTTLS settings (`IMAP_SECURE=false`, SMTP on 25) work from the `mcp` container.
- That `docker compose run -i` keeps stdout clean enough for every MCP client.
- Pulling the published image tags, the `doctor` command inside Compose, and the secret file mount.
- Anything about a client on a different machine.

## Sources

- Proton, "Bridge command line interface (CLI) guide": https://proton.me/support/bridge-cli-guide (launch command `protonmail-bridge -c` on Linux; `help` lists commands).
- Proton Bridge repository README: https://github.com/ProtonMail/proton-bridge (needs a keychain on Linux, GNOME Keyring or `pass`; config in `~/.config/protonmail/bridge-v3`).
- Community image README (init, `login`, `info`, ports 25 and 143, loopback binding advice): https://github.com/shenxn/protonmail-bridge-docker
- This repo: README "Running in Docker (headless machines)", issue #56 (TLS by host name).
