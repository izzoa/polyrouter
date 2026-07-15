import { describe, expect, it } from 'vitest';
import { assertAppriseTargetSafe, SsrfError, type NetworkHostOptions } from '../src/server';

const resolveTo =
  (map: Record<string, string> | string) =>
  (host: string): Promise<string[]> =>
    Promise.resolve([typeof map === 'string' ? map : (map[host] ?? '1.1.1.1')]);

const publicOpts = (): NetworkHostOptions => ({ mode: 'cloud', resolve: resolveTo('1.1.1.1') });

describe('assertAppriseTargetSafe (#15a)', () => {
  it('allows fixed public-service schemes without resolving a user host', async () => {
    await expect(
      assertAppriseTargetSafe('discord://id/token', publicOpts()),
    ).resolves.toBeUndefined();
    await expect(
      assertAppriseTargetSafe('tgram://bottoken/chatid', publicOpts()),
    ).resolves.toBeUndefined();
    await expect(
      assertAppriseTargetSafe('slack://tokenA/tokenB/tokenC', publicOpts()),
    ).resolves.toBeUndefined();
  });

  it('validates host-bearing schemes and rejects a private host', async () => {
    await expect(
      assertAppriseTargetSafe('http://ntfy.example.com/topic', publicOpts()),
    ).resolves.toBeUndefined();
    await expect(
      assertAppriseTargetSafe('ntfy://192.168.1.5/topic', {
        mode: 'cloud',
        resolve: resolveTo('192.168.1.5'),
      }),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects a mailto whose smtp= override resolves private', async () => {
    await expect(
      assertAppriseTargetSafe('mailto://user:pass@example.com?smtp=internal.mail', {
        mode: 'cloud',
        resolve: resolveTo({ 'example.com': '1.1.1.1', 'internal.mail': '10.0.0.5' }),
      }),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects an unknown scheme (fail-closed)', async () => {
    await expect(
      assertAppriseTargetSafe('weirdscheme://host/x', publicOpts()),
    ).rejects.toBeInstanceOf(SsrfError);
  });
});
