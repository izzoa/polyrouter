# structural-routing Specification

## Purpose
TBD - created by archiving change add-structural-routing. Update Purpose after archive.
## Requirements
### Requirement: `auto` opts into Layer 1 structural pre-classification

When a request names model `auto` and Layer 1 is enabled, the system SHALL run a **cheap, language-neutral** structural classification over the already-parsed request — **sub-millisecond in the typical case and bounded by design** (input scan and fingerprint are capped, and no network I/O runs on the hot path) — and, when confident, steer the request to a configured cheaper or stronger tier before any upstream call (spec §7.2 Layer 1, §7.6). The classification MUST NOT run a tokenizer or any generative/LLM call on the hot path (invariant 9) and MUST NOT alter routing for any request that does not name `auto`.

#### Scenario: A complex `auto` request is steered to the high tier

- WHEN a request names `auto` with a large user turn (e.g. big input, multiple code blocks, and many tool definitions) and an `auto_high` target is configured
- THEN the request is routed to the `auto_high` target tier and served, with `decision_layer = 'structural'`

#### Scenario: A trivial `auto` request is steered to the low tier

- WHEN a request names `auto` with a short, simple user turn and an `auto_low` target is configured
- THEN the request is routed to the `auto_low` target tier and served, with `decision_layer = 'structural'`

#### Scenario: A non-`auto` request is never touched by Layer 1

- WHEN a request names a concrete model or a tier (explicitly or via `x-polyrouter-tier`)
- THEN structural classification does not run and the Layer-0 decision stands unchanged

### Requirement: System-prompt de-contamination and per-agent baseline

The system SHALL score the **last user turn plus a bounded window of recent context and MUST exclude the system block** from feature extraction, so an identical large harness system prompt does not push requests into the top tier (spec §7.2 problem 1). The system prompt SHALL be fingerprinted (a stable hash) and used to key a **learned per-agent baseline** that is subtracted from the size signal, so content that is constant across an agent's traffic carries no complexity signal (the delta is measured, not the preamble). The shared per-agent baseline store is bounded (a capped set of fingerprints per agent, shared across instances) and SHALL evict its **stalest** fingerprint when a new one arrives at the cap (per-field LRU), rather than refusing new fingerprints while refreshing the whole-set TTL — so an agent whose system prompt interpolates rotating dynamic values (timestamps, session ids) cannot permanently saturate the set and prevent a legitimate recurring boilerplate fingerprint from being (re-)learned. This is best-effort learning: if the shared store is unavailable the smart path still degrades to Layer 0 (invariant 1).

#### Scenario: An identical huge system prompt does not force the top tier

- WHEN successive `auto` requests carry the same very large system prompt but a small user question
- THEN the requests are NOT forced to the `auto_high` tier on account of the system prompt (it is excluded from scoring)

#### Scenario: An above-baseline request escalates for the same agent

- WHEN an agent's requests carry a constant in-context boilerplate that has been learned into its baseline
- THEN a subsequent same-shaped request measures a near-zero size delta (does not escalate on size), WHILE a request whose user turn is far larger than that baseline measures a large delta and can escalate

#### Scenario: A recurring fingerprint is still learnable after the set fills with transient ones

- WHEN an agent produces more than the per-agent cap of distinct fingerprints (e.g. a dynamic value interpolated into each system prompt) and then repeats one recurring boilerplate fingerprint
- THEN the recurring fingerprint is (re-)learned into the shared store — the stalest transient fingerprint is evicted to make room — and a second store instance cold-seeds that baseline from the shared store rather than reading a permanently-saturated, never-expiring set

### Requirement: Structural features are language-neutral

The system SHALL classify using only structural signals — effective input size, code-block presence/size, tool-definition count, tool-schema demand, multimodal presence, conversation depth, and requested `max_tokens` — and SHALL NOT use natural-language keyword or phrase matching (spec §7.2 problem 2), so a request routes the same regardless of human language.

#### Scenario: A non-English request routes on structure, not keywords

- WHEN two `auto` requests are structurally equivalent (same sizes, code blocks, tool counts) but written in different human languages
- THEN they receive the same structural band and route to the same tier

### Requirement: Bands map to tiers via configured targets; ambiguous falls through to `default`

