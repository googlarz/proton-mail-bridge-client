# Releasing

1. Update `CHANGELOG.md`, then bump the version with `npm version <patch|minor|major>`. The `version` script (`scripts/sync-versions.mjs`) stamps `mcpb/manifest.json` and `server.json` and stages them, so they land in the version commit.
2. Run `npm test` (all green) and `npm run smoke:pack` if you changed packaging.
3. Push the commit and the `v<version>` tag, then publish to npm (`publish.yml`, or `npm publish` by hand).
4. Publish a GitHub release for the tag. That triggers `mcpb-release.yml`, which builds the `.mcpb` bundles (darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64) and attaches them.
5. Update the Homebrew formula once the npm tarball is live:
   ```bash
   node scripts/homebrew-formula.mjs <version> --write homebrew/proton-mail-bridge-client.rb
   ```
   Commit that file here, then copy it to `Formula/proton-mail-bridge-client.rb` in `googlarz/homebrew-tap` and push the tap. The script downloads the published tarball and computes the sha256 itself; never paste an npm `shasum` (40 characters) in its place.
