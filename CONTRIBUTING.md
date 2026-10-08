# Contributing to proton-mail-bridge-client

Local-first Proton Mail MCP server and CLI. Contributions welcome.

## Before you start

- Check [open issues](https://github.com/googlarz/proton-mail-bridge-client/issues) and [discussions](https://github.com/googlarz/proton-mail-bridge-client/discussions) — your idea may already be tracked
- For non-trivial changes, open an issue first to align on approach

## Setup

```bash
git clone https://github.com/googlarz/proton-mail-bridge-client.git
cd proton-mail-bridge-client
npm install
```

Requires Proton Bridge running locally. See README for credential setup before building.

## Development

```bash
npm run build      # compile TypeScript
npm test           # run tests
npm run test:coverage   # the same tests with Node's built-in coverage report (about 79% of lines at 2.7.2)
```

## What to contribute

- Bug fixes — especially around Bridge connection handling or credential config
- README improvements — setup docs are the most-requested area (see open issues)
- New MCP tools — check `src/` for existing tool patterns
- Test coverage

## Submitting a PR

1. Fork → branch from `main`
2. Keep changes focused — one fix or feature per PR
3. Update README if you change setup steps or add a tool
4. Open the PR with a short description of what and why

## Code style

TypeScript strict mode. Match the existing patterns in `src/`. Run `npm run build` before pushing — PRs must compile clean.
