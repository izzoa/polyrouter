/**
 * Protocol-shaped, sanitized proxy errors (#10, spec §6.1). Every `/v1` failure
 * is rendered as a fixed message in the caller's own envelope — never the raw
 * upstream body, request id, or credential.
 */
import {
  ProviderCircuitOpenError,
  ProviderError,
  type ProviderErrorKind,
  type RouteErrorKind,
} from '@polyrouter/data-plane';
import type { BudgetHit } from '../budgets/budget-service';

export type ClientProtocol = 'openai' | 'anthropic';

/** A mapped, client-safe failure. Carries only fixed, public fields. */
export class ProxyError extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string,
    readonly errorType: string,
    readonly code: string | null,
  ) {
    super(publicMessage);
    this.name = 'ProxyError';
  }
}

interface Mapped {
  status: number;
  message: string;
  type: string;
  code: string | null;
}

const ROUTE_MAP: Record<RouteErrorKind, Mapped> = {
  unknown_model: {
    status: 404,
    message: 'model not found',
    type: 'invalid_request_error',
    code: 'model_not_found',
  },
  ambiguous_model: {
    status: 404,
    message: 'model id is ambiguous; qualify it as "<providerId>:<model>"',
    type: 'invalid_request_error',
    code: 'ambiguous_model',
  },
  empty_tier: {
    status: 400,
    message: 'the resolved routing tier has no models configured',
    type: 'invalid_request_error',
    code: 'empty_tier',
  },
  unresolved_target: {
    status: 400,
    message: 'the routing target could not be resolved',
    type: 'invalid_request_error',
    code: 'unresolved_target',
  },
  no_default: {
    status: 500,
    message: 'no default routing tier is configured',
    type: 'api_error',
    code: 'no_default',
  },
};

const PROVIDER_MAP: Record<ProviderErrorKind, Mapped> = {
  auth: {
    status: 502,
    message: 'upstream authentication failed',
    type: 'api_error',
    code: 'upstream_auth',
  },
  rate_limit: {
    status: 429,
    message: 'upstream rate limited',
    type: 'rate_limit_error',
    code: 'rate_limited',
  },
  unavailable: {
    status: 503,
    message: 'upstream unavailable',
    type: 'api_error',
    code: 'upstream_unavailable',
  },
  bad_request: {
    status: 400,
    message: 'invalid request to upstream',
    type: 'invalid_request_error',
    code: 'bad_request',
  },
  unknown_model: {
    status: 404,
    message: 'model not found upstream',
    type: 'invalid_request_error',
    code: 'model_not_found',
  },
};

const of = (m: Mapped): ProxyError => new ProxyError(m.status, m.message, m.type, m.code);

export const routeError = (kind: RouteErrorKind): ProxyError => of(ROUTE_MAP[kind]);
export const providerErrorToProxy = (err: ProviderError): ProxyError => of(PROVIDER_MAP[err.kind]);

export const badRequest = (message: string): ProxyError =>
  new ProxyError(400, message, 'invalid_request_error', 'bad_request');
export const unauthorized = (): ProxyError =>
  new ProxyError(401, 'invalid API key', 'authentication_error', 'invalid_api_key');
export const serviceUnavailable = (message: string): ProxyError =>
  new ProxyError(503, message, 'api_error', 'unavailable');
/** A `block` budget is at/over threshold — reject the request pre-upstream (#16),
 * naming the budget AND its reset (from the hit) so the caller knows when to retry. */
export const budgetBlocked = (hit: BudgetHit): ProxyError =>
  new ProxyError(
    402,
    `budget exceeded: ${hit.budget.name} (resets ${hit.resetAt.toISOString()})`,
    'invalid_request_error',
    'budget_exceeded',
  );
/** Fail-closed enforcement: the budget check couldn't be trusted (Redis fault /
 * stale reconciliation) and the operator chose to reject rather than allow (#16). */
export const budgetEnforcementUnavailable = (): ProxyError =>
  new ProxyError(
    503,
    'budget enforcement unavailable',
    'api_error',
    'budget_enforcement_unavailable',
  );
export const internalError = (): ProxyError =>
  new ProxyError(500, 'internal proxy error', 'api_error', null);
/** The `/v1` request body exceeded `PROXY_MAX_BODY_BYTES` (E1.1). Raised by the
 * body parser before Nest routing, so it is rendered by the `/v1` body-parse
 * error handler in the Express chain, not the Nest exception filter. */
export const requestTooLarge = (): ProxyError =>
  new ProxyError(413, 'request body too large', 'invalid_request_error', 'request_too_large');

/** Any thrown value → a ProxyError (a #6 ProviderError maps to its kind). */
export function toProxyError(err: unknown): ProxyError {
  if (err instanceof ProxyError) return err;
  if (err instanceof ProviderCircuitOpenError)
    return serviceUnavailable('provider temporarily unavailable');
  if (err instanceof ProviderError) return providerErrorToProxy(err);
  return internalError();
}

/** Render a ProxyError as `{ status, body }` in the client's protocol shape. */
export function renderProxyError(
  err: ProxyError,
  protocol: ClientProtocol,
): { status: number; body: unknown } {
  if (protocol === 'anthropic') {
    return {
      status: err.status,
      body: { type: 'error', error: { type: err.errorType, message: err.publicMessage } },
    };
  }
  return {
    status: err.status,
    body: { error: { message: err.publicMessage, type: err.errorType, code: err.code } },
  };
}

/** Client protocol from the request path (`/v1/messages` is Anthropic;
 * tolerate a trailing slash from Express's non-strict routing). */
export function protocolForPath(path: string): ClientProtocol {
  return /\/messages\/?$/i.test(path) ? 'anthropic' : 'openai';
}
