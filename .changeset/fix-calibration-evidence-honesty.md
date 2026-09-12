---
'@polyrouter/control-plane': patch
'@polyrouter/shared': patch
'@polyrouter/frontend': patch
---

Four ways the calibration-evidence view told an operator something false: the
tenant total the calibrator actually evaluates was computed but never rendered,
a NULL-score row vanished from every count, a tenant that never had a threshold
event was told its evidence was reset by one, and a halted calibrator reported
healthy evidence. The agent list is now bounded with the total still taken over
every agent, and a failure rate renders at a precision that cannot display its
own decision bound when the bound was not met.
