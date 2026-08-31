import { ProviderError,
  PROVIDER_ERROR_KINDS,
  FUNDS_WITHHELD,
  PERMISSION_WITHHELD,
  POLICY_WITHHELD,
  VALIDATION_WITHHELD,
  captureProviderMessage,
  classifyResponse,
  classifyNetworkError,
  classifyStreamError,
  hasContentPolicyMarker,
  parseErrorEnvelope,
  shouldFallback,
  breakerImpact,
} from './errors';

describe('provider error classification', () => {
  it('maps statuses to kinds', () => {
    expect(classifyResponse(401, '').kind).toBe('auth');
    expect(classifyResponse(429, '').kind).toBe('rate_limit');
    expect(classifyResponse(400, 'bad').kind).toBe('bad_request');
    expect(classifyResponse(422, 'bad').kind).toBe('bad_request');
    expect(classifyResponse(500, '').kind).toBe('unavailable');
    expect(classifyResponse(529, '').kind).toBe('unavailable');
    expect(classifyResponse(408, '').kind).toBe('unavailable');
  });

  // fix-4xx-error-taxonomy: the whole 4xx surface, explicitly. Every status the map
  // names, plus a sample of ones it does not — the `>= 400` catch-all that made HTTP
  // 402 a client-fault `bad_request` (abandoning the chain on an out-of-credit
  // provider) is gone, and nothing may reach a classifier unexamined again.
  it.each([
    [401, 'auth'],
    [402, 'insufficient_funds'],
    [403, 'permission'],
    [405, 'unavailable'],
    [408, 'unavailable'],
    [409, 'unavailable'],
    [413, 'bad_request'],
    [415, 'unavailable'],
    [422, 'bad_request'],
    [429, 'rate_limit'],
    [451, 'policy_block'],
    // unnamed 4xx → the fallback-eligible, breaker-neutral default
    [418, 'upstream_rejected'],
    [423, 'upstream_rejected'],
    [431, 'upstream_rejected'],
    [499, 'upstream_rejected'],
  ])('maps HTTP %i to %s', (status, kind) => {
    expect(classifyResponse(status, '').kind).toBe(kind);
  });

  it('every mapped kind is a member of the canonical taxonomy', () => {
    for (const status of [400, 401, 402, 403, 404, 405, 408, 409, 410, 413, 415, 422, 429, 451, 418, 500]) {
      expect(PROVIDER_ERROR_KINDS).toContain(classifyResponse(status, '').kind);
    }
  });

  // The 402 that started this change: a well-formed request refused for credit must
  // walk the chain (another provider can serve it unchanged) and must trip, because a
  // dry account rejects EVERY request until a human tops it up.
  it('402 falls back and trips, and is never bad_request', () => {
    const err = classifyResponse(402, '{"error":{"message":"Insufficient credits"}}');
    expect(err.kind).toBe('insufficient_funds');
    expect(shouldFallback(err.kind)).toBe(true);
    expect(breakerImpact(err.kind)).toBe(true);
  });

  // 451 is the ONE non-`bad_request` walk stop: another member might well serve it,
  // and that is precisely why the router must not try (RFC 7725).
  it('451 stops the walk on principle, without tripping', () => {
    const err = classifyResponse(451, '');
    expect(err.kind).toBe('policy_block');
    expect(shouldFallback(err.kind)).toBe(false);
    expect(breakerImpact(err.kind)).toBe(false);
  });

  it('refines 404 by body: model-not-found vs wrong path', () => {
    expect(classifyResponse(404, 'The model `gpt-x` does not exist').kind).toBe('unknown_model');
    expect(
      classifyResponse(404, '{"error":{"type":"not_found_error","message":"model not found"}}')
        .kind,
    ).toBe('unknown_model');
    expect(classifyResponse(404, 'Cannot POST /v1/wrong').kind).toBe('unavailable');
  });

  // 410 reuses 404's rule verbatim — narrowing the shared helper would silently
  // change 404's own classification, which is out of scope for this change.
  it('refines 410 by body exactly as 404, leaving 404 byte-identical', () => {
    expect(classifyResponse(410, 'The model `gpt-x` does not exist').kind).toBe('unknown_model');
    expect(classifyResponse(410, 'Cannot POST /v1/wrong').kind).toBe('unavailable');
    // the 404 cases above must be unchanged by the shared refinement
    expect(classifyResponse(404, 'The model `gpt-x` does not exist').kind).toBe('unknown_model');
    expect(classifyResponse(404, 'Cannot POST /v1/wrong').kind).toBe('unavailable');
  });

  it('maps network/timeout faults to unavailable', () => {
    expect(classifyNetworkError(new Error('ECONNRESET')).kind).toBe('unavailable');
    expect(classifyNetworkError(new Error('socket hang up')).kind).toBe('unavailable');
    const withCode = Object.assign(new Error('x'), { code: 'ECONNREFUSED' });
    expect(classifyNetworkError(withCode).kind).toBe('unavailable');
  });

  // The 403 bug, at the classifier. Every provider protocol polyrouter targets uses
  // 401 for a bad credential and 403 for a permission decision, so reading 403 as
  // `auth` opened the breaker on providers that were answering every other request.
  describe('the 401/403 split (fix-4xx-error-taxonomy)', () => {
    it.each([
      ['a plain permission denial', '{"error":{"message":"no access to this model"}}', 'permission'],
      ['an HTML body', '<html>403 Forbidden</html>', 'permission'],
      ['an empty body', '', 'permission'],
      ['type=content_filter', '{"error":{"type":"content_filter"}}', 'content_policy'],
      [
        'code=content_filter on a generic type',
        '{"error":{"type":"error","code":"content_filter"}}',
        'content_policy',
      ],
      [
        'a marker only in nested classification metadata',
        '{"error":{"type":"error","metadata":{"error_type":"moderation"}}}',
        'content_policy',
      ],
    ])('403 with %s → %s, and never trips', (_label, body, expected) => {
      const err = classifyResponse(403, body);
      expect(err.kind).toBe(expected);
      expect(shouldFallback(err.kind)).toBe(true);
      expect(breakerImpact(err.kind)).toBe(false);
    });

    it('no 403 body can produce auth; only 401 does, and it still trips', () => {
      for (const body of ['', 'invalid api key', '{"error":{"type":"authentication_error"}}']) {
        expect(classifyResponse(403, body).kind).not.toBe('auth');
      }
      const err = classifyResponse(401, '');
      expect(err.kind).toBe('auth');
      expect(breakerImpact(err.kind)).toBe(true);
    });
  });

  it('separates fallback eligibility from breaker impact (§7.4)', () => {
    // unknown_model falls back but must NOT open the provider breaker
    expect(shouldFallback('unknown_model')).toBe(true);
    expect(breakerImpact('unknown_model')).toBe(false);
    // bad_request: neither
    expect(shouldFallback('bad_request')).toBe(false);
    expect(breakerImpact('bad_request')).toBe(false);
    // tripping kinds
    for (const k of ['rate_limit', 'unavailable', 'auth'] as const) {
      expect(shouldFallback(k)).toBe(true);
      expect(breakerImpact(k)).toBe(true);
    }
    // credential (add-subscription-oauth): a revoked OAuth grant / IdP outage falls
    // back to the next chain member but is breaker-NEUTRAL — credential state is not
    // upstream provider health.
    expect(shouldFallback('credential')).toBe(true);
    expect(breakerImpact('credential')).toBe(false);
  });

  // Exhaustive by construction: driven by the canonical array, so a kind added later
  // without a deliberate decision fails here rather than silently inheriting a default.
  it('shouldFallback is false for exactly two kinds, for two different reasons', () => {
    const stops = PROVIDER_ERROR_KINDS.filter((k) => !shouldFallback(k));
    expect([...stops].sort()).toEqual(['bad_request', 'policy_block']);
  });

  it('breakerImpact trips for exactly the provider-wide conditions', () => {
    const trips = PROVIDER_ERROR_KINDS.filter((k) => breakerImpact(k));
    expect([...trips].sort()).toEqual(
      ['auth', 'insufficient_funds', 'rate_limit', 'unavailable'].sort(),
    );
    // the regression guard for the reported bug: a permission denial — the common,
    // marker-free 403 shape — must never disable a provider that is answering
    expect(breakerImpact('permission')).toBe(false);
    expect(breakerImpact('content_policy')).toBe(false);
    expect(breakerImpact('policy_block')).toBe(false);
    expect(breakerImpact('upstream_rejected')).toBe(false);
  });

  it('classifies streamed error events by type', () => {
    expect(classifyStreamError('overloaded_error')).toBe('unavailable');
    expect(classifyStreamError('rate_limit_error')).toBe('rate_limit');
    expect(classifyStreamError('authentication_error')).toBe('auth');
    expect(classifyStreamError('invalid_request_error')).toBe('bad_request');
    expect(classifyStreamError('not_found_error')).toBe('unknown_model');
  });

  // The in-band twin of the HTTP map. `quota` deliberately stays with `rate` (it is
  // ambiguous between a rate quota and a credit quota), and auth/permission must NOT
  // re-merge — collapsing them would trip the breaker for the same wrong reason 403 did.
  it.each([
    ['overloaded_error', 'unavailable'],
    ['api_error', 'unavailable'],
    ['rate_limit_error', 'rate_limit'],
    ['insufficient_quota', 'rate_limit'],
    ['authentication_error', 'auth'],
    ['permission_error', 'permission'],
    ['forbidden', 'permission'],
    ['content_filter', 'content_policy'],
    ['moderation_blocked', 'content_policy'],
    ['insufficient_credits', 'insufficient_funds'],
    ['billing_error', 'insufficient_funds'],
    ['payment_required', 'insufficient_funds'],
    ['not_found_error', 'unknown_model'],
    ['invalid_request_error', 'bad_request'],
  ])('streamed %s classifies as %s', (raw, kind) => {
    expect(classifyStreamError(raw)).toBe(kind);
  });

  it('a streamed permission error falls back without tripping', () => {
    const kind = classifyStreamError('permission_error');
    expect(shouldFallback(kind)).toBe(true);
    expect(breakerImpact(kind)).toBe(false);
  });

  it('never embeds oversized bodies', () => {
    const big = 'x'.repeat(10_000);
    expect(classifyResponse(400, big).message.length).toBeLessThan(400);
  });
});