The system SHALL map a **high** band to a tenant-configured `auto_high` target and a **low** band to an `auto_low` target, each expressed as an owned RoutingRule whose target is validated against the tenant's own tiers/models. A `tier:` target SHALL carry that tier's ordered fallback chain (§7.4 applies to every layer); a `model:` target SHALL resolve to that single model (no fallback), identical to a directly-named model. When more than one rule of a band exists, selection SHALL be deterministic (the same priority ordering Layer-0 rules use, independent of storage order). An **ambiguous** result, or a missing / empty / unresolvable target, SHALL fall through to the `default` tier (spec §7.2; Layer 1 defers to Layer 0 until #14 adds cascade). `auto_high`/`auto_low` rules MUST be inert for Layer-0 (explicit / header / default) routing.

#### Scenario: An ambiguous request falls through to the default tier

- WHEN an `auto` request's structural score is between the low and high thresholds
- THEN it is routed to the `default` tier with `decision_layer = 'default'` (no structural override)

#### Scenario: A confident band with no configured target falls through

- WHEN an `auto` request scores high but no `auto_high` target is configured (or its target tier is empty)
- THEN the request falls through to the `default` tier and still succeeds

#### Scenario: Band-target rules do not affect explicit routing

- WHEN a tenant has `auto_high`/`auto_low` rules configured
- THEN a request naming a concrete model, or selecting a tier via `x-polyrouter-tier`, resolves exactly as it would without those rules

#### Scenario: A confident band overrides a plain default decision

- WHEN an `auto` request would resolve via Layer 0 to the `default` tier (whether from the seeded default tier or a configured `default` RoutingRule) AND the structural band is confidently high or low with a configured target
- THEN the structural target serves the request (the `auto` opt-in prefers the confident band over the plain default), WHILE an ambiguous band leaves the Layer-0 default decision in place

### Requirement: The smart path always degrades to Layer 0 and never fails or stalls

Any failure or unavailability in the structural path SHALL degrade to the Layer-0 `default` decision; the request MUST NOT fail or stall because Layer 1 is disabled, erroring, or slow (invariant 1, spec §7.2 guardrails). This includes the layer being disabled by configuration, the Redis-backed baseline store being unavailable or slow, feature extraction or classification throwing, and any unresolvable band target.

#### Scenario: With the layer disabled, `auto` still serves via Layer 0

- WHEN `ROUTING_AUTO_LAYERS` does not include `structural`
- THEN an `auto` request is served via the `default` tier exactly as in Layer 0, with no error and no added stall

#### Scenario: A slow or down baseline store never blocks routing

- WHEN the Redis-backed baseline is unavailable or slow
- THEN the hot-path baseline read (a synchronous in-process lookup) does not await Redis; classification proceeds from the local value or from raw features (no baseline subtraction), and the request is still routed and served with no added stall

#### Scenario: An internal structural error degrades to default

- WHEN feature extraction or classification throws for any reason
- THEN the request degrades to the `default` tier and is served (the error never reaches the client)

### Requirement: Structural decisions are recorded transparently

A request routed by Layer 1 SHALL record `decision_layer = 'structural'` and a structured, human-readable `routing_reason` naming the band and the numeric sub-scores that drove it (spec §7.2 guardrails, §7.5), so the routing decision is inspectable per request. The `routing_reason` and any log line MUST contain **only derived numbers/flags — never raw prompt/response text and never a hash of it** (invariant 8). The system-prompt fingerprint is used **only** as an ephemeral, tenant-scoped, server-keyed (HMAC) Redis key — not dictionary-correlatable and **never written to the RequestLog, `routing_reason`, or any log line**.

#### Scenario: A structural decision is visible on the request log

- WHEN an `auto` request is routed by Layer 1
- THEN its RequestLog row has `decision_layer = 'structural'` and a `routing_reason` that names the band (high/low) and the numeric sub-scores that drove it

#### Scenario: No prompt content leaks into the record

- WHEN a request carries distinctive text in its system prompt, messages, or tool schemas and is routed by Layer 1
- THEN that raw text appears in neither the `routing_reason` nor any log line (only counts/sizes/flags are recorded), and the durable record carries no hash of it (the only fingerprint is the ephemeral, server-keyed HMAC Redis key)

