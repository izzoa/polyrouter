# ROADMAP — polyrouter

Where polyrouter is going, what's actually open, and what's been explored but not
committed to. This file is **direction, not a schedule** — nothing here carries a date,
and nothing here is a promise.

For what has already shipped, see [`CHANGELOG.md`](./CHANGELOG.md) — it is the record of
record. For the engineering rules everything here is bound by (pinned stack, the 12
non-negotiable invariants, build order), see [`CLAUDE.md`](./CLAUDE.md).

**No feature code is written from this file.** Work reaches the codebase only as an
approved, spec-delta-carrying change proposal. An item here is thinking; an item that has
graduated has a proposal behind it.

---

## Prioritization

How anything moves. Four bands, and the axes that decide which band something sits in.

### Bands

| Band | Meaning |
|---|---|
| **Now** | Committed and unblocked. A proposal exists; it is being built. |
| **Next** | Committed, but **blocked on a named condition**. Deliberately unscheduled — the condition decides when, not a calendar. |
| **Candidate** | Parked. The design is understood well enough to scope; would be taken up on a clear demand signal. |
| **Speculative** | Parked. Needs a spike or an external trigger before it can even be scoped honestly. |

### Axes

| Axis | The question | Why it carries weight here |
|---|---|---|
| **Reach** | How many self-hosters does this unblock — and is it a hard block or a convenience? | Self-hosting is the product. A hard block for a few beats a nicety for many. |
| **Cost** | Rough size, XS → XL. | — |
| **Confidence** | Is the design known, or is there a load-bearing unknown? | An unknown is answered by a spike, not by a proposal. |
| **Invariant pressure** | Does this require loosening one of the 12 invariants? | The invariants are the quality bar. Loosening one costs disproportionate review and leaves lasting risk, so it is priced separately from effort. |

### Rules

1. **Invariant pressure is a veto, not a weight.** Anything that needs an invariant relaxed
   gets that decision made *on its own merits, first* — never as a side effect of shipping
   a feature that happens to need it.
2. **Low confidence caps the band at Speculative**, however high the reach. The remedy is
   a cheap experiment that converts the unknown, not a more detailed plan.
3. **Reach breaks ties.** Between two Candidates of similar cost, the one that unblocks a
   hard stop wins over the one that removes friction.
4. **Cheap and reversible beats correct and total.** A slice that ships behind a flag and
   can be withdrawn outranks a complete design that cannot.
5. **Nothing enters Now without a written proposal and spec deltas.**

### Promotion

```
  Speculative ──spike answers the unknown──▶ Candidate
   Candidate ──demand signal + open decisions settled──▶ Next
        Next ──named condition met──▶ Now ──proposal ▸ implement ▸ archive──▶ CHANGELOG
```

A **demand signal** is a real one: an issue, a user report, or a deployment that is
actually blocked. Anticipated demand is not a signal — that is what the parking lot is
for.

---

## Next — committed, blocked on evidence

The build plan is otherwise complete; the release history in
[`CHANGELOG.md`](./CHANGELOG.md) is current through v0.10.0.

Two committed items remain open. Both are **evidence-gated**: the evidence can only come
from real traffic on a deployed instance, so neither is scheduled, and building either one
early would be guessing.

| Item | Build only when this is observed | Cost · Confidence · Invariant pressure |
|---|---|---|
| **Auto-routing band ladder** — generalize the `high` / `low` / `ambiguous` split into a configured N-band ladder | The calibrated 3-band scheme **saturates**: ambiguous share stays **> 50%** in the Auto-performance view *after* calibration converges (history shows moves, then goes quiet), **AND** edge-zone rates are bimodal — both edges keep qualifying against opposite bounds | M · high · none |
| **Does structure have anything left to give?** — the successor question to the ladder | The ladder's condition, **plus** a negative result: calibration converged and band mix stable, yet quality-escalation in the ambiguous **middle** — not the edges — stays high | — · low · none |

**Gate status, last evaluated 2026-07-20: `UNASSESSABLE` pre-deployment.** Both need weeks
of real traffic under threshold calibration. The gates are evaluated by a read-only query
against a deployed instance's Postgres, with thresholds mirroring the shipped
`calibrationStats` / `effectiveThresholds` / `autoPerformance` definitions exactly, emitting
a per-tenant `MET | NOT_MET | INSUFFICIENT_DATA` verdict.

> **On the Layer-2 semantic classifier.** An earlier gated item proposed a local embedding
> classifier between the structural and cascade layers. It is **closed — superseded**: the
> L2 semantic stack was built and released in **v0.8.0** as a four-change epic (embedder →
> routing → learning → dashboard). Its evidence gate was never evaluated; the build was
> directed rather than triggered. The constitution amendment that gate required *did*
> happen first and explicitly — [`CLAUDE.md`](./CLAUDE.md) was amended to reclassify the L2
> stack from cloud-tier-only to a **flag-gated optional module** (the baseline image stays
> ONNX-runtime- and model-free; it activates only via `SEMANTIC_MODEL_PATH` +
> `ROUTING_AUTO_LAYERS`). What remains open is only the narrower successor question above.

