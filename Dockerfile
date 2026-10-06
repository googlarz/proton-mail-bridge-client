FROM node:24-slim

WORKDIR /app

COPY package*.json ./
# --ignore-scripts skips package.json's own "prepare" (npm run build), which
# would fail here anyway since src/ isn't copied in yet. better-sqlite3 13 ships
# prebuilt binaries for linux x64/arm64 (glibc and musl) and has no install
# script, so the explicit rebuild is only a safety net, as in
# install-claude-desktop.ts's installRuntimeDependencies.
# src/ must stay out of .dockerignore: the build below compiles it.
RUN npm ci --ignore-scripts && npm rebuild better-sqlite3

COPY . .
RUN npm run build
RUN npm prune --omit=dev

CMD ["node", "dist/index.js"]
