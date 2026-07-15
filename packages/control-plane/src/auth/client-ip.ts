import { isIP } from 'node:net';
import type { Request } from 'express';

function ipInCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split('/');
  if (!range || bitsStr === undefined) return false;
  const bits = Number(bitsStr);
  if (isIP(ip) !== 4 || isIP(range) !== 4 || Number.isNaN(bits)) return false;
  const toInt = (a: string): number =>
    a.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(range) & mask);
}

/**
 * Client IP for rate limiting. The raw socket peer by default; the last
 * `X-Forwarded-For` hop is honored ONLY when the immediate peer is itself
 * within a configured trusted CIDR (so a client can't spoof the header and a
 * load balancer doesn't collapse everyone into one bucket).
 */
export function clientIp(req: Request, trustedCidrs: string[]): string {
  const peer = req.socket.remoteAddress ?? '0.0.0.0';
  const normalizedPeer = peer.replace(/^::ffff:/, '');
  if (trustedCidrs.length > 0 && trustedCidrs.some((c) => ipInCidr(normalizedPeer, c))) {
    const xff = req.headers['x-forwarded-for'];
    const chain = Array.isArray(xff) ? xff.join(',') : (xff ?? '');
    const hops = chain
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const last = hops.at(-1);
    if (last) return last;
  }
  return normalizedPeer;
}

/** True if the request carries any forwarding header (⇒ something is proxying
 * ⇒ auto-login must refuse). */
export function hasForwardingHeader(req: Request): boolean {
  return Boolean(
    req.headers['x-forwarded-for'] ||
    req.headers['x-forwarded-host'] ||
    req.headers['x-forwarded-proto'] ||
    req.headers['forwarded'],
  );
}