// add-subscription-oauth (codex round 3): the breaker OUTCOME for a credential failure
// is strictly neutral — never 'success' (which would erase genuine failure counts or
// close a half-open probe) and never 'trip'.
import { outcomeForError } from './breaker';

describe('breaker outcome for credential failures', () => {
  it('credential errors settle as neutral, not success or trip', () => {
    expect(outcomeForError(new ProviderError('credential', 'revoked'))).toBe('neutral');
    expect(outcomeForError(new ProviderError('unavailable', 'down'))).toBe('trip');
    expect(outcomeForError(new ProviderError('unknown_model', 'gone'))).toBe('success');
  });

  // fix-4xx-error-taxonomy: non-tripping is TWO outcomes, not one. An unclassifiable
  // response proves nothing about upstream health, so settling it `success` would let
  // it erase a provider's real failure history — the same reasoning `credential` uses.
  it('upstream_rejected is strictly neutral, never a health success', () => {
    expect(outcomeForError(new ProviderError('upstream_rejected', '418'))).toBe('neutral');
  });

  // These three PROVE the provider answered, so they settle success exactly as
  // `bad_request` already does — a working provider that refused one request.
  it.each(['permission', 'content_policy', 'policy_block'] as const)(
    '%s settles as a health success',
    (kind) => {
      expect(outcomeForError(new ProviderError(kind, 'refused'))).toBe('success');
    },
  );

  it('402 trips: a dry account rejects every request until a human acts', () => {
    expect(outcomeForError(new ProviderError('insufficient_funds', 'no credit'))).toBe('trip');
  });
});

