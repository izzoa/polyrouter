---
'@polyrouter/frontend': minor
---

Figures name their state in words: estimates read `· est.` or `· est. usage` instead of `~`, and unpriced, free, below-precision and stale figures say what they are

**Visual change.** Every slot that holds a figure now has one rendering per state, the same on
every page, and the state is named in words; colour only repeats them.

- **Estimates by axis.** A cost priced from an estimated price carries `· est.`. Token counts the
  provider did not report carry `· est. usage`, on the request table's tokens cell and in the
  inspector, never on the cost. The `~`, `~est` and `~estimated` markers are gone, and Overview
  and Costs name estimated usage in words (`12 requests with estimated usage`).
- **Unpriced, free and tiny amounts.** An unpriced request reads `unpriced`, never `$0.0000` or
  `— unpriced`. A free request or model price reads `$0 free`, with only `free` in green. An
  amount below display precision reads `<$0.01` or `<$0.0001`, never zero. Spend on Overview
  and Costs adds `· 4 unpriced` when the range holds unpriced requests, and Overview names the
  estimate-priced part of its spend (`includes $0.0042 estimate-priced`).
- **Loading, empty and failed.** Loading figures show a skeleton, with `Loading <what>` for
  screen readers, instead of a dash or a zero. A share with nothing to divide reads
  `not applicable`, and an empty range's success rate says `No requests in this range`. A failed
  read on Overview, Costs, Requests, the Pipeline, Agents' activity or a Limits card says
  `<What> couldn’t be loaded.` with Retry, removes the figures instead of showing them as
  current, and Retry keeps focus on the panel it reloads.
- **Limits.** Progress that is out of date, or whose refresh failed, reads `as of 14:02 · stale`.
  An ended period reads `expired · awaiting refresh`, and an overage reads `$1.50 over budget` in
  red.
- **Batches.** The reserved ceiling reads `≤ $3.00`, rounded up so the bound stays true, above
  `reserved, not spent`. The bundled Geist fonts gain the `≤` glyph, so it never falls back to
  an operating-system font.
- **Durations and token counts** read `412ms`, `1.24s` or `2m 05s`, and `12.4k` or `1.2M`,
  everywhere.

No API, routing behavior or stored data changed.
