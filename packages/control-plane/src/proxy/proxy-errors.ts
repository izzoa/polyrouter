/**
 * Protocol-shaped, sanitized proxy errors (#10, spec §6.1). Every `/v1` failure
 * is rendered as a fixed message in the caller's own envelope — never the raw
 * upstream body, request id, or credential.
 */
import { ProviderError, type ProviderErrorKind, type RouteErrorKind } from '@polyrouter/data-plane';

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
export const internalError = (): ProxyError =>
  new ProxyError(500, 'internal proxy error', 'api_error', null);

/** Any thrown value → a ProxyError (a #6 ProviderError maps to its kind). */
export function toProxyError(err: unknown): ProxyError {
  if (err instanceof ProxyError) return err;
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
  return /\/messages\/?$/.test(path) ? 'anthropic' : 'openai';
}
