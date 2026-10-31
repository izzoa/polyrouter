# Routing

Precedence order, first match wins:

1. **Explicit model** in the request body — always honored.
2. **`x-polyrouter-tier` header** → that tier's chain.
3. **Dashboard header rules** on other headers → their target tier or model.
4. **`model: "auto"`** → the enabled smart layers, which engage only once nothing above
   matched, in this order: a **Workload target** for the request's detected class (if one
   is configured and usable), then the band targets — a class's own **scoped**
   `auto_high` / `auto_low` pair when you set one, the generic pair otherwise — through L1
   structural → L2 semantic (optional) → L3 cascade (whose cheap/strong legs honour the
   same class scope). See [Workload routing](#workload-routing).
5. **`default` tier** — the guaranteed catch-all.

Whatever layer decides, the tier's fallback chain applies on provider failure, budgets are
enforced, and the decision (`decision_layer` + `routing_reason`) is recorded for the
inspector. If a smart layer is unavailable, `auto` silently degrades to the default tier.

## Workload routing

Beside the complexity bands, every `auto` request that Layer 1 evaluates records a
**workload** class — _what kind of work_ it is. The taxonomy is fixed (`v1`):

| Class        | Source                     | Detected from                                                                                       |
| ------------ | -------------------------- | --------------------------------------------------------------------------------------------------- |
| `code`       | structural (baseline)      | fenced-code share of the prompt (≥ 30 % and ≥ 200 chars by default — `ROUTING_WORKLOAD_THRESHOLDS`) |
| `vision`     | structural (baseline)      | an image content block                                                                              |
| `structured` | structural (baseline)      | a declared JSON / schema output format                                                              |
| `research`   | semantic (optional module) | the request embedding vs bundled per-class anchors — five-way cosine argmax with a margin           |
| `writing`    | semantic (optional module) | same                                                                                                |
| `none`       | —                          | nothing above applied — telemetry only, never routable                                              |

Among the structural classes vision > structured > code; the structural source always wins
when it found a class, and the semantic source never emits the structural classes (a
prose-only coding question usually records `none`). Detection is never keyword-based.

**Classification alone routes nothing.** You opt in per class on the Routing page:

- **Workload target** — an `auto_workload` rule binding one class to a tier or model. A
  matching `auto` request is _claimed_ before the band targets, Layer 2, and the cascade
  and served by that chain with `decision_layer = workload` (its band verdict is still
  recorded, never acted on). No target, or an unusable one (empty tier, unresolvable
  model) → the request follows the ordinary `auto` path. `none` can never be targeted.
- **Per-workload bands** — an `auto_high` / `auto_low` rule may carry a class as its
  _scope_. For a request of that class the scoped rule of a band decides: resolvable → it
  serves; unresolvable → that band is unroutable _for the class_ (never a silent
  substitution of the generic target). Only when a band has no scoped rule for the class
  does the generic rule apply — each band independently, so `auto_low(code) → cheap-code`
  beside a generic `auto_high` is a valid hybrid. The L3 cascade plans its cheap and strong
  legs with the same scope ("cascade within a class": cheap-code → strong-code). A class
  that also has a usable Workload target is claimed first and its scoped bands are never
  consulted (the card says so).
- **Semantic source** — `research` / `writing` light up when the semantic module is loaded
  (`SEMANTIC_MODEL_PATH` + `semantic` in `ROUTING_AUTO_LAYERS`, and the tenant's semantic
  layer on). A structural-`none` request is embedded **once** (the same vector serves
  Layer 2's band classification) and records the winning reserved class only when it beats
  every other class by `SEMANTIC_WORKLOAD_MARGIN` (0.05) and its cosine clears
  `SEMANTIC_WORKLOAD_MIN_SIM` (0.20); otherwise `none`. The anchors ship inside the
  package — no extra files — and the dashboard's auto-layers view reports the semantic
  workload state separately from L2. There is no new `ROUTING_AUTO_LAYERS` token and no
  new header: workload routing is a second verdict from the same layers, not a fourth.

**What is recorded.** The parent request-log row carries the workload quad —
`workload_class`, `workload_score`, `workload_source` (`structural` / `semantic`) and
`workload_revision` (`structural/v1/c1/<hash>`, `semantic/v1/s1/<hash>`) — and the
inspector shows the class as a chip. A claim records `decision_layer = workload`; a
class-scoped band or cascade decision's `routing_reason` **ends with ` scope=<class>`**
(class names only — never content). The Auto-performance card's **Workload mix** breaks
requests and spend down per class; its savings basis stays the **generic** strong target
(disclosed whenever scoped rules exist), and a cascade whose cheap leg was class-scoped
contributes no evidence to the optional learning loop. Everything degrades: a missing
model, a classifier fault, or a saturated embedder leaves the request on the ordinary
`auto` path — never an error.