**Also deferred, not gated:** multi-seat organizations/workspaces, and the two genuine
cloud-tier graduations — splitting the data plane into its own service, and moving request
analytics to a time-series store. All three are forward-compatible stubs in the schema
today; none is scheduled.

---

## Potential — parking lot

Explored and written down so the reasoning isn't lost. **Not committed**, no proposal.
Each entry is written to be picked up cold: what was verified, what is still unknown, what
decisions are outstanding, and the shape it would take if pursued.

Vendor facts carry the date they were verified — cloud APIs move, and a stale fact is
worse than no fact. **Re-verify before proposing.**

---

### Enterprise providers — Azure OpenAI, Google Vertex AI, Amazon Bedrock

*Explored 2026-07-31.*

| Slice | Band | Reach | Cost | Confidence | Invariant pressure |
|---|---|---|---|---|---|
| **1 · Azure + Bedrock via their OpenAI-compatible endpoints** | **Candidate** | High — unblocks the two most-asked enterprise backends | XS/S | High — nothing unverified | **Low**, but non-zero: pricing host-matching (see decisions) |
| **2 · Credential minting** (Vertex service-account JWT; Bedrock short-term keys) | Speculative | Medium — Vertex is unusable without it | M | Medium | **Veto-class** if ambient cloud credentials are in scope — see invariant 6 below |
| **3 · Native partner models** (Claude on Vertex / Bedrock) | Speculative | Medium | M/L | Low — gated on experiment 2 | Low |
| **4 · Bedrock streaming** (binary `eventstream` framing) | Speculative | Low | M | Low — may evaporate entirely | Low |

**The short version:** this is very likely **not** three new provider adapters. All three
now ship an OpenAI-compatible front door that polyrouter's existing `openai_compatible`
protocol already speaks, so the first useful slice needs **zero data-plane code**. The real
work is credential lifecycle, pricing host-matching, and onboarding UX — plus a genuine
long tail for partner models.

#### What was verified (2026-07-31)

| | Compat endpoint | Auth | Model specified in |
|---|---|---|---|
| **Azure** | `https://{res}.openai.azure.com/openai/v1/` | `api-key:` **or** `Authorization: Bearer <key>` | body (= deployment name) |
| **Bedrock** | `https://bedrock-runtime.{region}.amazonaws.com/openai/v1/` | `Authorization: Bearer $AWS_BEARER_TOKEN_BEDROCK` | body |
| **Vertex** | `https://{loc}-aiplatform.googleapis.com/v1/projects/{p}/locations/{l}/endpoints/openapi` | `Authorization: Bearer <access token>` | body (`google/gemini-3.5-flash`) |

Two findings collapse the parts that looked hardest:

1. **Azure's v1 API drops `api-version` and the `/deployments/{name}/` path segment.**
   The model moves into the body. That removes the per-request-URL problem for Azure
   entirely. (`base_url` also accepts the `.services.ai.azure.com` form.)
2. **Amazon Bedrock API keys are plain bearer tokens that work on the _native_ runtime
   paths**, not just the compat one — including Claude:
   ```
   POST https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-sonnet-4-6/converse
   Authorization: Bearer $AWS_BEARER_TOKEN_BEDROCK
   ```
   **SigV4 request signing is therefore optional, not required.** This was the single
   scariest item on the list and it is off the table.

