# Releasing

1. Update `CHANGELOG.md`, then bump the version with `npm version <patch|minor|major>`. The `version` script (`scripts/sync-versions.mjs`) stamps `mcpb/manifest.json` and `server.json` and stages them, so they land in the version commit.
2. Run `npm test` (all green) and `npm run smoke:pack` if you changed packaging.
   - **Manual step, real Bridge, read-only.** CI has no Bridge, so this runs on a machine with Proton Bridge logged in. Build first (the script starts `dist/index.js`), then run:
     ```bash
     npm run build
     PROTONMAIL_USERNAME=... PROTONMAIL_PASSWORD=... [PROTONMAIL_ACCOUNTS_JSON=...] node test/live/readonly-smoke.mjs
     ```
     `PROTONMAIL_USERNAME` and `PROTONMAIL_PASSWORD` (the Bridge credentials) are required; the script exits with code 2 without them. `PROTONMAIL_ACCOUNTS_JSON` is optional, for multi-account setups. Expect every check to print `PASS` and a final `N/N checks passed`.
     The script starts the server with `PROTONMAIL_READ_ONLY=true` and a throwaway `PROTONMAIL_DATA_DIR`, and calls read tools only. Its output holds counts and timings, never subjects, addresses or bodies. Anything that sends mail or writes to the mailbox (sends, drafts, moves, flags, deletes) is outside this step and needs the owner's separate, explicit consent.
3. Push the commit and the `v<version>` tag, then publish to npm (`publish.yml`, or `npm publish` by hand).
4. Publish a GitHub release for the tag. That triggers `mcpb-release.yml`, which builds the `.mcpb` bundles (darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64) and attaches them.
5. Update the Homebrew formula once the npm tarball is live:
   ```bash
   node scripts/homebrew-formula.mjs <version> --write homebrew/proton-mail-bridge-client.rb
   ```
   Commit that file here, then copy it to `Formula/proton-mail-bridge-client.rb` in `googlarz/homebrew-tap` and push the tap. The script downloads the published tarball and computes the sha256 itself; never paste an npm `shasum` (40 characters) in its place.
