/**
 * Request-plane predicates (E9.2). Express matches controller routes
 * case-insensitively, so every plane-scoping decision (the session guard, the SPA
 * fallback reservation, the Better-Auth interception, the `/v1` error envelope,
 * the auth rate limiter) MUST scope the path case-insensitively — and
 * segment-safely, so `/apiary` does not fold into the `/api` plane.
 */
export function isApiPath(path: string): boolean {
  const p = path.toLowerCase();
  return p === '/api' || p.startsWith('/api/');
}

export function isV1Path(path: string): boolean {
  const p = path.toLowerCase();
  return p === '/v1' || p.startsWith('/v1/');
}
