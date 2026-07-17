## MODIFIED Requirements

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
