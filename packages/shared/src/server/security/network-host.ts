import { lookup as dnsLookup } from 'node:dns/promises';
import {
  assertEndpointsSafe,
  classifyIp,
  isAddressPermitted,
  SsrfError,
  type AllowedEndpoint,
} from './ssrf';

/**
 * SSRF guard for a raw network host+port (a notification SMTP server / Apprise
 * target, #15a) — the URL guard (`assertUrlSafe`) is HTTP-only, so this reuses
 * #4's IP-tier classifier for non-HTTP sockets, with the **same policy shape as
 * #4's provider guard** (spec §11.2 / invariant 6): **metadata / link-local /
 * all hard ranges are blocked in every mode, never allowlistable**; **loopback**
 * is allowed **only in self-host** (the §11.2 local exception — a loopback SMTP
 * relay or the Apprise sidecar), blocked in cloud; a **soft private** range is
 * blocked unless a **port-bounded** allowlist entry permits it, in **both** modes
 * (the operator opts their private relay in via `NOTIFY_ALLOWED_ENDPOINTS`).
 * Returns a validated IP so the caller can **pin the connection** (defeat DNS
 * rebinding — validate the resolved IP at connect time).
 */
export interface NetworkHostOptions {
  mode: 'selfhosted' | 'cloud';
  allowedEndpoints?: AllowedEndpoint[];
  /** Injected in tests; default DNS. */
  resolve?: (hostname: string) => Promise<string[]>;
}

export async function assertNetworkHostSafe(
  host: string,
  port: number,
  opts: NetworkHostOptions,
): Promise<{ ip: string }> {
  // Validate the allowlist ENTRIES with the same HARD-overlap policy the URL path
  // uses (A-41) — a hard-overlapping/malformed `NOTIFY_ALLOWED_ENDPOINTS` entry is
  // rejected here too, not only on the provider/URL path.
  assertEndpointsSafe(opts.allowedEndpoints);
  const cleaned = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  let ips: string[];
  try {
    ips = opts.resolve
      ? await opts.resolve(cleaned)
      : (await dnsLookup(cleaned, { all: true })).map((r) => r.address);
  } catch {
    throw new SsrfError('unresolvable', `cannot resolve host`);
  }
  if (ips.length === 0) throw new SsrfError('unresolvable', `no address for host`);
  const selfhosted = opts.mode === 'selfhosted';
  for (const ip of ips) {
    // ALL resolved addresses must be permitted (a split-horizon record can't sneak one in).
    // Self-host makes loopback OK; metadata/hard stay blocked in every mode.
    const cls = classifyIp(ip, { allowLoopback: selfhosted });
    if (cls === 'hard') {
      throw new SsrfError('blocked_ip', `host resolves to a blocked address`);
    }
    if (cls === 'ok') continue;
    // soft (private): port-bounded allowlist in BOTH modes (mode:'cloud' forces
    // the allowlist path — no blanket mode relaxation for private ranges).
    if (
      !isAddressPermitted(cleaned, ip, port, {
        context: { mode: 'cloud' },
        ...(opts.allowedEndpoints !== undefined ? { allowedEndpoints: opts.allowedEndpoints } : {}),
      })
    ) {
      throw new SsrfError('blocked_ip', `host resolves to a blocked address`);
    }
  }
  return { ip: ips[0]! };
}
