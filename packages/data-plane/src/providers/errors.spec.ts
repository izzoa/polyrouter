import {
  classifyResponse,
  classifyNetworkError,
  classifyStreamError,
  shouldFallback,
  breakerImpact,
} from './errors';

describe('provider error classification', () => {
  it('maps statuses to kinds', () => {
    expect(classifyResponse(401, '').kind).toBe('auth');
    expect(classifyResponse(403, '').kind).toBe('auth');
    expect(classifyResponse(429, '').kind).toBe('rate_limit');
    expect(classifyResponse(400, 'bad').kind).toBe('bad_request');
    expect(classifyResponse(422, 'bad').kind).toBe('bad_request');
    expect(classifyResponse(500, '').kind).toBe('unavailable');
    expect(classifyResponse(529, '').kind).toBe('unavailable');
    expect(classifyResponse(408, '').kind).toBe('unavailable');
  });

  it('refines 404 by body: model-not-found vs wrong path', () => {
    expect(classifyResponse(404, 'The model `gpt-x` does not exist').kind).toBe('unknown_model');
    expect(
      classifyResponse(404, '{"error":{"type":"not_found_error","message":"model not found"}}')
        .kind,
    ).toBe('unknown_model');
    expect(classifyResponse(404, 'Cannot POST /v1/wrong').kind).toBe('unavailable');
  });

  it('maps network/timeout faults to unavailable', () => {
    expect(classifyNetworkError(new Error('ECONNRESET')).kind).toBe('unavailable');
    expect(classifyNetworkError(new Error('socket hang up')).kind).toBe('unavailable');
    const withCode = Object.assign(new Error('x'), { code: 'ECONNREFUSED' });
    expect(classifyNetworkError(withCode).kind).toBe('unavailable');
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
  });

  it('classifies streamed error events by type', () => {
    expect(classifyStreamError('overloaded_error')).toBe('unavailable');
    expect(classifyStreamError('rate_limit_error')).toBe('rate_limit');
    expect(classifyStreamError('authentication_error')).toBe('auth');
    expect(classifyStreamError('invalid_request_error')).toBe('bad_request');
    expect(classifyStreamError('not_found_error')).toBe('unknown_model');
  });

  it('never embeds oversized bodies', () => {
    const big = 'x'.repeat(10_000);
    expect(classifyResponse(400, big).message.length).toBeLessThan(400);
  });
});
