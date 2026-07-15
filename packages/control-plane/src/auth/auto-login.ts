import type { BaseConfig } from '@polyrouter/shared';
import type { Request } from 'express';
import { isLoopbackAddress } from './auth.config';
import { hasForwardingHeader } from './client-ip';

export interface AutoLoginContext {
  mode: BaseConfig['MODE'];
  bindAddress: string;
  dashboardOrigin: string;
}

/**
 * Whether localhost auto-login may apply to this request (session-auth
 * requirement, hardened per codex round 2). The load-bearing gate is that the
 * instance is NOT network-reachable (`BIND_ADDRESS` loopback); the rest defend
 * against a same-host proxy, DNS rebinding, and hostile browser origins.
 * Caller still requires an existing admin.
 */
export function autoLoginEligible(req: Request, ctx: AutoLoginContext): boolean {
  if (ctx.mode !== 'selfhosted') return false;
  // Not network-reachable: no external client, no fronting proxy.
  if (!isLoopbackAddress(ctx.bindAddress)) return false;
  // A forwarding header means something is proxying — refuse.
  if (hasForwardingHeader(req)) return false;
  // Raw socket peer must be loopback (trust proxy is off).
  const peer = req.socket.remoteAddress ?? '';
  if (!isLoopbackAddress(peer)) return false;
  // Host header must be loopback (DNS-rebinding defense).
  const host = (req.headers.host ?? '').split(':')[0] ?? '';
  if (!isLoopbackAddress(host)) return false;
  // Same-origin: Origin absent or the exact dashboard origin; and a browser
  // cross-site fetch (Sec-Fetch-Site) is refused.
  const origin = req.headers['origin'];
  if (origin && origin !== ctx.dashboardOrigin) return false;
  const secFetchSite = req.headers['sec-fetch-site'];
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') return false;
  return true;
}
