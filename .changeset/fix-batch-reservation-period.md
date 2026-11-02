---
'@polyrouter/control-plane': patch
---

A batch's budget reservation is now keyed on the job's recorded submission instant, the same instant its release and the scheduler's reconciliation use. A batch submitted at a period boundary, or under app/database clock skew, can no longer reserve in one period and release from the other.
