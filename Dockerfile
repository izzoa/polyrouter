# polyrouter production image (#22, spec §13): one container serving the SPA,
# the dashboard API, and the inference proxy on one port. Multi-stage: the
# build stage compiles the workspace and prunes dev deps; the runtime stage
# preserves the monorepo layout (/app/packages/...) so the SPA dist lookup and
# the bundled Drizzle migrations resolve unchanged.

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

# ---- runtime ----
FROM node:24-alpine
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
