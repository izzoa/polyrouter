---
"@polyrouter/shared": minor
"@polyrouter/data-plane": minor
"@polyrouter/control-plane": minor
"@polyrouter/frontend": minor
---

**Workload-scoped bands (Epic W, W-4).** Band rules (`auto_high` / `auto_low`) may now carry a `workload_class` as a SCOPE — that band target applies only to requests whose deciding workload class matches — and the proxy resolves a class's scoped pair before the generic pair for Layer-1 and Layer-2 band routing and for the cascade plan (cheap/strong resolved per band with the scope; each falls back to the generic rule independently; an existing scoped rule with an unusable target makes that band unroutable for the class — never a silent substitution). The Workload-target claim still precedes the bands. Routing reasons gain ` scope=<class>` (every cascade-constructed reason too); a cascade whose selected cheap leg was class-scoped contributes no learning evidence (its revision binds to the generic cheap chain); the Auto-performance savings basis is the generic strong target and `savings.basis.scoped` says when scoped rules exist. Migration `0028` (NOT VALID) replaces the W-2 pairing CHECK with the three-way scope CHECK; rule CRUD validates the scope shapes. The Band-targets card gains a per-workload bands block (class picker, STRONG/CHEAP rows, claim-first / unusable-claim notes, scope-isolated set/clear/cleanup).
