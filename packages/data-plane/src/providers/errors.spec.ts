import {
  ProviderError,
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
    for (const status of [
      400, 401, 402, 403, 404, 405, 408, 409, 410, 413, 415, 422, 429, 451, 418, 500,
    ]) {
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
      [
        'a plain permission denial',
        '{"error":{"message":"no access to this model"}}',
        'permission',
      ],
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
    // bad_request (fix-bad-request-dead-end): the two classifiers moved INDEPENDENTLY.
    // It is now fallback-eligible — a 400 describes the model the router chose — while
    // its breaker treatment is unchanged: a provider that rejects a request answered.
    expect(shouldFallback('bad_request')).toBe(true);
    expect(breakerImpact('bad_request')).toBe(false);
    // oversized_response: the kind that now carries the no-fallback guarantee, and the
    // ONLY non-tripping kind here that is also breaker-neutral rather than a success.
    expect(shouldFallback('oversized_response')).toBe(false);
    expect(breakerImpact('oversized_response')).toBe(false);
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
  it('shouldFallback is false for exactly the kinds that own a reason to stop', () => {
    const stops = PROVIDER_ERROR_KINDS.filter((k) => !shouldFallback(k));
    expect([...stops].sort()).toEqual(['oversized_response', 'policy_block']);
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
import { outcomeForError, outcomeForKind } from './breaker';

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

  // fix-bad-request-dead-end: an over-cap body proves the provider sent bytes, not that
  // it is healthy. A 'success' would CLOSE a half-open probe (handing a flooding
  // upstream full production traffic) or zero a closed record's accumulated failures.
  it('oversized_response is strictly neutral, never a health success', () => {
    expect(outcomeForError(new ProviderError('oversized_response', 'over cap'))).toBe('neutral');
  });

  // Exhaustive by construction over the OUTCOME partition, not just the trip set: this
  // is the guard whose absence let `oversized_response` silently inherit 'success'
  // (fix-bad-request-dead-end). A kind added later lands in a branch deliberately.
  it('outcomeForKind partitions the taxonomy exhaustively', () => {
    const by = (o: string) =>
      [...PROVIDER_ERROR_KINDS.filter((k) => outcomeForKind(k) === o)].sort();
    expect(by('trip')).toEqual(['auth', 'insufficient_funds', 'rate_limit', 'unavailable']);
    expect(by('neutral')).toEqual(['credential', 'oversized_response', 'upstream_rejected']);
    expect(by('success')).toEqual([
      'bad_request',
      'content_policy',
      'permission',
      'policy_block',
      'unknown_model',
    ]);
    // total: every kind lands in exactly one branch
    expect(by('trip').length + by('neutral').length + by('success').length).toBe(
      PROVIDER_ERROR_KINDS.length,
    );
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

// ---------------------------------------------------------------------------
// fix-bad-request-dead-end — marker retention behind three gates.
// Invariant 8 is the acceptance criterion: the KIND and the retained CLASSIFICATION
// carry the operator's diagnosis, and provider-authored prose never reaches storage.
// ---------------------------------------------------------------------------
import {
  retainMarkers,
  scrubSecrets,
  MAX_RETAINED_MARKERS,
  MAX_RETAINED_MARKER_BYTES,
} from './errors';

describe('marker retention — gate 2 (per-candidate scrub, then shape)', () => {
  it('admits an identifier and drops prose', () => {
    expect(retainMarkers(['context_length_exceeded'])).toEqual(['context_length_exceeded']);
    // Echoed prompt content is prose: spaces and punctuation fail the shape.
    expect(retainMarkers(['Your message at messages[3] was invalid, sorry.'])).toEqual([]);
  });

  it('drops an over-length token whole rather than truncating it', () => {
    const long = 'a'.repeat(65); // one past the 64-char shape bound
    expect(retainMarkers([long])).toEqual([]);
  });

  it('scrubs each candidate on its OWN before shaping — a whole credential never lands', () => {
    // The value's start is a word boundary, so the heuristic matches here even though
    // it would not match inside a seamless join. This is the pass gate 3 cannot replace.
    expect(retainMarkers(['sk-proj-abc12345678'])).toEqual([]);
    expect(retainMarkers(['error', 'sk-proj-abc12345678'])).toEqual(['error']);
  });

  it('dedupes and preserves order', () => {
    expect(retainMarkers(['a', 'b', 'a', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('bounds the set by count and by total bytes, dropping whole values', () => {
    const many = Array.from({ length: 20 }, (_v, i) => `k${String(i)}`);
    expect(retainMarkers(many)).toHaveLength(MAX_RETAINED_MARKERS);
    const chunky = Array.from({ length: 8 }, (_v, i) => `${String(i)}${'x'.repeat(60)}`);
    const kept = retainMarkers(chunky);
    const bytes = kept.reduce((n, m) => n + Buffer.byteLength(m, 'utf8'), 0);
    expect(bytes).toBeLessThanOrEqual(MAX_RETAINED_MARKER_BYTES);
    for (const m of kept) expect(m).toHaveLength(61); // never a cut-down fragment
  });
});

describe('marker retention — gate 3 (scrub every suffix join)', () => {
  const SECRET = 'sk-abc12345678';

  it('drops the WHOLE set when a configured credential is split across two values', () => {
    // Neither fragment matches alone; a seamless join reconstructs it. Configured
    // secrets are matched by boundary-free substring replacement, so position does
    // not matter for THESE — the suffix sweep exists for the heuristic path below.
    expect(retainMarkers(['sk-abc123', '45678'], [SECRET])).toEqual([]);
    expect(retainMarkers(['error', 'sk-abc123', '45678'], [SECRET])).toEqual([]);
  });

  it('keeps an unrelated error’s markers — the drop is per-error, not global', () => {
    expect(retainMarkers(['rate_limit_exceeded'], [SECRET])).toEqual(['rate_limit_exceeded']);
  });

  // THE round-3 counterexample, and the reason this gate sweeps suffixes instead of
  // joining once. Note it is the HEURISTIC path (an UNCONFIGURED key-shaped token — a
  // caller's own key echoed by an aggregator): a CONFIGURED secret is matched by
  // boundary-free substring replacement, so a single join would already catch it.
  // Here the split fragment follows a word character, which defeats the per-candidate
  // pass (fragments too short to match), the single whole-set join
  // (`errorsk-abc12345678` — no \b before `sk`) AND a space-delimited join. Only the
  // suffix at i=1 restores the string-start boundary. Do not simplify this away.
  it('catches a split key-shaped token preceded by a word-char-ending value', () => {
    const all = ['error', 'sk-abc123', '45678'];
    expect(retainMarkers(all)).toEqual([]);
    // prove the weaker forms really do miss it, so the test documents WHY
    expect(all.every((c) => scrubSecrets(c) === c)).toBe(true); // per-candidate
    expect(scrubSecrets(all.join(''))).toBe(all.join('')); // single whole-set join
    expect(scrubSecrets(all.join(' '))).toBe(all.join(' ')); // round-2's proposed remedy
    // and the suffix that does catch it
    expect(scrubSecrets(all.slice(1).join(''))).not.toBe(all.slice(1).join(''));
  });
});

describe('marker retention — gate 1 (named source) and classification independence', () => {
  const body = (o: unknown) => JSON.stringify(o);

  it('retains a named metadata key and never an unnamed one', () => {
    const withNamed = classifyResponse(
      400,
      body({ error: { message: 'x', metadata: { error_type: 'context_length_exceeded' } } }),
    );
    expect(withNamed.markers).toContain('context_length_exceeded');
    const withUnnamed = classifyResponse(
      400,
      body({ error: { message: 'x', metadata: { raw_upstream: 'looks_like_an_identifier' } } }),
    );
    expect(withUnnamed.markers ?? []).not.toContain('looks_like_an_identifier');
  });

  it('a policy marker under an UNNAMED metadata key is still DETECTED', () => {
    // Detection and retention read deliberately different sources: the broad sweep
    // still decides the 403 refinement even where the value may not be persisted.
    const err = classifyResponse(
      403,
      body({ error: { metadata: { anything: 'content_filter' } } }),
    );
    expect(err.kind).toBe('content_policy');
  });

  it('retention is uniform across kinds', () => {
    for (const [status, expected] of [
      [400, 'bad_request'],
      [403, 'permission'],
      [429, 'rate_limit'],
      [503, 'unavailable'],
    ] as const) {
      const err = classifyResponse(status, body({ error: { code: 'some_code', message: 'm' } }));
      expect(err.kind).toBe(expected);
      expect(err.markers).toEqual(['some_code']);
    }
  });

  it('markers never change kind, shouldFallback or breakerImpact', () => {
    const bare = classifyResponse(400, body({ error: { message: 'm' } }));
    const marked = classifyResponse(400, body({ error: { code: 'ctx_len', message: 'm' } }));
    expect(marked.kind).toBe(bare.kind);
    expect(shouldFallback(marked.kind)).toBe(shouldFallback(bare.kind));
    expect(breakerImpact(marked.kind)).toBe(breakerImpact(bare.kind));
  });

  it('a withheld message still leaves the classification readable', () => {
    const err = classifyResponse(
      400,
      body({ error: { code: 'context_length_exceeded', message: 'your prompt said: hello bob' } }),
    );
    expect(err.providerMessage).toBe(VALIDATION_WITHHELD);
    expect(err.markers).toEqual(['context_length_exceeded']);
  });
});
