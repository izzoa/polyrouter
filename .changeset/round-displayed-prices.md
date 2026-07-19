---
"@polyrouter/frontend": patch
"@polyrouter/data-plane": patch
---

fix(pricing): round displayed per-1M prices (no more $0.19999999999999998)

Provider-listed price estimates are derived from per-token rates ×1e6, which leaves
float64 noise that rendered verbatim in the Providers and Routing pages. Displayed
prices now format through a 6-significant-digit formatter ("$0.2", "$2.5", "$0.0375"
all render cleanly), and the capture path normalizes the stored estimate to 12
significant digits so future syncs store the clean value the provider actually lists.
Display/storage cosmetics only — recorded request cost never flowed through either
path (cost immutability unchanged).