Sources: [Azure v1 API](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle) ·
[Bedrock API keys](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html) ·
[Bedrock OpenAI models](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-openai.html) ·
[Vertex OpenAI compatibility](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/openai) ·
[Claude on Vertex](https://platform.claude.com/docs/en/build-with-claude/claude-on-vertex-ai)

#### Gap analysis against the existing seam

Read against `packages/data-plane/src/providers/http-adapter.ts`:

```
HttpAdapterSpec today                 Azure     Bedrock    Vertex    Claude-on-
                                      /v1       /openai/v1 /openapi  Vertex|Bedrock
─────────────────────────────────────────────────────────────────────────────────
chatPath: string  ← STATIC, joined     ok        ok         ok        ✗ model in path
  once at adapter creation
authHeaders(cred) ← SYNC, cred-only    ok        ok         ok*       ok
readSseChunks     ← SSE hardcoded      ok        ok         ok        ✗ Bedrock stream
translate.requestOut                   ok        ok         ok        ✗ anthropic_version,
                                                                        drop `model`
─────────────────────────────────────────────────────────────────────────────────
data-plane LOC needed:                  0         0          0        real work
                                                  * access token expires in ~1h
```

`http-adapter.ts:227` — `const chatUrl = joinUrl(config.baseUrl, spec.chatPath)`, computed
once at adapter creation — is the single line gating the right-hand column. Everything in
the left three columns runs on today's code **unmodified**.

#### The four real problems

1. **Credential lifecycle.** Vertex access tokens live ~1h; Bedrock *short-term* keys ~12h.
   Azure keys and Bedrock *long-term* keys never expire (paste-once — effectively free).
   Refresh rails already exist from the subscription-OAuth work: `credentialExpiresAt`,
   `credentialError`, and the `oauth_bearer` auth scheme.
2. **Pricing / host matching.** `PROVIDER_FAMILY_HOSTS`
   (`packages/shared/src/server/pricing/resolve.ts:64`) is an **exact-host** map by design.
   Enterprise hosts are per-tenant/per-region wildcards. Without a fix, every enterprise
   request records **cost unknown** — the most user-visible gap of the four.
3. **Onboarding.** Nobody hand-types
   `.../projects/{p}/locations/{l}/endpoints/openapi`. This is a preset + wizard problem,
   and the bundled preset registry already exists
   (`packages/control-plane/src/subscription-oauth/presets.ts`).
4. **The long tail.** Claude on Vertex/Bedrock genuinely needs per-request URLs, body
   shaping (`anthropic_version`, drop `model`), and — for Bedrock streaming — an
   `application/vnd.amazon.eventstream` binary frame decoder.

#### Open decisions (settle these before proposing)

- **Pricing host patterns vs. cost-correctness.** `resolve.ts:149` documents the exact-host
  map as a deliberate guard: *"an unknown/reseller host NEVER inherits a well-known
  provider's price."* Enterprise hosts force pattern matching — a real loosening of a
  guard adjacent to the cost-immutability invariant. Doable conservatively (anchored
  suffix allowlist, `unknown` still the default), but it deserves its own scrutiny.
- **Azure deployment names are arbitrary.** A deployment called `prod-chat` derives
  `azure:prod-chat` → catalog miss → cost unknown, permanently. Correct pricing needs the
  deployment→model mapping read off the models listing. This is the one part of the
  otherwise-free Azure slice that isn't free, and it may argue for capturing a
  `resolved_model` on the Model row **generally** — which would also help resellers.
- **Ambient cloud credentials vs. invariant 6.** The natural enterprise deploy is
  polyrouter on EKS/GKE with a workload identity and zero pasted secrets. Both AWS IMDS
  and GCP metadata live at `169.254.169.254` — the link-local range invariant 6 blocks.
  Reading: the invariant governs *user-supplied* URLs, and IMDS is a fixed constant like
  the OAuth token endpoints already are, so this is an implementation gate rather than an
  invariant violation. But per prioritization rule 1 it needs a deliberate, narrow
  carve-out on the **credential-minting client only** — never on the provider transport —
  decided on its own merits, not as a side effect of a Vertex task.
- **Where structured credentials live.** A GCP service-account JSON or an AWS key pair
  isn't a string. The OAuth envelope already carries structured credentials, so extending
  it with machine grant types (e.g. `gcp_service_account`) reuses refresh, expiry display,
  and the reauthorize-required state. It's a conceptual stretch — no user consent, no
  `state`, no authorize URL — but the alternative is a parallel credential-provider
  abstraction. Current lean: reuse the existing rails.
- **Kind taxonomy.** `kind ∈ {api_key, subscription, custom, local}` drives both the SSRF
  guard context and the "model-own price honored only for `custom`/`local`" rule. Adding
  an `enterprise` kind ripples through both; `api_key` plus a separate vendor/preset field
  is probably cleaner.

#### Shape if pursued

```
Slice 1  Azure + Bedrock, OpenAI-compat        presets + pricing hosts.  0 data-plane LOC
Slice 2  Credential minting                    Vertex SA-JWT, Bedrock short-term keys
Slice 3  Native partner models                 per-request URL + body shaping
Slice 4  Bedrock streaming                     eventstream frame decoder
```

Dependency-ordered, each independently shippable. Note this **inverts the intuitive
ordering**: Vertex looks like "just another Google endpoint" but is the one that cannot
work at all without new machinery, because Vertex has no long-lived API key —
IAM tokens only.

#### Two experiments to run before writing any proposal

Both are cheap, and each one converts a Speculative slice into a scoped one — the
prioritization rule 2 remedy.

1. **Add Azure today through the existing custom-provider form** —
   `base_url = https://{res}.openai.azure.com/openai/v1`, kind `custom`, protocol
   `openai_compatible`, paste the key. The path was traced (DTO → `joinUrl` →
   `Authorization: Bearer` → `/models` → SSRF-public) and nothing appears to block it.
   If it works, slice 1 for Azure is documentation plus a pricing-host entry.
2. **Does Bedrock's `/openai/v1/chat/completions` accept a non-`openai.*` model id?**
   AWS documents it under "OpenAI models" with only `openai.gpt-oss-*` in every example,
   but the Mantle-engine references suggest it may be broader. If Claude works through
   that path, **slices 3 and 4 collapse entirely for Bedrock** — no per-request URLs, no
   binary framing. Highest-leverage single test on the board.

Both fit the pattern already used for the OAuth presets: ship disabled, verify live, then
flip the enablement gate.
