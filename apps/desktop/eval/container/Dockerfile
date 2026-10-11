# Build natively for the task architecture. On Apple Silicon prefer linux/arm64;
# linux/amd64 explicitly uses Docker's emulation and is a different runtime.
FROM node:24-bookworm-slim AS node
FROM ubuntu:24.04
COPY --from=node /usr/local /usr/local
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git python3 make g++ pkg-config libsecret-1-dev \
    libgtk-3-0t64 libnss3 libgbm1 libasound2t64 libxss1 libxshmfence1 \
    xvfb xauth dbus-x11 unzip tini sudo \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/pwragent
COPY . .
RUN corepack enable pnpm && pnpm install --frozen-lockfile \
    && node apps/desktop/scripts/ensure-electron-runtime.mjs \
    && pnpm --filter @pwragent/desktop build \
    && node scripts/linux-sandbox.mjs --fix
# Ubuntu's default uid 1000 user is sufficient; no host HOME is inherited.
RUN mkdir -p /eval/output /eval/profile /eval/codex /app \
    && chown -R 1000:1000 /eval /app
USER 1000:1000
ENV HOME=/eval/profile/home
ENTRYPOINT ["/usr/bin/tini", "--", "xvfb-run", "-a", "node", "/opt/pwragent/apps/desktop/eval/run-headless.mjs"]
CMD ["--input", "/eval/input.json", "--output", "/eval/output"]
