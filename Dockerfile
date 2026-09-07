FROM node:20-slim

WORKDIR /app

COPY package*.json ./
# --ignore-scripts skips package.json's own "prepare" (npm run build), which
# would fail here anyway since src/ isn't copied in yet — but it also skips
# better-sqlite3's install script, the one that actually builds its native
# binding. Left unfixed, the container has no working sqlite3 binding at all
# and crashes as soon as anything touches the local index (LocalIndexService
# is instantiated unconditionally at startup). Same fix already used in
# install-claude-desktop.ts's installRuntimeDependencies for the identical
# problem: rebuild just this one native package explicitly.
RUN npm ci --ignore-scripts && npm rebuild better-sqlite3

COPY . .
RUN npm run build
RUN npm prune --omit=dev

CMD ["node", "dist/index.js"]
