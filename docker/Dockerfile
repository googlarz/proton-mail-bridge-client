# The published npm package in a small image, for running the MCP server or the CLI on a machine without a desktop
# (a server next to a headless Bridge). It talks to Bridge over IMAP/SMTP, so the container must be able to reach
# Bridge's ports: share Bridge's network namespace (--network container:<bridge>) or use --network host.
#
#   docker build -f docker/Dockerfile --build-arg VERSION=2.13.0 -t proton-mail-bridge-client .
#   docker run -i --rm --network host -e PROTONMAIL_USERNAME=... -e PROTONMAIL_PASSWORD_FILE=/run/secrets/bridge \
#     -v bridge-client-data:/data proton-mail-bridge-client
#
# `docker run -i` speaks MCP over stdio. The CLI is in the same image:
#   docker run --rm --network host -e ... --entrypoint proton-mail-bridge-client proton-mail-bridge-client doctor
FROM node:24-slim
ARG VERSION
RUN test -n "$VERSION" || (echo "pass --build-arg VERSION=x.y.z" && exit 1) \
 && npm install -g "proton-mail-bridge-client@${VERSION}" --omit=dev --no-audit --no-fund \
 && npm cache clean --force
ENV PROTONMAIL_DATA_DIR=/data
RUN mkdir /data && chown node:node /data
USER node
VOLUME ["/data"]
ENTRYPOINT ["proton-mail-bridge-mcp"]
