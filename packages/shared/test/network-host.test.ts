import { describe, expect, it } from 'vitest';
import { assertNetworkHostSafe, SsrfError } from '../src/server';

const to = (ip: string) => (): Promise<string[]> => Promise.resolve([ip]);

describe('assertNetworkHostSafe (#15a notification host guard)', () => {
  it('allows a public host and returns the validated IP for pinning', async () => {
    await expect(
      assertNetworkHostSafe('mail.example.com', 587, { mode: 'cloud', resolve: to('1.1.1.1') }),
    ).resolves.toEqual({ ip: '1.1.1.1' });
  });

  it('blocks metadata in every mode', async () => {
    for (const mode of ['selfhosted', 'cloud'] as const) {
      await expect(
        assertNetworkHostSafe('x', 587, { mode, resolve: to('169.254.169.254') }),
      ).rejects.toBeInstanceOf(SsrfError);
    }
  });

  it('allows loopback only in self-host (the §11.2 local exception)', async () => {
    await expect(
      assertNetworkHostSafe('apprise', 8000, { mode: 'selfhosted', resolve: to('127.0.0.1') }),
    ).resolves.toEqual({ ip: '127.0.0.1' });
    await expect(
      assertNetworkHostSafe('x', 8000, { mode: 'cloud', resolve: to('127.0.0.1') }),
    ).rejects.toBeInstanceOf(SsrfError); // loopback never allowlistable, blocked in cloud
  });

  it('blocks a private range in BOTH modes unless a port-bounded allowlist permits it', async () => {
    for (const mode of ['selfhosted', 'cloud'] as const) {
      // private always needs an explicit allowlist entry (no blanket mode relaxation)
      await expect(
        assertNetworkHostSafe('relay', 587, { mode, resolve: to('10.1.2.3') }),
      ).rejects.toBeInstanceOf(SsrfError);
      await expect(
        assertNetworkHostSafe('relay', 587, {
          mode,
          resolve: to('10.1.2.3'),
          allowedEndpoints: [{ host: 'relay', cidr: '10.0.0.0/8', port: 587 }],
        }),
      ).resolves.toEqual({ ip: '10.1.2.3' });
      await expect(
        assertNetworkHostSafe('relay', 25, {
          mode,
          resolve: to('10.1.2.3'),
          allowedEndpoints: [{ host: 'relay', cidr: '10.0.0.0/8', port: 587 }],
        }),
      ).rejects.toBeInstanceOf(SsrfError); // port-bounded
    }
  });
});
