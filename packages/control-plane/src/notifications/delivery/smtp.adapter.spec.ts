// E14.1: deliverSmtp is SSRF-validated at CONNECT time and pinned to the validated
// IP (SNI preserved) — invariant 6 / spec §10.1. These lock that behavior so a
// refactor dropping `assertNetworkHostSafe` or the IP pinning fails loudly.
//   - a host resolving to a metadata/link-local address is refused (both modes)
//     with a sanitized `smtp_host_blocked`, BEFORE any socket is opened; and
//   - a safe host connects to the resolved IP (not the hostname), with the cert
//     validated against the original host (rebind defense).
jest.mock('nodemailer');

// A resolver seam: a hostname maps to a loopback IP (so host ≠ pinned IP proves the
// pinning); literal IPs echo themselves, exactly as getaddrinfo does for numerics.
jest.mock('node:dns/promises', () => ({
  lookup: jest.fn((host: string) =>
    host === 'mail.internal.test'
      ? Promise.resolve([{ address: '127.0.0.1', family: 4 }])
      : Promise.resolve([{ address: host, family: host.includes(':') ? 6 : 4 }]),
  ),
}));

import { createTransport } from 'nodemailer';
import { deliverSmtp } from './smtp.adapter';
import type { SmtpConfig } from '../channel-config';
import type { NotifyRuntime } from '../notify.config';

const mockCreate = createTransport as unknown as jest.Mock;

const cfg = (host: string): SmtpConfig => ({
  host,
  port: 587,
  secure: 'starttls',
  from: 'ops@example.test',
  to: ['alerts@example.test'],
});
const rendered = { title: 'test', body: 'body' };
const rt = (mode: 'selfhosted' | 'cloud'): Pick<NotifyRuntime, 'mode' | 'allowedEndpoints'> => ({
  mode,
  allowedEndpoints: [],
});

beforeEach(() => {
  mockCreate.mockReset();
  mockCreate.mockReturnValue({
    sendMail: jest.fn().mockResolvedValue(undefined),
    close: jest.fn(),
  });
});

describe('deliverSmtp — connect-time SSRF refusal (E14.1)', () => {
  it.each(['selfhosted', 'cloud'] as const)(
    'refuses a metadata/link-local host before opening a socket (%s)',
    async (mode) => {
      // 169.254.169.254 is a literal link-local/metadata IP — a hard block in EVERY
      // mode (loopback is the only self-host exception, and this is not loopback).
      await expect(deliverSmtp(cfg('169.254.169.254'), rendered, rt(mode), 1_000)).rejects.toThrow(
        'smtp_host_blocked',
      );
      expect(mockCreate).not.toHaveBeenCalled(); // no transport, no socket
    },
  );

  it('pins the connection to the validated IP with the original host as SNI (rebind defense)', async () => {
    await deliverSmtp(cfg('mail.internal.test'), rendered, rt('selfhosted'), 1_000);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const opts = mockCreate.mock.calls[0]?.[0] as { host: string; tls: { servername: string } };
    expect(opts.host).toBe('127.0.0.1'); // the resolved IP, NOT the hostname (pinned)
    expect(opts.tls.servername).toBe('mail.internal.test'); // cert checked against the real host
  });
});