// fix-4xx-error-taxonomy. Invariant 8 is the acceptance criterion here, NOT
// diagnosability: the KIND carries the operator's diagnosis, and the body is never
// trusted to be free of echoed prompt content for a status whose semantics no
// provider guarantees.
describe('message policy for the new kinds', () => {
  const capture = (kind: Parameters<typeof captureProviderMessage>[1]['kind'], body: string) =>
    captureProviderMessage(
      { source: 'parsed-envelope', envelope: parseErrorEnvelope(body) },
      { kind, secrets: ['sk-live-SECRET'] },
    );

  it.each([
    ['insufficient_funds', FUNDS_WITHHELD],
    ['permission', PERMISSION_WITHHELD],
    ['upstream_rejected', VALIDATION_WITHHELD],
    ['content_policy', POLICY_WITHHELD],
    ['policy_block', POLICY_WITHHELD],
  ] as const)('%s withholds under its own marker', (kind, marker) => {
    expect(capture(kind, '{"error":{"message":"anything at all"}}')).toBe(marker);
  });

  // Unconditional, not best-effort: no configured credential, opaque token, or
  // echoed prompt survives, whatever the body contains.
  it.each(['insufficient_funds', 'permission'] as const)(
    '%s withholding is unconditional — no credential, token, or prompt echo escapes',
    (kind) => {
      const hostile = JSON.stringify({
        error: {
          message:
            'sk-live-SECRET rejected. Submitted prompt was: "the patient record for Jane" ' +
            'token=abcdefghijklmnopqrstuvwxyz0123456789',
        },
      });
      const out = capture(kind, hostile);
      expect(out).toBe(kind === 'permission' ? PERMISSION_WITHHELD : FUNDS_WITHHELD);
      expect(out).not.toContain('sk-live-SECRET');
      expect(out).not.toContain('Jane');
      expect(out).not.toContain('abcdefghij');
    },
  );

  it('operational kinds still persist verbatim (unchanged)', () => {
    expect(capture('unavailable', '{"error":{"message":"upstream down"}}')).toBe('upstream down');
  });

  it('the marker predicate is the ONE signal, and reads nested metadata', () => {
    expect(hasContentPolicyMarker(parseErrorEnvelope('{"error":{"type":"content_filter"}}'))).toBe(
      true,
    );
    expect(
      hasContentPolicyMarker(
        parseErrorEnvelope('{"error":{"type":"error","metadata":{"error_type":"moderation"}}}'),
      ),
    ).toBe(true);
    expect(hasContentPolicyMarker(parseErrorEnvelope('{"error":{"type":"error"}}'))).toBe(false);
    expect(hasContentPolicyMarker(parseErrorEnvelope('not json'))).toBe(false);
  });
});
