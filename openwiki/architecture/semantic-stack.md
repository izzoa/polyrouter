---
type: Architecture
title: Semantic Stack
description: The optional Layer-2 semantic stack — local ONNX embedder, v1 model-bundle contract, three-band cosine classifier, per-tenant learned centroids with bounded evidence accumulation, and the L1→L2→L3 decision trail.
tags: [semantic, layer-2, embedder, onnx, classifier, learning, cosine, anchors]
resource: packages/control-plane/src/semantic/
---

# Semantic Stack

The semantic stack is the **optional Layer 2** of polyrouter's auto-routing pipeline. It is **never in the baseline build/image**: it activates only when both `SEMANTIC_MODEL_PATH` points at a valid model bundle AND the `semantic` token is present in `ROUTING_AUTO_LAYERS`. The baseline image is CI-asserted to ship no `onnxruntime-node` and no model files. A batteries-included `-semantic` image variant ships beside the baseline for zero-setup adoption.

Layer 2 refines **only the L1-ambiguous slice** of `auto` requests. It never re-evaluates a confident Layer-1 band. Every L2 fault degrades to exactly today's L1-ambiguous flow — the smart path never fails or stalls a request, and never fabricates telemetry.

This page is the deep reference for how Layer 2 works, why it is shaped the way it is, and where to look when something goes wrong. For the bigger picture see [Architecture Overview](/openwiki/architecture/overview.md). For the request lifecycle see [Request Flow](/openwiki/architecture/request-flow.md). For the dashboard surfaces see [Dashboard](/openwiki/dashboard/overview.md).

## Why It Exists

Layer 1 (structural) is fast and language-neutral but sees only cheap features (request size, tool count, response format, etc.). Many real requests are ambiguous on those features alone — a "summarize this PDF" and a "write a Python sort" look similar until you look at the text. Layer 2 embeds the request text locally with a small sentence-transformer model and runs a three-band cosine classifier against curated anchor centroids:

- **high band** — reasoning-heavy prompts (proofs, designs, debugging, formal analyses)
- **low band** — quick prompts (small talk, format conversions, lookups, rewrites)
- **ambiguous** — fallback to cascade / default

The classifier runs in **~5–20 ms** per request on a CPU, scoped to the L1-ambiguous slice only, and is bounded so saturation degrades gracefully rather than queueing.

## Component Map

```
                  ┌─────────────────────────────────────────────┐
                  │         packages/data-plane/src/semantic/   │
                  │   anchors.ts ── extract.ts ── classify.ts   │
                  │   embedder.ts (Embedder interface + stub)   │
                  │   learning.ts (pure: fold/clamp/cosine)     │
                  └────────────────────┬────────────────────────┘
                                       │  consumed by
                  ┌────────────────────▼────────────────────────┐
                  │      packages/control-plane/src/semantic/   │
                  │   semantic.config.ts (Zod schema + builder)│
                  │   semantic.module.ts (DI rebinding)         │
                  │   semantic-runtime.service.ts (ONNX load)   │
                  │   semantic-classifier.service.ts (centroids)│
                  │   semantic-router.ts (Layer 2 verdict)     │
                  │   bundle.ts (manifest + WordPiece + hashId)│
                  │   onnx-loader.ts (real loader, fail-fast)   │
                  │   embed-core.ts (bounded pipeline)          │
                  │   semaphore.ts (try-acquire/no-queue)       │
                  │   evidence-accumulator.ts (hot-path cohort) │
                  │   learning-store.ts (Redis Lua primitives)  │
                  │   learning.run.ts (sweep occurrence)       │
                  │   learning.scheduler.ts (BullMQ, daily)    │
                  │   learned-classification-source.ts (decorator)│
                  │   classification-source.ts (seam + gate)    │
                  │   semantic-learning.{service,controller}    │
                  │   learning-evidence / -format / -lua / -revision│
                  └────────────────────┬────────────────────────┘
                                       │  observed by
                  ┌────────────────────▼────────────────────────┐
                  │  proxy.service.ts: effectiveAutoLayers,    │
                  │  resolvePlan (L1→L2→cascade), recorder     │
                  │  hands semanticVerdict + learningEvidence  │
                  └─────────────────────────────────────────────┘
```

