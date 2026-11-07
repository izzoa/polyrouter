/**
 * fix-4xx-error-taxonomy — the client-facing and operator-facing surfaces of the
 * provider-error taxonomy, driven by the CANONICAL kind array so a kind added later
 * cannot slip through with a silent default.
 *
 * `PROVIDER_MAP` is a `Record<ProviderErrorKind, …>` and so is compiler-enforced;
 * `FIXED_MESSAGE` is a `Record<string, …>` with a `?? 'provider error'` fallback and
 * is NOT — that silent-degradation path is closed here by test instead.
 */
import { PROVIDER_ERROR_KINDS, ProviderError } from '@polyrouter/data-plane';

import { toSafeProviderMessage } from '../providers/providers.service';
import { providerErrorToProxy, renderProxyError } from './proxy-errors';

describe('every taxonomy kind has a client-facing mapping', () => {
  it.each([...PROVIDER_ERROR_KINDS])('%s maps to a sane proxy error', (kind) => {
    const proxied = providerErrorToProxy(new ProviderError(kind, 'internal detail'));
    expect(proxied.status).toBeGreaterThanOrEqual(400);
    expect(proxied.publicMessage.length).toBeGreaterThan(0);
    // never leaks the upstream's own text, a request id, or a credential
    expect(proxied.publicMessage).not.toContain('internal detail');
  });

  // The statuses the reported incident turned on: a well-formed request refused for
  // credit must NOT come back as a 400 `invalid_request_error`, which is the one
  // class a well-behaved agent will never retry.
  it.each([
    ['insufficient_funds', 502, 'upstream_credits', 'api_error'],
    ['content_policy', 400, 'content_filter', 'invalid_request_error'],
    ['policy_block', 451, 'policy_block', 'invalid_request_error'],
    ['permission', 403, 'upstream_permission', 'permission_error'],
    ['upstream_rejected', 502, 'upstream_rejected', 'api_error'],
    // classify-plan-quota-errors (design D4): each plan kind takes the `type` of the
    // existing kind it shares a status and a meaning with.
    ['quota_exhausted', 429, 'plan_quota_exhausted', 'rate_limit_error'],
    ['risk_control', 429, 'plan_risk_control', 'rate_limit_error'],
    ['plan_entitlement', 403, 'plan_entitlement', 'permission_error'],
    ['plan_inactive', 502, 'plan_inactive', 'api_error'],
  ] as const)('%s → HTTP %i with code %s and type %s', (kind, status, code, type) => {
    const proxied = providerErrorToProxy(new ProviderError(kind, 'x'));
    expect(proxied.status).toBe(status);
    expect(proxied.code).toBe(code);
    expect(proxied.errorType).toBe(type);
  });

  it('an out-of-credit chain exhaustion is never a bare 400 invalid_request_error', () => {
    const proxied = providerErrorToProxy(new ProviderError('insufficient_funds', 'x'));
    expect(proxied.status).not.toBe(400);
    expect(proxied.errorType).not.toBe('invalid_request_error');
  });
});

