import { resolveCredentialKey, type ProvidersConfig } from './providers.config';

type Base = Parameters<typeof resolveCredentialKey>[1];
const REAL = 'a'.repeat(64);
const DEV_KEY = 'de'.repeat(32);

describe('resolveCredentialKey gating', () => {
  it('returns the provided key regardless of environment', () => {
    const cfg: ProvidersConfig = { PROVIDER_CREDENTIAL_KEY: REAL };
    const base: Base = { NODE_ENV: 'production', MODE: 'cloud', BIND_ADDRESS: '0.0.0.0' };
    expect(resolveCredentialKey(cfg, base)).toBe(REAL);
  });

  it('uses the dev fallback ONLY on a loopback-bound non-production self-host', () => {
    const base: Base = { NODE_ENV: 'development', MODE: 'selfhosted', BIND_ADDRESS: '127.0.0.1' };
    expect(resolveCredentialKey({}, base)).toBe(DEV_KEY);
  });

  it('requires a real key when network-reachable, cloud, or production', () => {
    const cases: Base[] = [
      { NODE_ENV: 'development', MODE: 'selfhosted', BIND_ADDRESS: '0.0.0.0' },
      { NODE_ENV: 'development', MODE: 'cloud', BIND_ADDRESS: '127.0.0.1' },
      { NODE_ENV: 'production', MODE: 'selfhosted', BIND_ADDRESS: '127.0.0.1' },
    ];
    for (const base of cases) {
      expect(() => resolveCredentialKey({}, base)).toThrow(/PROVIDER_CREDENTIAL_KEY is required/);
    }
  });

  it('never echoes key material in the error', () => {
    const base: Base = { NODE_ENV: 'production', MODE: 'cloud', BIND_ADDRESS: '0.0.0.0' };
    try {
      resolveCredentialKey({}, base);
      throw new Error('should have thrown');
    } catch (err) {
      expect(String((err as Error).message)).not.toContain(DEV_KEY);
    }
  });
});
