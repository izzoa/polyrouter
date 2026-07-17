// E9.1: IPv6-aware trusted-proxy client-IP bucketing + strict CIDR parsing.
import type { Request } from 'express';
import { clientIp, parseCidr } from './client-ip';

function req(peer: string, xff?: string): Request {
  return {
    socket: { remoteAddress: peer },
    headers: xff !== undefined ? { 'x-forwarded-for': xff } : {},
  } as unknown as Request;
}

describe('parseCidr (strict)', () => {
  it('accepts valid IPv4/IPv6 CIDRs', () => {
    expect(parseCidr('10.0.0.0/8')).toMatchObject({ range: '10.0.0.0', bits: 8, family: 4 });
    expect(parseCidr('fd00::/8')).toMatchObject({ range: 'fd00::', bits: 8, family: 6 });
    expect(parseCidr('0.0.0.0/0')).toMatchObject({ bits: 0, family: 4 });
  });

  it('rejects an empty/malformed prefix — never coerces to /0 (trust-all)', () => {
    for (const bad of [
      '10.0.0.0/', // empty suffix — the bug: Number('')===0 would be /0
      '10.0.0.0', // no slash
      '10.0.0.0/-1',
      '10.0.0.0/33', // > v4 width
      'fd00::/129', // > v6 width
      '10.0.0.0/0x1', // hex
      '10.0.0.0/1e2', // exponent
      'not-an-ip/8',
      '10.0.0.0/ 8',
    ]) {
      expect(parseCidr(bad)).toBeNull();
    }
  });
});

describe('clientIp — IPv6-aware trusted-proxy bucketing', () => {
  it('honors the last XFF hop for an IPv6 trusted-proxy peer (the DoS fix)', () => {
    expect(clientIp(req('fd00::1', '2001:db8::5'), ['fd00::/8'])).toBe('2001:db8::5');
  });

  it('buckets two clients behind the same v6 proxy distinctly', () => {
    expect(clientIp(req('fd00::1', '2001:db8::5'), ['fd00::/8'])).toBe('2001:db8::5');
    expect(clientIp(req('fd00::1', '2001:db8::6'), ['fd00::/8'])).toBe('2001:db8::6');
  });

  it('ignores XFF from an UNTRUSTED v6 peer (returns the peer)', () => {
    expect(clientIp(req('2001:db8::9', '10.0.0.1'), ['fd00::/8'])).toBe('2001:db8::9');
  });

  it('still works for a v4 peer + v4 CIDR', () => {
    expect(clientIp(req('10.0.0.5', '203.0.113.7'), ['10.0.0.0/8'])).toBe('203.0.113.7');
  });

  it('matches a mapped ::ffff: v4 peer against a v4 CIDR', () => {
    expect(clientIp(req('::ffff:10.0.0.5', '203.0.113.7'), ['10.0.0.0/8'])).toBe('203.0.113.7');
  });

  it('a malformed empty-suffix CIDR does NOT trust the peer (strict parse — no XFF spoof)', () => {
    // Regression pin for the /0 trust-all hole: '10.0.0.0/' is invalid → peer untrusted → XFF ignored.
    expect(clientIp(req('10.0.0.5', '203.0.113.7'), ['10.0.0.0/'])).toBe('10.0.0.5');
  });

  it('a v6 CIDR does not trust a v4 peer (clean cross-family miss)', () => {
    expect(clientIp(req('10.0.0.5', '203.0.113.7'), ['fd00::/8'])).toBe('10.0.0.5');
  });
});
