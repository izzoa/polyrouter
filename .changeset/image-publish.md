---
'@polyrouter/control-plane': minor
---

Publish the production Docker image from CI. A new `release-image.yml` workflow builds the single-container image on every `v*.*.*` tag and pushes it to GHCR (`ghcr.io/izzoa/polyrouter`) for both `linux/amd64` and `linux/arm64`, tagged `X.Y.Z`, `X.Y`, and `latest` — authenticated with the workflow-scoped `GITHUB_TOKEN`, no standing registry secrets. Releases stay human-gated (tags only; ordinary branch pushes never publish; a manual dispatch publishes an explicit `sha-…` tag). Self-hosters can now set `POLYROUTER_IMAGE=ghcr.io/izzoa/polyrouter:latest` and skip local builds, upgrading with `docker compose pull` — the compose override existed but nothing published to it until now.
