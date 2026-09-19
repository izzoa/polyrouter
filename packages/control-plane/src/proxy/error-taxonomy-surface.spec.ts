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
    ['insufficient_funds', 502, 'upstream_credits'],
    ['content_policy', 400, 'content_filter'],
    ['policy_block', 451, 'policy_block'],
    ['permission', 403, 'upstream_permission'],
    ['upstream_rejected', 502, 'upstream_rejected'],
  ] as const)('%s → HTTP %i with code %s', (kind, status, code) => {
    const proxied = providerErrorToProxy(new ProviderError(kind, 'x'));
    expect(proxied.status).toBe(status);
    expect(proxied.code).toBe(code);
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

  it('no two new kinds share a (status, message) pair in the Anthropic shape', () => {
    const seen = NEW_KINDS.map((kind) => {
      const r = renderProxyError(providerErrorToProxy(new ProviderError(kind, 'x')), 'anthropic');
      const body = r.body as { error: { message: string } };
      return `${String(r.status)}|${body.error.message}`;
    });
    expect(new Set(seen).size).toBe(NEW_KINDS.length);
  });

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
