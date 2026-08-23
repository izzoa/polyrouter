---
"@polyrouter/frontend": patch
---

Band-targets card: the section-level `unverified` state is now raise-only from actions — a definitively rejected write on one band whose reconcile also failed can no longer clear the *unverified* state a concurrent landed-but-unverified write on the other band set; only an authoritative rules re-list that commits (the section's reconcile or a full routing reload) clears it (the Workload-targets card already behaved this way). Pinned by an ordered race test.
