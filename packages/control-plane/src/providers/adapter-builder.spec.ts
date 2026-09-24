// add-batch-inference task 2.5: the ONE adapter builder — credential decrypt,
// OAuth resolution, SSRF gate, quirks, bounds — with fixed, secret-free failures.
import { encryptSecret, userPrincipal, type ProviderRow } from '@polyrouter/shared/server';
import type { SubscriptionOauthService } from '../subscription-oauth/subscription-oauth.service';
import { AdapterBuildError, ProviderAdapterBuilder } from './adapter-builder';

const KEY = 'ab'.repeat(32); // 32 bytes of hex — the encryption key format
const principal = userPrincipal('u1');

function row(over: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id: 'p1',
    ownerUserId: 'u1',
    orgId: null,
    name: 'Prov',
    kind: 'api_key',
    protocol: 'openai_compatible',
    baseUrl: 'https://api.openai.com/v1',
    encryptedCredentials: encryptSecret('sk-live-SECRET', KEY),
    status: 'ok',
    maxTokensSpelling: 'auto',
    oauthPreset: null,
    credentialExpiresAt: null,
    credentialError: null,
    firstByteTimeoutMs: null,
    idleTimeoutMs: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    ...over,
  } as ProviderRow;
}

function builder(
  resolveCredential: SubscriptionOauthService['resolveCredential'] = () =>
    Promise.reject(new Error('oauth seam not expected')),
  mode: 'selfhosted' | 'cloud' = 'cloud',
): ProviderAdapterBuilder {
  return new ProviderAdapterBuilder({ key: KEY, mode }, {
    resolveCredential,
  } as unknown as SubscriptionOauthService);
}

const opts = { defaultMaxOutputTokens: 4096 };

