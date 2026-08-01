# ROADMAP — polyrouter

Direction and parked thinking. This file is **not** the build plan.

| File | Holds |
|---|---|
| [`TODOS.md`](./TODOS.md) | The **committed** plan — the spec decomposed into proposable OpenSpec changes, in dependency order, with a status board. Its "Deferred" section is work we've **decided** to do later. |
| **`ROADMAP.md`** (this file) | Direction, and a **parking lot** for ideas that have been explored but **not** committed to. Nothing here is scheduled, and nothing here has a proposal. |
| `openspec/specs/` | The archived capability contracts — what the system actually promises today. |
| [`CLAUDE.md`](./CLAUDE.md) | Operating rules, pinned stack, the 12 non-negotiable invariants. |

**Promotion path.** A parked item leaves this file by becoming a TODOS.md entry, then an
OpenSpec change (`/opsx:propose`). Until then it is thinking, not a commitment — do not
implement from this file.

---

## Now / Next

Everything in the build plan is shipped: **91 archived changes** as of 2026-07-31 — the
22-entry baseline, both review gates, all 15 audit epics + 10 A-batches, StyleSeed
conformance, Epic AR (auto-routing), Epic L2 (semantic), and the out-of-band tail.

**Exactly two committed items remain open, and neither is buildable yet.** Both are
*evidence-gated* — deliberately not scheduled, because the evidence can only come from
real traffic on a deployed instance.

| Item | Gate — build only when this is observed |
|---|---|
| **AR-6** `add-auto-band-ladder` — generalize high/low/ambiguous into a configured N-band ladder | Calibrated 3-band **saturates**: ambiguous share stays **> 50%** in the Auto-performance view *after* calibration converges (history shows moves, then quiet), **AND** edge-zone rates are bimodal (both edges keep qualifying against opposite bounds) |
| **AR-7′** band-ladder's successor question — *does structure have anything left to give?* | AR-6's gate **plus** a negative result: calibration converged, band mix stable, yet quality-escalation in the ambiguous **middle** (not the edges) stays high |

Gate status as last evaluated (2026-07-20): **UNASSESSABLE pre-deployment** — both need
weeks of real traffic under AR-5 calibration. Both gates are evaluated by a read-only
query against a deployed instance's Postgres, whose thresholds mirror
`calibrationStats` / `effectiveThresholds` / `autoPerformance` exactly; it emits a
per-tenant `MET | NOT_MET | INSUFFICIENT_DATA` verdict. Run it after a few weeks of
calibrated traffic. (Local maintainer tooling — see `TODOS.md` for the invocation.)

> **Note on AR-7.** The original AR-7 (`add-local-semantic-l2`) is **closed — superseded**.
> The L2 semantic stack was built on user direction 2026-07-21/22 as the four-change Epic
> L2 and released in v0.8.0, *without* its evidence gate ever being evaluated. The
> constitution amendment that gate demanded did happen first and explicitly
> (`add-semantic-embedder` amended `CLAUDE.md` + `openspec/project.md`, reclassifying L2
> from cloud-tier-only to a flag-gated optional module). What remains open is only the
> narrower successor question in the table above.

**Also deferred, not gated** (`TODOS.md` → Deferred): `add-org-workspaces` (multi-seat
Organization/Workspace), and the two genuine cloud-tier graduations — `split-data-plane`
and `add-events-store`.

---

## Potential — parking lot

Explored, written down so the reasoning isn't lost, **not** committed. Each entry is
written to be picked up cold: what we verified, what's still unknown, what decisions
are outstanding, and the shape it would take if pursued.

Vendor facts recorded here carry the date they were verified — cloud provider APIs move,
and a stale fact is worse than no fact. Re-verify before proposing.

---

### Enterprise providers — Azure OpenAI, Google Vertex AI, Amazon Bedrock

*Explored 2026-07-31. No proposal. No commitment.*

**The short version:** this is very likely **not** three new provider adapters. All three
now ship an OpenAI-compatible front door that `openai_compatible` already speaks, so the
first useful slice needs **zero data-plane code**. The real work is credential lifecycle,
pricing host-matching, and onboarding UX — plus a genuine long tail for partner models
(Claude on Vertex/Bedrock).

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
   Refresh rails already exist from `add-subscription-oauth`: `credentialExpiresAt`,
   `credentialError`, the `oauth_bearer` auth scheme.
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
  provider's price."* Enterprise hosts force pattern matching — a real loosening of an
  invariant-4-adjacent guard. Doable conservatively (anchored suffix allowlist,
  `unknown` still the default), but it deserves its own scrutiny.
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
  invariant violation. But it needs a deliberate, narrow carve-out on the
  **credential-minting client only** — never on the provider transport — as its own
  reviewed decision, not a side effect of a Vertex task.
- **Where structured credentials live.** A GCP service-account JSON or an AWS key pair
  isn't a string. The OAuth envelope already carries structured credentials, so extending
  it with machine grant types (e.g. `gcp_service_account`) reuses refresh, expiry display,
  and `reauthorize_required`. It's a conceptual stretch — no user consent, no `state`, no
  authorize URL — but the alternative is a parallel credential-provider abstraction.
  Current lean: reuse the existing rails.
- **Kind taxonomy.** `kind ∈ {api_key, subscription, custom, local}` drives both the SSRF
  `GuardContext` and the "model-own price honored only for `custom`/`local`" rule. Adding
  an `enterprise` kind ripples through both; `api_key` plus a separate vendor/preset field
  is probably cleaner.

#### Shape if pursued

```
Phase 1  Azure + Bedrock, OpenAI-compat         presets + pricing hosts.  0 data-plane LOC
Phase 2  Credential minting                     Vertex SA-JWT, Bedrock short-term keys
Phase 3  Native partner models                  per-request URL + body shaping
Phase 4  Bedrock streaming                      eventstream frame decoder
```

Dependency-ordered, each independently shippable. Note this **inverts the intuitive
ordering**: Vertex looks like "just another Google endpoint" but is the one that cannot
work at all without new machinery, because Vertex has no long-lived API key —
IAM tokens only.

#### Two experiments to run before writing any proposal

1. **Add Azure today through the existing custom-provider form** —
   `base_url = https://{res}.openai.azure.com/openai/v1`, kind `custom`, protocol
   `openai_compatible`, paste the key. The path was traced (DTO → `joinUrl` →
   `Authorization: Bearer` → `/models` → SSRF-public) and nothing appears to block it.
   If it works, Phase 1 for Azure is documentation plus a pricing-host entry.
2. **Does Bedrock's `/openai/v1/chat/completions` accept a non-`openai.*` model id?**
   AWS documents it under "OpenAI models" with only `openai.gpt-oss-*` in every example,
   but the Mantle-engine references suggest it may be broader. If Claude works through
   that path, **Phases 3 and 4 collapse entirely for Bedrock** — no per-request URLs, no
   binary framing. Highest-leverage single test on the board.

Both fit the pattern already used for OAuth presets: ship `enabled: false`, verify live,
then flip.
