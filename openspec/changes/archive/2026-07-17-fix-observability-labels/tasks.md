## 1. A-35 — Register the per-signal OTLP traces endpoint

- [x] 1.1 Add `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z.string().url().optional()` to the observability config schema + raw type (boot-validated); add it to the `docker-compose.yml` app env pass-through.

## 2. A-37 — Split upstream duration by outcome

- [x] 2.1 Add `outcome` to `upstreamDuration`'s `labelNames` and pass it in `recordUpstream`'s `observe`.
- [x] 2.2 `proxy-metrics.spec.ts`: the upstream bucket assertion carries `outcome="success"`; a new case asserts `success` and `canceled` form distinct `_count` series.

## 3. A-36 — Document the provider-name label trade-off

- [x] 3.1 Note in the observability spec that the `provider` label is the display name by design (legibility over rename-stability); no code change.

## 4. Wrap-up

- [x] 4.1 build/lint/typecheck green; `npm test -w packages/control-plane -- proxy-metrics` green.
- [x] 4.2 Changeset; update `TODOS.md` + mark A-35/A-36/A-37 ✅ in `FABLE_AUDIT.md` after archive.