// The Anthropic envelope renders only `error.type` and `message` — no `code` — so a
// kind whose distinction lives solely in `code` would be invisible to an Anthropic
// client. Every new kind must be separable by STATUS + MESSAGE in both shapes.
describe('both protocol envelopes carry the distinction', () => {
  const NEW_KINDS = [
    'insufficient_funds',
    'content_policy',
    'policy_block',
    'permission',
    'upstream_rejected',
    // fix-bad-request-dead-end: shares 502 with `insufficient_funds`/`auth`/
    // `upstream_rejected`, so its FIXED MESSAGE is the sole carrier of the distinction
    // in the Anthropic shape. The uniqueness assertion below is what enforces that.
    'oversized_response',
    // classify-plan-quota-errors: two of these share 429 with `rate_limit` and the 502 and
    // 403 ones share a status with existing kinds, so the fixed MESSAGE is the sole carrier
    // of the distinction in the Anthropic shape.
    'quota_exhausted',
    'risk_control',
    'plan_entitlement',
    'plan_inactive',
  ] as const;

  it.each([...NEW_KINDS])('%s is distinguishable in the Anthropic shape', (kind) => {
    const rendered = renderProxyError(
      providerErrorToProxy(new ProviderError(kind, 'x')),
      'anthropic',
    );
    const body = rendered.body as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe('error');
    expect(body.error.message.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain('code');
  });

  // Widened from the NEW_KINDS list to EVERY kind (classify-plan-quota-errors): NEW_KINDS
  // holds neither `rate_limit`, `auth` nor `unavailable`, so a plan kind could have shared
  // a status and message with one of them unnoticed.
  it('no two kinds share a (status, message) pair in the Anthropic shape', () => {
    const seen = PROVIDER_ERROR_KINDS.map((kind) => {
      const r = renderProxyError(providerErrorToProxy(new ProviderError(kind, 'x')), 'anthropic');
      const body = r.body as { error: { message: string } };
      return `${String(r.status)}|${body.error.message}`;
    });
    expect(new Set(seen).size).toBe(PROVIDER_ERROR_KINDS.length);
  });

  // Each plan kind is distinct from every kind that shares its status.
  it.each([
    ['quota_exhausted', ['rate_limit', 'risk_control']],
    ['risk_control', ['rate_limit', 'quota_exhausted']],
    ['plan_entitlement', ['permission']],
    ['plan_inactive', ['auth', 'insufficient_funds', 'upstream_rejected', 'oversized_response']],
  ] as const)('%s is distinct from the kinds sharing its status', (kind, others) => {
    const anthropic = (k: (typeof PROVIDER_ERROR_KINDS)[number]) => {
      const r = renderProxyError(providerErrorToProxy(new ProviderError(k, 'x')), 'anthropic');
      return {
        status: r.status,
        message: (r.body as { error: { message: string } }).error.message,
      };
    };
    const mine = anthropic(kind);
    for (const other of others) {
      const o = anthropic(other);
      expect(o.status).toBe(mine.status); // the comparison set really shares the status
      expect(o.message).not.toBe(mine.message);
    }
  });

  // inference-proxy scenarios "A plan's exhausted quota reaches the client as its own 429"
  // and "The other plan kinds reach the client with their own status, type and message".
  it.each([
    [
      'quota_exhausted',
      429,
      'rate_limit_error',
      'plan_quota_exhausted',
      'upstream plan usage limit reached',
    ],
    [
      'risk_control',
      429,
      'rate_limit_error',
      'plan_risk_control',
      'upstream plan throttled the account',
    ],
    [
      'plan_entitlement',
      403,
      'permission_error',
      'plan_entitlement',
      'upstream plan does not include this model',
    ],
    [
      'plan_inactive',
      502,
      'api_error',
      'plan_inactive',
      'upstream plan is not active for this key',
    ],
  ] as const)(
    '%s renders both envelopes with status %i, type %s, message and (OpenAI only) code',
    (kind, status, type, code, message) => {
      const err = new ProviderError(kind, 'provider text that must not leak', { status: 429 });
      const openai = renderProxyError(providerErrorToProxy(err), 'openai');
      expect(openai.status).toBe(status);
      expect(
        (openai.body as { error: { type: string; code: string; message: string } }).error,
      ).toEqual({ type, code, message });

      const anthropic = renderProxyError(providerErrorToProxy(err), 'anthropic');
      expect(anthropic.status).toBe(status);
      expect(anthropic.body).toEqual({ type: 'error', error: { type, message } });
      expect(JSON.stringify(anthropic.body)).not.toContain('code');
      expect(JSON.stringify(anthropic.body)).not.toContain('provider text');
    },
  );

  it('the OpenAI shape additionally carries the code', () => {
    const r = renderProxyError(
      providerErrorToProxy(new ProviderError('content_policy', 'x')),
      'openai',
    );
    expect((r.body as { error: { code: string } }).error.code).toBe('content_filter');
  });
});

describe('every taxonomy kind has an operator-facing label', () => {
  it.each([...PROVIDER_ERROR_KINDS])('%s has its own distinct message', (kind) => {
    expect(toSafeProviderMessage(kind)).not.toBe('provider error');
  });

  // classify-plan-quota-errors, provider-management "Each plan kind has its own operator
  // label": the exact wording, never the provider's own text.
  it.each([
    ['quota_exhausted', 'plan usage limit reached'],
    ['risk_control', 'provider throttled the account (risk control)'],
    ['plan_entitlement', 'plan does not include this model'],
    ['plan_inactive', 'no active plan for this key'],
  ] as const)('%s is labelled %j in the provider view', (kind, label) => {
    expect(toSafeProviderMessage(kind)).toBe(label);
  });

  it('no two kinds share a label', () => {
    const labels = PROVIDER_ERROR_KINDS.map((k) => toSafeProviderMessage(k));
    expect(new Set(labels).size).toBe(PROVIDER_ERROR_KINDS.length);
  });
});

// fix-bad-request-dead-end. The client-named path is byte-identical BY CONSTRUCTION
// (a single-element chain has no next member), so the envelope must not move — this
// is the regression guard for that claim, pinned in BOTH shapes.
describe('a client-named model’s 400 renders exactly as before', () => {
  it('OpenAI shape: 400 / invalid_request_error / code bad_request', () => {
    const r = renderProxyError(
      providerErrorToProxy(new ProviderError('bad_request', 'nope')),
      'openai',
    );
    expect(r.status).toBe(400);
    const body = r.body as { error: { type: string; code: string; message: string } };
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.code).toBe('bad_request');
  });

  it('Anthropic shape: 400 with no code rendered at all', () => {
    const r = renderProxyError(
      providerErrorToProxy(new ProviderError('bad_request', 'nope')),
      'anthropic',
    );
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain('code');
  });

  it('the transport bound is a DIFFERENT envelope — 502, not the caller’s 400', () => {
    // The one wire-visible status change in this change: an over-cap upstream body
    // used to surface as the caller's 400 and now reports the upstream failure it is.
    const r = renderProxyError(
      providerErrorToProxy(new ProviderError('oversized_response', 'over cap')),
      'openai',
    );
    expect(r.status).toBe(502);
    const body = r.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe('upstream_oversized');
    expect(body.error.message).toBe('upstream response exceeded the size limit');
    expect(body.error.message).not.toContain('bytes'); // never the cap or the body
  });
});
