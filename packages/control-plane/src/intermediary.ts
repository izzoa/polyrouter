/**
 * The idle-reap window common to reverse proxies / load balancers / CDNs (nginx's
 * default `proxy_read_timeout` is 60s; Cloudflare reaps an origin-silent connection
 * at ~100s). Every long-lived stream polyrouter serves — the dashboard event stream
 * and the `/v1` inference stream (add-stream-keepalive) — must keep its silence
 * comfortably under it, or an idle connection is silently dropped. One definition,
 * so "safe" means the same thing everywhere.
 */
export const INTERMEDIARY_REAP_FLOOR_MS = 60_000;
