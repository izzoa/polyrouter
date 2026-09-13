---
'@polyrouter/control-plane': minor
'@polyrouter/frontend': minor
'@polyrouter/shared': minor
---

Threshold calibration now works per agent, under the identical standard.

Calibration was tenant-wide: one `high`/`low` pair, calibrated from every
agent's rows pooled together, so the agent contributing most of the traffic set
the thresholds every other agent inherited. On a measured instance one agent
carried 84.6% of the decided ambiguous band. The structural layer already
reasons per agent — the size feature is a delta from that agent's own baseline —
so the scorer was per-agent and only the thresholds it was compared against
were not.

Each agent can now earn its own pair from its own evidence. The standard does
not change, only the scope it is applied at: same evidence floor, statistic,
step, drift cap, minimum gap, hysteresis, cooldown and contraction-only rule.
An agent that has not earned a pair inherits its tenant's, which is a correct
outcome rather than a failure to act, and most agents on most instances will
stay there.

Resolution runs instance defaults → tenant pair → agent pair, degrading to the
level above at each hop and never skipping one. Drift is bounded twice, from
the tenant anchor and globally from the instance defaults, so the two levels
cannot compound. There is no new hot-path read: the pair rides the projection
the agent-key guard already performs.

The Routing page lists every agent with its pair, anchor and evidence, names
the inheriting ones as inheriting rather than uncalibrated, offers a per-agent
revert, and discloses a tenant pair that is no longer informed by the traffic
it governs. The tenant's calibration toggle remains the single consent
boundary — there is no per-agent enable.
