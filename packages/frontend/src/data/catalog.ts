/** Display-only endpoint shown in connection snippets/UI. NEVER fetched — the
 * ApiClient talks to the SPA's own origin via the relative bases below (same
 * origin in prod, Vite-proxied in dev). Derived from the runtime origin (E12.3) so
 * it matches how the instance is actually served and agrees with the server-minted
 * key-reveal snippet, instead of a build-time dev literal. */
export const BASE_URL = `${globalThis.location.origin}/v1`;

/** Origin-relative bases the real ApiClient calls (spec §4 dev/prod topology). */
export const API_BASE = '/api';
export const PROXY_BASE = '/v1';

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n);
}
