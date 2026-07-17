import { BlockList, isIP } from 'node:net';
import type { Request } from 'express';

/** Strict CIDR parse — the prefix MUST be a decimal within the family width. A
 * non-decimal/empty suffix is rejected (NOT coerced: `Number('')===0` would turn
 * `10.0.0.0/` into `/0` = trust every peer, letting a direct client spoof
 * `X-Forwarded-For`). Shared by `ipInCidr` and the boot validation so both agree. */
export function parseCidr(cidr: string): { range: string; bits: number; family: 4 | 6 } | null {
  const slash = cidr.lastIndexOf('/');
  if (slash < 0) return null;
  const range = cidr.slice(0, slash);
  const bitsStr = cidr.slice(slash + 1);
  if (!/^\d+$/.test(bitsStr)) return null;
  const bits = Number(bitsStr);
  const family = isIP(range);
  if (family === 0 || bits > (family === 6 ? 128 : 32)) return null;
  return { range, bits, family: family as 4 | 6 };
}

/** Family-aware CIDR membership (IPv4, IPv6, IPv4-mapped) via `net.BlockList`; a
 * cross-family or malformed check is a clean false, never a throw. */
function ipInCidr(ip: string, cidr: string): boolean {
  const c = parseCidr(cidr);
  const af = isIP(ip);
  if (c === null || af === 0) return false;
  try {
    const bl = new BlockList();
    bl.addSubnet(c.range, c.bits, c.family === 6 ? 'ipv6' : 'ipv4');
    return bl.check(ip, af === 6 ? 'ipv6' : 'ipv4');
  } catch {
    return false;
  }
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
