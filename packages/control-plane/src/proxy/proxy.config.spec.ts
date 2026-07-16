// E1.4: the proxy config schema (defaults, coercion, validation) and the pure
// bounds derivation — core's first/inter-event bound is always the adapter
// first-byte bound + a strictly positive margin, so the adapter's typed
// `unavailable` timeout wins a pre-headers race (E1.3).
import { proxyConfigSchema, resolveProxyBounds, type ProxyRawConfig } from './proxy.config';

const raw = (over: Partial<ProxyRawConfig> = {}): ProxyRawConfig => ({
  PROXY_MAX_BODY_BYTES: 10_485_760,
  PROXY_FIRST_EVENT_TIMEOUT_MS: 30_000,
  PROXY_EVENT_TIMEOUT_MARGIN_MS: 500,
  ...over,
});

describe('proxyConfigSchema', () => {
  it('applies the current defaults when nothing is set', () => {
    expect(proxyConfigSchema.parse({})).toEqual({
      PROXY_MAX_BODY_BYTES: 10_485_760,
      PROXY_FIRST_EVENT_TIMEOUT_MS: 30_000,
      PROXY_EVENT_TIMEOUT_MARGIN_MS: 500,
    });
  });

  it('coerces string env values to numbers', () => {
    const c = proxyConfigSchema.parse({
      PROXY_MAX_BODY_BYTES: '1048576',
      PROXY_FIRST_EVENT_TIMEOUT_MS: '120000',
      PROXY_EVENT_TIMEOUT_MARGIN_MS: '250',
    });
    expect(c).toEqual({
      PROXY_MAX_BODY_BYTES: 1_048_576,
      PROXY_FIRST_EVENT_TIMEOUT_MS: 120_000,
      PROXY_EVENT_TIMEOUT_MARGIN_MS: 250,
    });
  });

  it('rejects a zero/negative margin (core bound must stay above the adapter bound)', () => {
    expect(() => proxyConfigSchema.parse({ PROXY_EVENT_TIMEOUT_MARGIN_MS: '0' })).toThrow();
    expect(() => proxyConfigSchema.parse({ PROXY_EVENT_TIMEOUT_MARGIN_MS: '-1' })).toThrow();
  });

  it('rejects a non-positive or timer-overflowing first-event timeout', () => {
    expect(() => proxyConfigSchema.parse({ PROXY_FIRST_EVENT_TIMEOUT_MS: '0' })).toThrow();
    expect(() => proxyConfigSchema.parse({ PROXY_FIRST_EVENT_TIMEOUT_MS: '999999999' })).toThrow(); // > 1h cap
  });

  it('rejects a non-positive body limit', () => {
    expect(() => proxyConfigSchema.parse({ PROXY_MAX_BODY_BYTES: '0' })).toThrow();
  });
});

describe('resolveProxyBounds', () => {
  it('keeps the current defaults and derives the +margin core bound', () => {
    const b = resolveProxyBounds(raw());
    expect(b.firstByteTimeoutMs).toBe(30_000);
    expect(b.firstEventTimeoutMs).toBe(30_500);
    expect(b.maxBodyBytes).toBe(10_485_760);
  });

  it('core first/inter-event bound is always strictly above the adapter first-byte bound', () => {
    const b = resolveProxyBounds(raw({ PROXY_FIRST_EVENT_TIMEOUT_MS: 120_000 }));
    expect(b.firstByteTimeoutMs).toBe(120_000);
    expect(b.firstEventTimeoutMs).toBe(120_500);
    expect(b.firstEventTimeoutMs).toBeGreaterThan(b.firstByteTimeoutMs);
  });
});