## Activation and Capability Reporting

The stack is **flag-gated**. The two required preconditions are both boot-time conditions:

1. `SEMANTIC_MODEL_PATH` must be set to a directory containing a valid `manifest.json`, the declared vocab file, and the model file (the "bundle").
2. `ROUTING_AUTO_LAYERS` must include `semantic` (alone or with `structural` and/or `cascade`; `semantic` implies `structural` automatically at boot, mirroring `cascade`'s relationship).

When the embedder is loaded, `SemanticClassifierService.available` reflects the **whole classifier** being ready (embedder loaded + bundled centroids built + validated). The instance capability reported by `autoLayerCapability(cfg, classifierReady)` is `semantic = cfg.autoLayers.has('semantic') && classifierReady`. A broken bundle (manifest schema violation, dims mismatch, non-cancelling anchors) leaves the classifier **unavailable with a loud error** — NOT a boot crash — and the capability honestly reports `semantic = false`. Every other routing is unaffected.

Capability propagates to tenants via the existing `/api/routing/auto-layers` endpoint (`semanticAvailable` field in `AutoLayersView`). The dashboard's L2 toggle is bound to this: when `semanticAvailable === false`, the toggle is rendered as honest "off instance-wide" copy naming `SEMANTIC_MODEL_PATH`, never a dead control.

Tenants opt in per-account with `PUT /api/routing/auto-layers { semantic: true }`. The write is normalized (semantic implies structural) and stored on the existing `routing_settings` row.

## The v1 Model Bundle Contract

A bundle directory must contain `manifest.json` plus every file it declares. The v1 manifest schema is Zod-strict — anything undeclarable fails load with a named reason. A BYO model with a different tokenizer gets a loud error, never silently-wrong vectors.

```json
{
  "schemaVersion": 1,
  "tokenizer": {
    "type": "wordpiece",
    "vocabFile": "vocab.txt",
    "lowercase": true,
    "unkToken": "[UNK]",
    "clsToken": "[CLS]",
    "sepToken": "[SEP]",
    "padToken": "[PAD]",
    "maxTokens": 256
  },
  "model": {
    "file": "model.onnx",
    "inputNames": {
      "inputIds": "input_ids",
      "attentionMask": "attention_mask",
      "tokenTypeIds": "token_type_ids"
    },
    "outputName": "last_hidden_state",
    "outputKind": "token_embeddings",
    "dims": 384,
    "pooling": "mean",
    "normalize": true
  }
}
```

Key contract points (validated at boot):

- `schemaVersion` must be the literal `1`
- `tokenizer.type` must be `wordpiece` (BERT-family algorithm MiniLM/bge-small use)
- All declared file names are flat (`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`), must not equal `manifest.json`, and must not contain `..`
- `tokenizer.vocabFile` and `model.file` must differ
- `inputNames.inputIds`/`attentionMask`/`tokenTypeIds` must be distinct (one feed silently overwriting another is impossible by construction)
- `model.dims` is `[8, 4096]`; `tokenizer.maxTokens` is `[8, 512]`
- `model.pooling` is fixed to `mean` (the only supported pooling at v1)
- `model.normalize` is fixed to `true` (unit-norm vectors)

**Tokenizer implementation** (`bundle.ts::WordPieceTokenizer`): NFC normalization, optional lowercasing, whitespace + punctuation pre-tokenization (each punctuation character is its own word — the BERT `BasicTokenizer` rule), then greedy longest-match-first over the vocab with `##` continuation. An unmatchable word maps to the declared `unkToken`. Golden tests pin exact id sequences — any drift from this declared algorithm is a test failure, not a silent re-embedding of the space. Words longer than `MAX_WORD_CHARS = 100` map to `unk` wholesale (the conventional BERT guard).

**Content-derived revision** (`bundle.ts::contentHashId`): a versioned canonical SHA-256 — schema-version prefix, then the manifest, then every declared file sorted by relative path; each contribution is `relPath \0 byteLength \0 bytes`. Same bytes at a different mount path hash identically; any byte change anywhere changes the id. The revision is part of the classifier stamp so a bundle swap can never masquerade as the same embedding space.

## Bundled Anchor Set

The classifier's bundled centroids are seeded from a curated prompt set shipped in source (`packages/data-plane/src/semantic/anchors.ts`):

| Set | Size | Examples |
|-----|------|----------|
| `HIGH_ANCHORS` | 30 | "Prove that the sum of the reciprocals of the primes diverges, with full rigor." / "Design a multi-region active-active database architecture…" / "Explain quantum error correction with surface codes…" |
| `LOW_ANCHORS` | 30 | "What time zone is Tokyo in?" / "Convert 72 fahrenheit to celsius." / "Round 3.14159 to two decimals." |

The set is versioned (`ANCHOR_SET_ID = 'bundled-v1'`) and is part of the classifier revision stamp — any edit is a new revision, never a silent re-embedding of the space. The offline seeding run (AUC 1.0 on a disjoint eval split) is captured in `Plans/L2.md`.

## Embedder Runtime

### Lifecycle

`SemanticRuntimeService` is constructed cheaply during DI. Its `onApplicationBootstrap` hook performs the load:

1. Read the bundle once (`manifest.json` + declared files); both manifest and bytes are hashed.
2. Dynamic `import('onnxruntime-node')` — the optional peer, reached ONLY here, ONLY when `SEMANTIC_MODEL_PATH` is set. The baseline image has no ONNX at all, so dynamic import is a true module absence (fail-fast boot error if the path is set without the runtime).
3. Create an `InferenceSession` from the in-memory model bytes.
4. Run **one warmup inference** — the first ONNX call JITs the kernels. Requests never pay this latency.
5. Construct a bounded `Embedder` with a content-derived id (`sha256:<hex>`).

A **broken bundle fails boot loudly**: `SemanticLoadError` names the offending file's basename and reason, never the full supplied path (config-registry convention). An explicit opt-in never runs silently degraded.

### Bounded Embed Pipeline (`embed-core.ts`)

- **Deadline opens on entry** (before tokenization), so a tokenization hang counts against the budget.
- **Try-acquire / no-queue** admission via a `TrySemaphore` (`SEMANTIC_CONCURRENCY` permits); saturation → `EmbedError('saturated')` → caller skips.
- **Permit is released only when the raw inference settles**; late settlement is consumed (no leaks).
- **Timers and abort listeners always cleared** — even on error.
- **Output validated**: declared dims, all finite, unit-norm. Anything else → `EmbedError('invalid_output')`.

All `EmbedError` messages carry **timings/dimensions/reasons only** — never input text, never vector values.

### The Embedder Seam

```typescript
// packages/data-plane/src/semantic/embedder.ts
export interface Embedder {
  readonly id: string;     // content-derived revision
  readonly dims: number;
  embed(text: string, opts?: { signal?: AbortSignal }): Promise<Float32Array>;
}
```

The classifier only knows this interface. The control-plane wires the real ONNX runtime behind it; tests wire a deterministic SHA-256-seeded pseudo-vector stub (same text → same vector, distinct texts → distinct vectors, no model, no I/O, no timing variance).

## Classifier

`SemanticClassifierService` is a NestJS service implementing both `OnApplicationBootstrap` and `ClassificationSourceProvider`. Its bootstrap awaits `SemanticRuntimeService.whenReady()` (does not assume Nest ordered the hooks) and:

1. Builds **bundled centroids** by serializing each anchor through the SAME `extractSemanticInput` live requests use, embedding, and averaging per band — sequentially, so a `SEMANTIC_CONCURRENCY=1` no-queue embedder is not deterministically saturated by the bootstrap.
2. **Validates** with `validateCentroids`: unit norm within `1e-3` tolerance, non-cancelling (`cos(high, low) ≤ 0.999` — a near-identical anchor set would make every score ≈ 0, which is a broken classifier, never silent "everything ambiguous").
3. **Captures revision inputs** — embedder id, dims, anchor set id, anchor content hash, extractor version, threshold values — so a learned classification can be stamped with a distinct, generation-versioned provenance digest.
4. Computes the bundled revision with `computeRevision({...inputs, source: 'bundled', sourceRevision: ANCHOR_SET_ID})`.

`available` means the WHOLE classifier is ready (not merely a loaded embedder). A failed centroid build logs the error and leaves the classifier **unavailable with a loud error**; the capability honestly reports `semantic = false`; every other routing is unaffected.

## Canonical Text Extractor

`extractSemanticInput(ir, caps)` is the single text serializer Layer 2 embeds — `packages/data-plane/src/semantic/extract.ts`. The version (`SEMANTIC_EXTRACTOR_VERSION = 1`) is part of the classifier revision; any change is a new embedding space.

Properties:

- **Newest-first ordering**: the newest user turn leads and is granted the WHOLE `totalChars` budget (head-kept if it alone exceeds the cap). Prior non-system messages follow, newest-first, bounded by `perMessage`/`perBlock` caps.
- **System content is EXCLUDED entirely** — a request whose only non-empty content is system renders to `''` and the router skips.
- **Budget-aware and bounded**: rendering stops the moment the total budget is spent, blocks and messages are traversed under hard caps (a 10 MB request never forces a full map/join).
- **Tool results** render with `[tool result] <truncated text>` markers; nested tool text is depth-1-recursive and bounded to 16 blocks.
- **Images** render as `[image]`; **tool_use** as `[tool call <name>]`.

Defaults: `perMessage=600`, `perBlock=400`, `maxMessages=8`, `maxBlocksPerMessage=32`. The `totalChars` cap is the embedder's `maxInputChars` so the embedder's char truncation is a no-op backstop.

## Three-Band Cosine Classifier

```typescript
// packages/data-plane/src/semantic/classify.ts
export type SemanticBand = 'high' | 'low' | 'ambiguous';

export function classifySemantic(
  vector: Float32Array,
  centroids: SemanticCentroids,    // { high, low }
  thresholds: SemanticThresholds,  // { high, low } — both positive
): SemanticClassification;         // { kind: 'band', band, score, simHigh, simLow }
                                  // | { kind: 'invalid', reason }
```

The score is `simHigh − simLow` ∈ `[−2, 2]`. Bands:

- `score ≥ thresholds.high` → `high`
- `score ≤ −thresholds.low` → `low`
- otherwise → `ambiguous`

Defaults: `high = low = 0.15` (spike-quantile derived; wide-ambiguous). Out-of-bounds values reject boot. Both thresholds must have at most 4 decimal places.

`invalid` is a discriminated return for dim mismatch, non-finite vector, zero-norm vector, non-finite similarity, or centroid dim mismatch — the caller maps it to the fault path (skip). It is **never a band**, **never telemetry**.

## Router

`SemanticRouter` mirrors the `StructuralRouter` contract. EVERY fault — not ready, embed timeout, caller cancellation, a degenerate `invalid` classification — degrades to `skip` (invariant 1: the smart path never fails or stalls a request, and never fabricates telemetry).

```typescript
type SemanticEvaluation =
  | { kind: 'route';       decision: RouteDecision; verdict: SemanticVerdict }
  | { kind: 'ambiguous';   verdict: SemanticVerdict; evidence: Float32Array } // vector rides Prepared ONLY
  | { kind: 'unroutable';  verdict: SemanticVerdict }                          // verdict stands, fall-through to Layer 0 default
  | { kind: 'skip' };                                                          // no verdict, no telemetry
```

The verdict carries `band`, `score`, `simHigh`, `simLow`, `source` (`bundled` or `learned`), `revision` (content-derived), and a `reason` string of **numbers only** (e.g. `semantic:low s=-0.1845 hi=0.3021 lo=0.4866 src=bundled`). No input text, no vector values.

The router consumes a `ClassificationSourceProvider` via the `CLASSIFICATION_SOURCE` token — the bundled source is bound inside the semantic module, and the learned decorator layers per-tenant state under read-time gates. A sibling module cannot override the intra-module token; the bundled fallback is always present when the classifier is available.

## Classification Source Seam

```typescript
// packages/control-plane/src/semantic/classification-source.ts
export interface ClassificationState {
  readonly centroids: SemanticCentroids;
  readonly source: 'bundled' | 'learned';
  readonly revision: string;
}

export interface LearningGate {
  readonly enabled: boolean;
  readonly epoch: number;
  readonly generation: number;
  readonly evidenceRevision: string;  // re-stamped at decision time
}

export interface ClassificationSourceProvider {
  resolve(principal: Principal, gate: LearningGate): Promise<ClassificationState>;
}
```

The **decision-time gate** is computed in `proxy.service.ts::learningGate` from the SAME settings read + snapshot the layers used (no extra hot-path I/O). It is `DISABLED_LEARNING_GATE` when settings is null, learning is off, or the classifier is unavailable; otherwise it carries `(epoch, generation, evidenceRevision)`.

`LearnedClassificationSource` (bound inside the semantic module) layers learned state over bundled:

- **Read-time gates**: learning on ∧ stored state's `(epoch, generation, revision)` matches the decision-time gate ∧ both labels validate
- **Fallback to bundled on ANY failure**: Redis fault, deadline, validation throw, missing/invalid state, gate mismatch — bundled, never skip
- **Cap'd LRU cache** (4 096 entries, 60 s TTL) so a dormant tenant re-validates at least as often as the active key's real expiry
- **Dedicated fail-fast Redis connection** — a down Redis never stalls the hot path

The store is injected as a `LearningStore`; the real implementation is `RedisLearningStore` (Lua-atomic rotate/stage/promote/readActive), the test implementation is the in-memory `InMemoryLearningStore`.

## Hot-Path Evidence Accumulation

For the L2-ambiguous slice only, the recorder hands the in-memory vector + the decision-time learning gate to `SemanticLearningContributor`, which forwards to `EvidenceAccumulator`. The accumulator:

- Hashes a tenant digest from `API_KEY_HMAC_SECRET` (tenant-scoped, **not** the raw tenant id)
- Groups by `(tenantHmac, label, revision)` cohorts under hard global caps; each cohort is bounded in age (`COHORT_MAX_AGE_MS = 10 min`)
- A partial cohort that reaches `MIN_COHORT` is flushed to Redis as a sum-of-vectors plus count via the `ADD_PENDING_LUA` script
- **Only the sum of ≥ `MIN_COHORT` embeddings ever reaches Redis** — the first value persisted is the sum of size ≥ 2, never one raw embedding
- A cohort below `MIN_COHORT` is dropped (loss OK, disclosure never)
- Uses a dedicated `enableOfflineQueue:false` Redis connection; saturation rejects immediately; bounded in-flight (32); zeroed buffers on flush/evict
- A `tryAcquire` admission gate with drop-BEFORE-allocation, mirroring the structural-baseline-store posture

On cascade-settle the recorder looks up the label by outcome (`labelForOutcome`):

| Cascade outcome | Label | Evidence contributed |
|-----------------|-------|----------------------|
| Not escalated, `success`/`fallback` with a decided quality signal | `low` | yes |
| Escalated by `quality_gate` | `high` | yes |
| Escalated by `cheap_error` (provider fault) | — | no |
| Cancelled, fail-open unknown quality | — | no |

The vector is dropped after contribution. It never reaches a telemetry column, a writer draft, a log line, a metric, an API response, or a Postgres column. Losing Redis loses learning and nothing else.

## Learning Sweep

`SemanticLearningScheduler` is a dedicated BullMQ queue (`semantic-learning`) — mirrors the calibration scheduler's discipline. Bootstrap is fail-open (a down Redis never gates boot or affects routing). The producer `Queue` is always created (a disabled node can still remove a stale schedule); the consuming `Worker` is created only when `SEMANTIC_LEARNING_SCHED_ENABLED` is true (default).

Default cron: `0 3 * * *` (daily at 03:30 UTC window, configurable).

For each learning-enabled tenant, the sweep:

1. Loads the tenant's routing snapshot (the `auto_low` chain).
2. Computes the **learning-evidence revision** — a content-derived digest of `embedderId`, dims, anchor set id, extractor version, both thresholds, quality-gate threshold, and the tenant's resolved `auto_low` chain. The same function is computed in the hot path (`resolveLearningEvidenceRevision`), so the accumulator's revision-stamped pending buckets and the sweep's rotate always agree.
3. **Discard pass** (`discard_revision`): deletes pending buckets AND active state whose revision differs from the current revision (a config change makes stale evidence mean different things). No generation bump.
4. **Apply pass** (cooldown-gated): rotates current-revision pending buckets through the `MIN_SAMPLES` floor; on eligible labels, computes the fresh evidence mean and folds it into the active centroid with EMA `α` (`SEMANTIC_LEARNING_ALPHA`, default 0.2), then spherically drift-clamps to `maxDrift` cosine distance (`SEMANTIC_LEARNING_MAX_DRIFT`, default 0.35) from the bundled centroid.
5. Stages generation `G+1` unreadably via `STAGE_LUA`.
6. CAS into Postgres (`semantic_learning_event` row, generation bump) — authoritative.
7. Promotes the Redis stage via `PROMOTE_LUA` keyed to the just-committed `(epoch, generation)`.

**Crash-atomicity**: Postgres is authoritative; the promote runs only after the CAS commit; a concurrent revert makes the CAS fail (`stale`) and no promote happens. Idempotent retries: a re-attempted rotate no-ops against an existing work key (the occurrence is fixed at first rotate).

A failing tenant is logged (secret-free) and the sweep continues (invariant 11 analog). Tenant enumeration faults, Redis faults, schema faults all log and continue; the sweep produces a per-run summary `{ tenants, applied, discarded, skips }`.

### Learning Rails (Boot-Validated)

| Env | Default | Rail | Failure mode |
|-----|---------|------|--------------|
| `SEMANTIC_LEARNING_MIN_COHORT` | 8 | `[2, 1000]` | Boot reject |
| `SEMANTIC_LEARNING_MIN_SAMPLES` | 50 | `[2, 100_000]`, must be `≥ MIN_COHORT` | Boot reject |
| `SEMANTIC_LEARNING_ALPHA` | 0.2 | `(0, 0.5]`, ≤ 4 decimals | Boot reject |
| `SEMANTIC_LEARNING_MAX_DRIFT` | 0.35 | `(0, 1]`, ≤ 4 decimals | Boot reject |
| `SEMANTIC_LEARNING_COOLDOWN_H` | 24 | `[1, 8760]`, must be `< STATE_TTL_D * 24` | Boot reject |
| `SEMANTIC_LEARNING_STATE_TTL_D` | 30 | `[1, 365]` | Boot reject |
| `SEMANTIC_LEARNING_MAX_COHORTS` | 4096 | `[16, 1_000_000]` | Boot reject |
| `SEMANTIC_LEARNING_SCHED_ENABLED` | `true` | — | bool |
| `SEMANTIC_LEARNING_SCHED_CRON` | `0 3 * * *` | cron string | validation |

Out-of-bounds values **reject boot** (never silently clamped — the fail-fast convention).

## Revert (One-Action)

`POST /api/routing/semantic-learning/revert`:

1. Bumps the **revocation epoch** in Postgres first (`routing_settings.semantic_learning_epoch`) — `UPDATE … WHERE owner = ?`. Any in-flight sweep's CAS then fails (`stale`), and every reader's `readActive` gates out the stale epoch.
2. Cleans up Redis learning keys for the tenant (best-effort; the epoch bump alone is the race-proof guarantee).
3. Idempotent: reverting with no learned state still bumps the epoch harmlessly. A subsequent revert is a no-op.

The dashboard's learning card renders a "Revert" button whenever a centroid has been promoted this epoch (including the stale case — reverting still fences it).

## L2 Telemetry

When Layer 2 evaluates, four columns are written to `request_log` for that row, **all-or-none** (a CHECK constraint enforces it):

| Column | Type | Meaning |
|--------|------|---------|
| `semantic_band` | text (`high`/`low`/`ambiguous`) | the classifier band |
| `semantic_score` | double | `simHigh − simLow`, rounded to 4 decimals |
| `semantic_source` | text (`bundled`/`learned`) | which classification source served |
| `semantic_revision` | text | the classifier revision (bundled or learned `(epoch.generation)`) |

Plus `decision_layer = 'semantic'` for confident-band rows that routed via L2 (an L2-ambiguous row keeps its downstream layer's `decision_layer` with the L2 verdict appended to `routing_reason`).

The `decision_layer = 'semantic'` filter on analytics powers the Auto-Performance semantic slice (evaluated, routed-per-band, the four-way outcome split, bundled/learned source). Residual-cascade labeling keeps pre/post-enable cascade figures comparable.

A confident band with an empty/missing target sets `decision_layer = 'semantic'` but does **not** cascade — the verdict is still recorded, and the request falls through to the Layer-0 default (mirrors L1's `unroutable`).

## Privacy Invariants

The L2 stack adds three privacy invariants on top of the global "metadata-only" rule:

1. **Raw embeddings never leave the hot path.** The accumulator keeps them in volatile memory only; the first value that lands in Redis is a sum over ≥ `MIN_COHORT` embeddings.
2. **No single raw embedding in Postgres.** All persisted learning artifacts are aggregates (counts, means, drift/similarity scalars) — `semantic_learning_event` carries drift and similarity scalars and sample counts only, never vector bytes.
3. **No vector in a log line, a metric, or an API response.** The verdict reason is numbers-only (`s =`, `hi =`, `lo =`, `src =`); `EmbedError` messages carry dimensions/reasons only. LRU caches hold centroids, not raw embeddings.

The router never logs the input text, never persists it to a draft, never returns it in a response. The recorder drops the vector after contribution.

## Degradation Surface (Honest Copy)

The dashboard's L2 toggle and learning card are built to fail honestly:

- `semanticAvailable = false` because no bundle path is set → toggle shows "Off instance-wide (set `SEMANTIC_MODEL_PATH`)".
- `semanticAvailable = false` because the bundle is broken → toggle shows "Layer 2 unavailable (bundle invalid)" and the operator can fix the bundle and restart.
- A promoted centroid whose embedder or revision moved under it → source line shows `bundled` with the explicit reason `a learned centroid exists but is inactive (embedder or revision changed) — routing on bundled anchors`. Never a wrong `learned` badge.
- A stale or failed learned read → bundled, logged, dashboard reads `bundled`. Never a router skip.

## Operational Knobs

The full env-var matrix lives in [Deployment](/openwiki/operations/deployment.md#optional-semantic-embedder). The semantic stack adds:

```
SEMANTIC_MODEL_PATH                 # unset = module absent entirely
SEMANTIC_TIMEOUT_MS                 # 50     # per-embed deadline; out-of-range rejects boot
SEMANTIC_MAX_INPUT_CHARS            # 2000   # extractor cap + embedder cap
SEMANTIC_CONCURRENCY                # 2      # try-acquire/no-queue permits
SEMANTIC_HIGH_THRESHOLD             # 0.15   # band cut; 4 decimals; out-of-range rejects boot
SEMANTIC_LOW_THRESHOLD              # 0.15   # band cut; 4 decimals; out-of-range rejects boot

SEMANTIC_LEARNING_MIN_COHORT        # 8      # hot-path cohort floor
SEMANTIC_LEARNING_MIN_SAMPLES       # 50     # sweep floor
SEMANTIC_LEARNING_ALPHA             # 0.2    # EMA weight on fresh evidence
SEMANTIC_LEARNING_MAX_DRIFT         # 0.35   # spherical drift cap (cosine distance)
SEMANTIC_LEARNING_COOLDOWN_H        # 24     # tenant cooldown between applies
SEMANTIC_LEARNING_STATE_TTL_D       # 30     # active-state TTL
SEMANTIC_LEARNING_MAX_COHORTS       # 4096   # hard global cap
SEMANTIC_LEARNING_SCHED_ENABLED     # true   # gate the sweep worker
SEMANTIC_LEARNING_SCHED_CRON        # 0 3 * * *
```

Out-of-range values reject boot (never silently clamped). Cross-field checks: `MIN_SAMPLES ≥ MIN_COHORT`, `COOLDOWN < STATE_TTL_D * 24`.

## Source Map (Where to Look)

| Concern | Primary file |
|---------|--------------|
| Embedder interface | `packages/data-plane/src/semantic/embedder.ts` |
| Anchor set | `packages/data-plane/src/semantic/anchors.ts` |
| Canonical extractor | `packages/data-plane/src/semantic/extract.ts` |
| Cosine classifier | `packages/data-plane/src/semantic/classify.ts` |
| Learning math (pure) | `packages/data-plane/src/semantic/learning.ts` |
| Public surface | `packages/data-plane/src/semantic/index.ts` |
| Config schema + builder | `packages/control-plane/src/semantic/semantic.config.ts` |
| Module rebinding | `packages/control-plane/src/semantic/semantic.module.ts` |
| ONNX loader (fail-fast) | `packages/control-plane/src/semantic/onnx-loader.ts` |
| Bundle contract + WordPiece + content hash | `packages/control-plane/src/semantic/bundle.ts` |
| Bounded embed pipeline | `packages/control-plane/src/semantic/embed-core.ts` |
| Embedder seam | `packages/control-plane/src/semantic/semantic-runtime.service.ts` |
| Classifier lifecycle | `packages/control-plane/src/semantic/semantic-classifier.service.ts` |
| Router (Layer 2 verdict) | `packages/control-plane/src/semantic/semantic-router.ts` |
| Classification source seam + gate | `packages/control-plane/src/semantic/classification-source.ts` |
| Learned decorator | `packages/control-plane/src/semantic/learned-classification-source.ts` |
| Hot-path contribution | `packages/control-plane/src/semantic/semantic-learning-contributor.ts` |
| Evidence accumulator | `packages/control-plane/src/semantic/evidence-accumulator.ts` |
| Learning store (Redis Lua) | `packages/control-plane/src/semantic/learning-store.ts` |
| Learning sweep | `packages/control-plane/src/semantic/learning.run.ts` |
| Sweep scheduler | `packages/control-plane/src/semantic/learning.scheduler.ts` |
| Evidence revision | `packages/control-plane/src/semantic/learning-evidence.ts` |
| Key/value format + Lua | `packages/control-plane/src/semantic/learning-format.ts`, `learning-lua.ts` |
| Status / revert endpoints | `packages/control-plane/src/semantic/semantic-learning.{service,controller}.ts` |
| Module wiring | `packages/control-plane/src/semantic/learning-contribution.module.ts` |
| Test fixtures (in-memory store, ONNX fixture) | `packages/control-plane/src/semantic/testing/` |

## Test Surfaces

- **Pure math** — `classify.spec.ts`, `extract.spec.ts`, `embedder.spec.ts`, `learning.spec.ts` (in `data-plane`)
- **Bundle / tokenizer / runtime** — `bundle.spec.ts`, `embed-core.spec.ts`, `onnx-integration.spec.ts`, `semantic-runtime.service.spec.ts`, `semantic.config.spec.ts`
- **Classifier + router + source** — `semantic-classifier.service.spec.ts`, `semantic-router.spec.ts`, `classification-source.spec.ts`, `learned-classification-source.spec.ts`, `evidence-accumulator.spec.ts`
- **Store + sweep** — `learning-store.spec.ts`, `learning-store-redis.spec.ts`, `learning-revision.spec.ts`, `learning.run.spec.ts`
- **End-to-end** — `packages/control-plane/test/proxy/semantic-routing.e2e-spec.ts`, `packages/control-plane/test/routing/semantic-learning.e2e-spec.ts`, `packages/control-plane/test/semantic-boot.e2e-spec.ts` (boot-time validation)

The boot-time e2e deliberately tolerates `onnxruntime-node` device-discovery stderr warnings — CI runs are not blocked by them.