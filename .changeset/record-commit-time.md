---
'@polyrouter/frontend': minor
'@polyrouter/shared': minor
'@polyrouter/data-plane': minor
'@polyrouter/control-plane': minor
---

A streamed request records when its model committed, and the Route Trace states it

A streamed request now records the moment the proxy committed to the member that served it: that member's first successful upstream event, the commit after which fallback and escalation can no longer move the request. It is stored as milliseconds from the request's start, the same origin as the latency, and is never later than the request's duration. It is read when that event arrives, never from a keepalive, the early response commit, the response headers or a leg's recorded end. It is recorded on every streamed request that committed, including one whose stream failed or whose client left after commit. It stays null on buffered requests, on a kept cheap answer replayed as a stream, on a stream that never committed, on batch items and on rows recorded before this release. The Route Trace states it on the outcome node's own line, `committed at 412ms`, below any output-cap line, on a served request and on one that failed or was cancelled after commit, which is why that request did not fall back. On some upstreams the commit event arrives before the first text, so the line says `committed`, not "first token". The request listing adds `committedMs`. A new Prometheus histogram, `polyrouter_stream_commit_seconds{protocol, decision_layer}`, observes the same value once per request that records one; it carries no provider label, because on a fallback or an escalation the wait includes other members' time. Routing, the commit boundary, status, cost and billing are unchanged. Migration 0049 adds the nullable `request_log.committed_ms` column; rows recorded earlier are not backfilled and read as before.