describe('ProviderAdapterBuilder', () => {
  it('decrypts a plain credential and threads quirks, bounds, mode and the default cap', async () => {
    const bounds = { firstByteTimeoutMs: 1_000, idleTimeoutMs: 2_000, streamEventTimeoutMs: 1_500 };
    const cfg = await builder().buildConfig(
      principal,
      row({ maxTokensSpelling: 'max_completion_tokens' }),
      { defaultMaxOutputTokens: 512, bounds },
    );
    expect(cfg).toMatchObject({
      protocol: 'openai_compatible',
      baseUrl: 'https://api.openai.com/v1',
      credential: 'sk-live-SECRET',
      kind: 'api_key',
      mode: 'cloud',
      defaultMaxOutputTokens: 512,
      ...bounds,
    });
    expect(cfg.quirks).toBeDefined();
    expect(cfg.authScheme).toBeUndefined(); // api-key default: every existing caller unchanged
  });

  it('resolves a subscription provider through the OAuth seam (refresh path) and threads its scheme', async () => {
    const resolve = jest.fn(() =>
      Promise.resolve({
        credential: 'oauth-ACCESS',
        authScheme: 'oauth_bearer' as const,
        envelope: 'stored-cipher',
        oauthBeta: 'oauth-2025-04-20',
        probeModel: 'claude-x',
      }),
    );
    const cfg = await builder(resolve).buildConfig(
      principal,
      row({
        kind: 'subscription',
        protocol: 'anthropic_compatible',
        baseUrl: 'https://api.anthropic.com',
      }),
      opts,
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(cfg).toMatchObject({
      credential: 'oauth-ACCESS',
      authScheme: 'oauth_bearer',
      oauthBeta: 'oauth-2025-04-20',
      probeModel: 'claude-x',
      kind: 'subscription',
    });
  });

  it('lets a credential-kind OAuth failure pass through untouched (breaker-neutral, fallback-eligible)', async () => {
    const boom = new Error('reauthorize required');
    await expect(
      builder(() => Promise.reject(boom)).buildConfig(
        principal,
        row({ kind: 'subscription' }),
        opts,
      ),
    ).rejects.toBe(boom);
  });

  it('refuses a private address at build with a fixed message, and skips the gate only when told to', async () => {
    const privateRow = row({ baseUrl: 'http://10.0.0.1/v1' });
    const err = await builder()
      .buildConfig(principal, privateRow, opts)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterBuildError);
    expect((err as AdapterBuildError).reason).toBe('address_rejected');
    expect((err as Error).message).toBe('provider address rejected');
    // The management path keeps its call-time semantics: no build-time gate.
    const cfg = await builder().buildConfig(principal, privateRow, {
      ...opts,
      assertAddress: false,
    });
    expect(cfg.baseUrl).toBe('http://10.0.0.1/v1');
  });

  it('a loopback local provider builds only under MODE=selfhosted, credential-less', async () => {
    const local = row({
      kind: 'local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      encryptedCredentials: null,
    });
    const cfg = await builder(undefined, 'selfhosted').buildConfig(principal, local, opts);
    expect(cfg.credential).toBe('');
    await expect(
      builder(undefined, 'cloud').buildConfig(principal, local, opts),
    ).rejects.toMatchObject({
      reason: 'address_rejected',
    });
  });

  it('names a missing base_url or credential with a fixed reason', async () => {
    await expect(
      builder().buildConfig(principal, row({ baseUrl: null }), opts),
    ).rejects.toMatchObject({
      reason: 'no_base_url',
      message: 'provider has no base_url',
    });
    await expect(
      builder().buildConfig(principal, row({ encryptedCredentials: null }), opts),
    ).rejects.toMatchObject({ reason: 'no_credential', message: 'provider has no credential' });
  });

  it('never puts the credential, the key, or the URL into a failure message', async () => {
    const failures: unknown[] = [];
    for (const r of [
      row({ baseUrl: null }),
      row({ encryptedCredentials: null }),
      row({ baseUrl: 'http://169.254.169.254/x' }),
    ]) {
      failures.push(
        await builder()
          .buildConfig(principal, r, opts)
          .catch((e: unknown) => e),
      );
    }
    for (const f of failures) {
      const text = (f as Error).message;
      expect(text).not.toMatch(/SECRET|abababab|169\.254|10\.0\.0/);
    }
  });

  // add-provider-health-signals (task 3.1): the envelope the build ACTUALLY used
  // comes back beside the config — never inside it.
  describe('buildConfigWithCredential', () => {
    it('reports the envelope a lazy refresh just wrote, not the row the caller loaded', async () => {
      const loaded = row({
        kind: 'subscription',
        protocol: 'anthropic_compatible',
        baseUrl: 'https://api.anthropic.com',
        encryptedCredentials: 'poly-enc:v1:OLD-CIPHER',
      });
      const resolve = jest.fn(() =>
        Promise.resolve({
          credential: 'oauth-FRESH',
          authScheme: 'oauth_bearer' as const,
          envelope: 'poly-enc:v1:NEW-CIPHER', // written by the refresh inside the build
        }),
      );
      const built = await builder(resolve).buildConfigWithCredential(principal, loaded, opts);
      expect(built.usedEnvelope).toBe('poly-enc:v1:NEW-CIPHER');
      expect(built.config.credential).toBe('oauth-FRESH');
    });

    it('reports the stored envelope for a plain credential and null for a keyless local provider', async () => {
      const plain = row();
      expect((await builder().buildConfigWithCredential(principal, plain, opts)).usedEnvelope).toBe(
        plain.encryptedCredentials,
      );
      const local = row({
        kind: 'local',
        baseUrl: 'http://127.0.0.1:11434/v1',
        encryptedCredentials: null,
      });
      expect(
        (await builder(undefined, 'selfhosted').buildConfigWithCredential(principal, local, opts))
          .usedEnvelope,
      ).toBeNull();
    });

    it('never places the envelope in the adapter config', async () => {
      const envelope = 'poly-enc:v1:MUST-NOT-LEAK';
      const oauth = await builder(() =>
        Promise.resolve({ credential: 'tok', authScheme: 'oauth_bearer' as const, envelope }),
      ).buildConfigWithCredential(
        principal,
        row({
          kind: 'subscription',
          protocol: 'anthropic_compatible',
          baseUrl: 'https://api.anthropic.com',
        }),
        opts,
      );
      expect(JSON.stringify(oauth.config)).not.toContain('MUST-NOT-LEAK');
      const plain = await builder().buildConfigWithCredential(principal, row(), opts);
      expect(JSON.stringify(plain.config)).not.toContain(plain.usedEnvelope!);
    });
  });
});
