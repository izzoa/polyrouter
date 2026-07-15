import { isLoopbackAddress, resolveAuthSecrets, type AuthConfig } from './auth.config';
import { clientIp, hasForwardingHeader } from './client-ip';
import type { Request } from 'express';

const HEX = 'a'.repeat(64);
const baseAuth: AuthConfig = {
  BETTER_AUTH_URL: 'http://127.0.0.1:3001',
  DASHBOARD_ORIGIN: 'http://localhost:3000',
  SEED_DATA: false,
  TRUSTED_PROXY_CIDRS: [],
};

describe('auth secrets & IP gating (session-auth)', () => {
  it('recognizes loopback addresses incl. ipv6-mapped', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost', '127.4.5.6']) {
      expect(isLoopbackAddress(a)).toBe(true);
    }
    for (const a of ['10.0.0.5', '0.0.0.0', '8.8.8.8', '192.168.1.1']) {
      expect(isLoopbackAddress(a)).toBe(false);
    }
  });

  it('uses fixed dev fallbacks only when loopback-bound + non-production + selfhosted', () => {
    const dev = resolveAuthSecrets(baseAuth, {
      NODE_ENV: 'development',
      MODE: 'selfhosted',
      BIND_ADDRESS: '127.0.0.1',
    });
    expect(dev.usedDevFallback).toBe(true);
    expect(dev.apiKeyHmacSecret).toMatch(/^polyrouter-dev/);
  });

  it('requires real secrets when network-bound, cloud, or production', () => {
    for (const base of [
      { NODE_ENV: 'development', MODE: 'selfhosted', BIND_ADDRESS: '0.0.0.0' },
      { NODE_ENV: 'development', MODE: 'cloud', BIND_ADDRESS: '127.0.0.1' },
      { NODE_ENV: 'production', MODE: 'selfhosted', BIND_ADDRESS: '127.0.0.1' },
    ] as const) {
      expect(() => resolveAuthSecrets(baseAuth, base)).toThrow(/required/);
    }
  });

  it('accepts provided real secrets in any mode without echoing them', () => {
    const resolved = resolveAuthSecrets(
      { ...baseAuth, BETTER_AUTH_SECRET: HEX, API_KEY_HMAC_SECRET: HEX },
      { NODE_ENV: 'production', MODE: 'cloud', BIND_ADDRESS: '0.0.0.0' },
    );
    expect(resolved.usedDevFallback).toBe(false);
    expect(resolved.betterAuthSecret).toBe(HEX);
  });

  it('honors X-Forwarded-For only from a trusted peer', () => {
    const mk = (peer: string, xff?: string): Request =>
      ({
        socket: { remoteAddress: peer },
        headers: xff ? { 'x-forwarded-for': xff } : {},
      }) as unknown as Request;
    // untrusted peer: header ignored
    expect(clientIp(mk('9.9.9.9', '1.1.1.1'), ['10.0.0.0/8'])).toBe('9.9.9.9');
    // trusted peer: last hop honored
    expect(clientIp(mk('10.1.2.3', '1.1.1.1, 2.2.2.2'), ['10.0.0.0/8'])).toBe('2.2.2.2');
    // no trusted cidrs: always the socket peer
    expect(clientIp(mk('10.1.2.3', '1.1.1.1'), [])).toBe('10.1.2.3');
  });

  it('detects forwarding headers', () => {
    const mk = (headers: Record<string, string>): Request => ({ headers }) as unknown as Request;
    expect(hasForwardingHeader(mk({ 'x-forwarded-for': '1.1.1.1' }))).toBe(true);
    expect(hasForwardingHeader(mk({ forwarded: 'for=1.1.1.1' }))).toBe(true);
    expect(hasForwardingHeader(mk({}))).toBe(false);
  });
});
