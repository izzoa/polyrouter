---
'@polyrouter/frontend': minor
---

Replace the tier editor's native add-model `<select>` with a styled, hand-rolled
WAI-ARIA combobox: a single-tab-stop input that opens a provider-grouped listbox
and filters case-insensitively by model id or provider name (a provider-name
match keeps its whole group). Full keyboard operation (arrows with wrap,
Home/End, Enter commits, Escape closes then clears, IME-safe), an honest
"N of M models" count with an explicit empty state, price labels with their
`· est.` provenance, and the same ordered-chain add semantics as before.
