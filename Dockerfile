# polyrouter production image (#22, spec §13): one container serving the SPA,
# the dashboard API, and the inference proxy on one port. Multi-stage: the
# build stage compiles the workspace and prunes dev deps; the runtime stage
# preserves the monorepo layout (/app/packages/...) so the SPA dist lookup and
# the bundled Drizzle migrations resolve unchanged.
#
# Two publishable targets share ONE build stage (add-semantic-dashboard 4.1):
#   * `runtime`          — the BASELINE (default target). musl/alpine, ORT- and
#                          model-free. `docker build .` builds exactly this; the
#                          image-inspection neutrality assertion is its gate.
#   * `runtime-semantic` — the batteries-included `-semantic` variant, built with
#                          `--target runtime-semantic`. glibc base (ORT prebuilts
#                          are glibc-only), the exact-pinned onnxruntime-node, and
#                          the reference embedding model baked in at BUILD time.
# The baseline never sees the semantic stage: it is not a dependency of `runtime`,
# so a default build skips it entirely and stays byte-for-byte the previous image.

ARG ONNXRUNTIME_NODE_VERSION=1.27.0
# glibc base for the semantic variant — onnxruntime-node's prebuilt binaries do
# not run on musl (Alpine); Debian slim keeps it lean while giving glibc.
ARG SEMANTIC_BASE_IMAGE=node:24-bookworm-slim

# ---- build ----
FROM node:24-alpine AS build
WORKDIR /app
# add-semantic-embedder: the ORT devDependency (tests only; pruned from the
# runtime stage) must never fetch CUDA blobs during image builds.
ENV ONNXRUNTIME_NODE_INSTALL=skip

# Manifests first: the npm ci layer caches until a lockfile/manifest changes.
COPY package.json package-lock.json turbo.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/data-plane/package.json packages/data-plane/
COPY packages/control-plane/package.json packages/control-plane/
COPY packages/frontend/package.json packages/frontend/
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime-semantic (the -semantic variant; built via --target) ----
# Defined BEFORE the default `runtime` stage so it is never on the baseline's
# dependency path. glibc base + the exact-pinned ORT + the pre-baked reference
# model, with SEMANTIC_MODEL_PATH preset so L2 is available on first boot.
FROM ${SEMANTIC_BASE_IMAGE} AS runtime-semantic
ARG ONNXRUNTIME_NODE_VERSION
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/data-plane/package.json packages/data-plane/package.json
COPY --from=build /app/packages/data-plane/dist packages/data-plane/dist
COPY --from=build /app/packages/control-plane/package.json packages/control-plane/package.json
COPY --from=build /app/packages/control-plane/dist packages/control-plane/dist
COPY --from=build /app/packages/frontend/package.json packages/frontend/package.json
COPY --from=build /app/packages/frontend/dist packages/frontend/dist

# Install the exact-pinned optional peer (CUDA postinstall disabled — CPU
# prebuilts ship in the tarball) and bake the reference model, both at BUILD
# time. curl is fetched only for the bake and purged; no runtime network reach.
COPY scripts/bake-semantic-model.sh ./scripts/bake-semantic-model.sh
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && export ONNXRUNTIME_NODE_INSTALL=skip \
 && npm install --no-save --omit=dev "onnxruntime-node@${ONNXRUNTIME_NODE_VERSION}" \
 && sh scripts/bake-semantic-model.sh /app/models/reference \
 && rm scripts/bake-semantic-model.sh \
 && apt-get purge -y --auto-remove curl \
 && rm -rf /var/lib/apt/lists/* \
 && chown -R node:node /app/models

# The baked bundle is the default; an operator-mounted path simply overrides it.
ENV SEMANTIC_MODEL_PATH=/app/models/reference

USER node
EXPOSE 3001

# Node-based probe: the glibc slim base ships neither wget nor curl at runtime.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 \
  CMD node -e "require('http').get('http://127.0.0.1:3001/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "packages/control-plane/dist/main.js"]

# ---- runtime (BASELINE — the default target; keep last & unchanged) ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/data-plane/package.json packages/data-plane/package.json
COPY --from=build /app/packages/data-plane/dist packages/data-plane/dist
COPY --from=build /app/packages/control-plane/package.json packages/control-plane/package.json
COPY --from=build /app/packages/control-plane/dist packages/control-plane/dist
COPY --from=build /app/packages/frontend/package.json packages/frontend/package.json
COPY --from=build /app/packages/frontend/dist packages/frontend/dist

USER node
EXPOSE 3001

# /api/health is the REAL health route — the SPA fallback answers bare /health
# with 200 HTML, which must never satisfy a probe.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3001/api/health || exit 1

# Exec form: Node is PID 1 and receives SIGTERM directly, so Nest's shutdown
# hooks run — the #12 stream drain, #11 writer flush, and #21 span flush.
CMD ["node", "packages/control-plane/dist/main.js"]
