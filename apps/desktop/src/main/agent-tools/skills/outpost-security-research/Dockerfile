FROM node:24-bookworm
ARG CODEX_VERSION=0.159.2
ARG SOURCE_COMMIT=unknown
COPY pwragent.tgz /tmp/pwragent.tgz
RUN npm install --prefix /opt/outpost-tools --omit=dev --no-fund \
      /tmp/pwragent.tgz @openai/codex@${CODEX_VERSION} \
    && rm /tmp/pwragent.tgz \
    && corepack enable pnpm
LABEL ai.pwragent.source-commit=${SOURCE_COMMIT} ai.pwragent.codex-version=${CODEX_VERSION}
USER 501:20
ENV HOME=/home/outpost/home PWRAGENT_HOME=/home/outpost/state PWRAGENT_PROFILE=docker
WORKDIR /home/outpost/workspace
ENTRYPOINT ["/opt/outpost-tools/node_modules/.bin/pwragent"]
CMD ["serve", "--workspace", "/home/outpost/workspace", "--codex-home", "/home/outpost/codex", "--codex-bin", "/opt/outpost-tools/node_modules/.bin/codex"]
