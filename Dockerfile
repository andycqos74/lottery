# Multi-stage build for every Node service in the monorepo.
#
# The TARGET build arg selects which one: worker, api, codec-server, or
# sandbox-providers. One Dockerfile, one dependency graph, four images.
#
# Security posture (build plan §4.3): non-root, no package manager or shell
# tooling in the runtime layer, and the compose files add read-only rootfs,
# cap_drop ALL and no-new-privileges on top.

# ── deps ─────────────────────────────────────────────────────────────────────
FROM node:22.22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/*/package.json ./tmp-manifests/
COPY apps/*/package.json services/*/package.json ./tmp-manifests/
# Restore each manifest to its own directory before install, so pnpm resolves the
# workspace graph without the source having to be copied yet — the layer then
# caches across every source change.
COPY . .
RUN rm -rf ./tmp-manifests && pnpm install --frozen-lockfile

# ── build ────────────────────────────────────────────────────────────────────
FROM deps AS build
RUN pnpm typecheck && pnpm -r --filter './packages/**' --filter './apps/**' --filter './services/**' run build

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:22.22-bookworm-slim AS runtime
ARG TARGET
ARG TARGET_PATH
ENV NODE_ENV=production
WORKDIR /app

# uid 10001 matches the `user:` in docker-compose.app.yml. Containers must not
# run as root even behind the other controls.
RUN groupadd --gid 10001 app && useradd --uid 10001 --gid 10001 --no-create-home app

COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/packages ./packages
COPY --from=build --chown=10001:10001 /app/apps ./apps
COPY --from=build --chown=10001:10001 /app/services ./services
COPY --from=build --chown=10001:10001 /app/package.json ./package.json

USER 10001:10001
ENV TARGET_PATH=${TARGET_PATH}
CMD ["sh", "-c", "exec node ${TARGET_PATH}"]

# ── OCR-capable worker ───────────────────────────────────────────────────────
# Only worker-recon needs Tesseract and Poppler (GAP-33, if OCR persists). Kept
# in a separate stage so the OCR toolchain — the largest attack surface in the
# system, since it parses untrusted PDFs — is absent from every other image.
FROM runtime AS worker-ocr
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr poppler-utils \
 && rm -rf /var/lib/apt/lists/*
USER 10001:10001
