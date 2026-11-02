---
'@polyrouter/frontend': minor
---

The Auto routing tab reads out what auto did, apart from what you set

The Auto routing tab is two panels. The **Pipeline** reads out where automatic routing sent
traffic. It lists the six stages in the order the proxy runs them, and each row shows:

- a status-now phrase describing the current configuration;
- the request count for the selected range, with its share and a proportional bar.

The bars are the tab's one accent figure. A count from when a stage was not running is labelled
as history ("routed while L1 was on", "routed under earlier targets"). A status line never shows
an unusable target as healthy: it keeps its `(empty)` or `(unresolved)` mark and turns to a
caution. If a target change may have landed but the refresh after it failed, the stages that read
targets say so.

Estimated net savings is now the Cascade row's savings line, with its range. It is shown to the
cent from $0.01, to four decimals below that, and as "< $0.0001" for amounts smaller still; it
never shows a non-zero amount as $0.00. The separate Auto performance panel and its stacked bar
are gone.

The **Setup** panel holds every control:

- the three layer switches, each in a cell with its description and state ("Unavailable" when
  the instance cannot enable it);
- self-calibration and semantic learning, which now open in drawers;
- the Targets matrix, with Claim, Strong and Cheap columns.

The matrix no longer has a Detected column: per-class counts are in the Workload claim detail,
which now names the classes with no detections in the range.

Row actions line up: every Details and Targets control is the same box at the same position, and
on a phone each row has one 44×44 control. When confident requests fell through to Default for
want of a target, the Confident band row and the Default detail end in **Go to Strong column** or
**Go to Cheap column**, which moves focus to that column in the matrix.

No routing behavior, API or stored data changed.
