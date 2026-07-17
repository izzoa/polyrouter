import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Agent, buildConnector, fetch as undiciFetch, type Dispatcher } from 'undici';

/** Outbound-URL SSRF guard (spec §11.2, invariant 6). Config-free — callers
 * pass a `context`, like the encryption util takes keys. Validates HTTP(S)
 * URLs only; non-HTTP Apprise schemes are the notification change's concern. */

export type SsrfCode =
  | 'bad_protocol'
  | 'not_https'
  | 'blocked_ip'
  | 'unresolvable'
  | 'too_many_redirects'
  | 'cross_origin_redirect';

export class SsrfError extends Error {
  readonly code: SsrfCode;
  constructor(code: SsrfCode, message: string) {
    super(`ssrf: ${message}`);
    this.name = 'SsrfError';
    this.code = code;
  }
}

/* ---- range tiers (enumerated IANA special-purpose set; design decision 2) ---- */

type Family = 'ipv4' | 'ipv6';

/** Per-family lists: an IPv4-mapped v6 subnet (`::ffff:0:0/96`) added to a
 * BlockList makes it match EVERY IPv4 address (they map into that range), so
 * v4 and v6 ranges must live in separate lists and each address is only ever
 * checked against its own family's list. */
function makeList(ranges: [string, number][], family: Family): BlockList {
  const list = new BlockList();
  for (const [addr, prefix] of ranges) list.addSubnet(addr, prefix, family);
  return list;
}

/** Loopback — HARD, but un-blocked under the loopback exception. */
const LOOPBACK_V4 = makeList([['127.0.0.0', 8]], 'ipv4');
const LOOPBACK_V6 = makeList([['::1', 128]], 'ipv6');

/** HARD — never relaxable by an allowlist. */
const HARD_V4 = makeList(
  [
    ['0.0.0.0', 8],
    ['169.254.0.0', 16], // link-local incl. 169.254.169.254 metadata
    ['192.0.0.0', 24],
    ['192.0.2.0', 24], // TEST-NET-1
    ['192.88.99.0', 24], // deprecated 6to4 relay anycast
    ['198.18.0.0', 15], // benchmarking
    ['198.51.100.0', 24], // TEST-NET-2
    ['203.0.113.0', 24], // TEST-NET-3
    ['224.0.0.0', 4], // multicast
    ['240.0.0.0', 4], // reserved
    ['255.255.255.255', 32],
  ],
  'ipv4',
);
const HARD_V6 = makeList(
  [
    ['::', 128], // unspecified
    ['::', 96], // deprecated IPv4-compatible
    ['::ffff:0:0', 96], // IPv4-mapped
    ['64:ff9b::', 96], // NAT64
    ['64:ff9b:1::', 48], // local-use NAT64
    ['100::', 64], // discard-only
    ['2001::', 23], // IETF protocol assignments
    ['2001:db8::', 32], // documentation
    ['2002::', 16], // 6to4
    ['3fff::', 20], // reserved for documentation
    ['5f00::', 16], // reserved
    ['fe80::', 10], // link-local
    ['fec0::', 10], // deprecated site-local
    ['ff00::', 8], // multicast
  ],
  'ipv6',
);

/** SOFT — private LANs; relaxable only by an address-bounded allowlist entry. */
const SOFT_V4 = makeList(
  [
    ['10.0.0.0', 8],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
    ['100.64.0.0', 10], // CGNAT
  ],
  'ipv4',
);
const SOFT_V6 = makeList([['fc00::', 7]], 'ipv6'); // unique-local

function familyOf(ip: string): Family | null {
  const v = isIP(ip);
  return v === 4 ? 'ipv4' : v === 6 ? 'ipv6' : null;
}

function lists(family: Family): { loopback: BlockList; hard: BlockList; soft: BlockList } {
  return family === 'ipv4'
    ? { loopback: LOOPBACK_V4, hard: HARD_V4, soft: SOFT_V4 }
    : { loopback: LOOPBACK_V6, hard: HARD_V6, soft: SOFT_V6 };
}

function buildExtra(cidrs: string[] | undefined, family: Family): BlockList | null {
  if (!cidrs || cidrs.length === 0) return null;
  const list = new BlockList();
  let added = 0;
  for (const cidr of cidrs) {
    const [addr, prefixStr] = cidr.split('/');
    const cidrFamily = addr ? familyOf(addr) : null;
    if (!addr || prefixStr === undefined || !cidrFamily) {
      throw new Error(`ssrf: invalid extraBlockedCidr ${cidr}`);
    }
    if (cidrFamily === family) {
      list.addSubnet(addr, Number(prefixStr), family);
      added += 1;
    }
  }
  return added > 0 ? list : null;
}

export type IpClass = 'hard' | 'soft' | 'ok';

export interface IsBlockedOptions {
  allowLoopback?: boolean | undefined;
  extraBlockedCidrs?: string[] | undefined;
}

/** Classify an IP literal into the HARD / SOFT / OK tiers. */
export function classifyIp(ip: string, options: IsBlockedOptions = {}): IpClass {
  const family = familyOf(ip);
  if (!family) return 'hard'; // not a valid IP → refuse
  const { loopback, hard, soft } = lists(family);
  if (loopback.check(ip, family)) return options.allowLoopback ? 'ok' : 'hard';
  if (hard.check(ip, family)) return 'hard';
  const extra = buildExtra(options.extraBlockedCidrs, family);
  if (extra?.check(ip, family)) return 'hard';
  if (soft.check(ip, family)) return 'soft';
  return 'ok';
}

/** True for any address not safely routable to (HARD or SOFT). */
export function isBlockedIp(ip: string, options: IsBlockedOptions = {}): boolean {
  return classifyIp(ip, options) !== 'ok';
}

/* ---- URL validation ---- */

export interface GuardContext {
  mode: 'selfhosted' | 'cloud';
  providerKind?: string;
}

export interface AllowedEndpoint {
  host: string;
  cidr: string;
  port?: number;
}

export interface UrlGuardOptions {
  context: GuardContext;
  allowedEndpoints?: AllowedEndpoint[];
  extraBlockedCidrs?: string[];
  /** Resolve a hostname to IPs; default DNS. Injected in tests / at connect time. */
  resolve?: (hostname: string) => Promise<string[]>;
  maxRedirects?: number;
}

function loopbackAllowed(ctx: GuardContext): boolean {
  return ctx.mode === 'selfhosted' && ctx.providerKind === 'local';
}

function ipToBigInt(addr: string, family: Family): bigint {
  if (family === 'ipv4') {
    return addr.split('.').reduce((acc, o) => (acc << 8n) + BigInt(Number(o)), 0n);
  }
  // Expand an embedded IPv4 tail (e.g. `::ffff:1.2.3.4`) into two hex groups first.
  let a = addr;
  const v4 = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (v4) {
    const o = v4[2]!.split('.').map((x) => Number(x));
    a = `${v4[1]!}${(((o[0]! << 8) | o[1]!) >>> 0).toString(16)}:${(((o[2]! << 8) | o[3]!) >>> 0).toString(16)}`;
  }
  const [head, tail] = a.split('::');
  const h: string[] = head ? head.split(':').filter(Boolean) : [];
  const t: string[] | null =
    tail === undefined ? null : tail ? tail.split(':').filter(Boolean) : [];
  const fill: string[] = t === null ? [] : Array.from({ length: 8 - h.length - t.length }, () => '0');
  const groups: string[] = t === null ? h : [...h, ...fill, ...t];
  return groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g || '0', 16)), 0n);
}
function bigIntToIp(n: bigint, family: Family): string {
  if (family === 'ipv4') {
    return [24n, 16n, 8n, 0n].map((s) => Number((n >> s) & 0xffn)).join('.');
  }
  const groups: string[] = [];
  let v = n;
  for (let i = 0; i < 8; i += 1) {
    groups.unshift((v & 0xffffn).toString(16));
    v >>= 16n;
  }
  return groups.join(':');
}
/** Network + broadcast (both ends) of a CIDR, for either family. */
function cidrRange(addr: string, prefix: number, family: Family): [string, string] {
  const bits = family === 'ipv4' ? 32n : 128n;
  const full = (1n << bits) - 1n;
  const host = bits - BigInt(prefix);
  const mask = prefix === 0 ? 0n : (full << host) & full;
  const base = ipToBigInt(addr, family);
  const net = base & mask;
  const last = net | ((1n << host) - 1n);
  return [bigIntToIp(net, family), bigIntToIp(last, family)];
}

/** Reject an allowlist entry whose CIDR overlaps the HARD set — an allowlist may
 * relax SOFT (private) space only (codex r2 #1; A-41). It checks BOTH the network
 * and broadcast address (for either family), so a short-prefix CIDR whose network
 * is private but whose range spans a hard/public block (e.g. `10.0.0.0/7` →
 * `11.x` public, or `fc00::/6` → hard `fe80::/10`) is rejected — not just the
 * network. Exported so the network-host (notification) path validates its allowlist
 * with the same policy; throws `SsrfError` so callers classify it uniformly. */
export function assertEndpointsSafe(endpoints: AllowedEndpoint[] | undefined): void {
  for (const e of endpoints ?? []) {
    const invalid = (): SsrfError =>
      new SsrfError('blocked_ip', `invalid allowedEndpoint cidr ${e.cidr}`);
    // Strict grammar: exactly one `/`, a decimal-only prefix, and no IPv6 zone id
    // (`%eth0`) — so noncanonical/scoped inputs are a typed rejection, never a
    // parser `RangeError` reaching the caller (codex r2).
    const slash = e.cidr.split('/');
    if (slash.length !== 2 || e.cidr.includes('%') || !/^\d+$/.test(slash[1] ?? '')) throw invalid();
    const addr = slash[0]!;
    const prefix = Number(slash[1]!);
    const family = familyOf(addr);
    if (!family) throw invalid();
    const maxPrefix = family === 'ipv4' ? 32 : 128;
    if (prefix > maxPrefix) throw invalid();
    for (const ip of cidrRange(addr, prefix, family)) {
      if (classifyIp(ip, {}) !== 'soft') {
        throw new SsrfError(
          'blocked_ip',
          `allowedEndpoint cidr ${e.cidr} overlaps a hard-blocked or public range — only private (soft) ranges may be allowlisted`,
        );
      }
    }
  }
}

function endpointPermits(
  host: string,
  ip: string,
  port: number,
  endpoints: AllowedEndpoint[] | undefined,
): boolean {
  const family = familyOf(ip);
  if (!family) return false;
  return (endpoints ?? []).some((e) => {
    if (e.host !== host) return false;
    if (e.port !== undefined && e.port !== port) return false;
    const [addr, prefixStr] = e.cidr.split('/');
    const cidrFamily = addr ? familyOf(addr) : null;
    if (!addr || prefixStr === undefined || cidrFamily !== family) return false;
    const list = new BlockList();
    list.addSubnet(addr, Number(prefixStr), family);
    return list.check(ip, family);
  });
}

/** Whether an address is permitted for this host/port under the options —
 * OK always, SOFT only via an allowlist entry, HARD never. Shared by
 * validation-time and connect-time. */
export function isAddressPermitted(
  host: string,
  ip: string,
  port: number,
  options: UrlGuardOptions,
): boolean {
  const cls = classifyIp(ip, {
    allowLoopback: loopbackAllowed(options.context),
    extraBlockedCidrs: options.extraBlockedCidrs,
  });
  if (cls === 'ok') return true;
  if (cls === 'hard') return false;
  return endpointPermits(host, ip, port, options.allowedEndpoints);
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function portOf(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

async function resolveAll(hostname: string, options: UrlGuardOptions): Promise<string[]> {
  if (options.resolve) return options.resolve(hostname);
  const records = await dnsLookup(hostname, { all: true });
  return records.map((r) => r.address);
}

/**
 * Validation-time gate for an HTTP(S) URL. Rejects non-http(s), zone ids,
 * remote http, and any URL that is (or resolves to) a blocked address —
 * rejecting if ANY resolved address is blocked.
 */
export async function assertUrlSafe(rawUrl: string, options: UrlGuardOptions): Promise<URL> {
  assertEndpointsSafe(options.allowedEndpoints);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError('bad_protocol', 'unparseable URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError('bad_protocol', `unsupported scheme ${url.protocol}`);
  }
  const host = stripBrackets(url.hostname);
  if (host.includes('%')) throw new SsrfError('blocked_ip', 'zone id not allowed');
  const port = portOf(url);
  const literalFamily = familyOf(host);

  // Determine the candidate addresses (a literal, or resolved records).
  const candidates = literalFamily ? [host] : await resolveAll(host, options).catch(() => []);
  if (candidates.length === 0) throw new SsrfError('unresolvable', 'host did not resolve');

  const allLoopback = candidates.every(
    (ip) => classifyIp(ip, { allowLoopback: true }) === 'ok' && classifyIp(ip, {}) === 'hard',
  );
  const isAllowlisted = (options.allowedEndpoints ?? []).some((e) => e.host === host);

  // Require https for remote destinations; http only for a loopback-allowed
  // destination or an explicit allowlisted endpoint.
  if (url.protocol === 'http:') {
    const httpOk = (allLoopback && loopbackAllowed(options.context)) || isAllowlisted;
    if (!httpOk) throw new SsrfError('not_https', 'http is only allowed for loopback/allowlisted');
  }

  for (const ip of candidates) {
    if (!isAddressPermitted(host, ip, port, options)) {
      throw new SsrfError('blocked_ip', 'resolves to a blocked address');
    }
  }
  return url;
}

/* ---- guarded fetch (connect-before-validate + safe redirects) ---- */

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * A caller-owned, closeable undici dispatcher whose connector resolves and
 * validates every candidate address BEFORE connecting (so a private/metadata
 * listener never receives a TCP/TLS handshake), connects to the validated IP
 * preserving the TLS servername, and re-checks the peer post-connect.
 */
export function createGuardedDispatcher(options: UrlGuardOptions): Dispatcher {
  assertEndpointsSafe(options.allowedEndpoints);
  const baseConnect = buildConnector({});
  const connect: buildConnector.connector = (opts, callback) => {
    const host = stripBrackets(opts.hostname);
    const port = Number(opts.port) || (opts.protocol === 'https:' ? 443 : 80);
    const candidates = familyOf(host) ? Promise.resolve([host]) : resolveAll(host, options);
    candidates
      .then((ips) => {
        if (ips.length === 0) throw new SsrfError('unresolvable', 'host did not resolve');
        for (const ip of ips) {
          if (!isAddressPermitted(host, ip, port, options)) {
            throw new SsrfError('blocked_ip', 'connect-time address is blocked');
          }
        }
        // Connect to a validated IP, preserving the original name for TLS SNI.
        baseConnect(
          { ...opts, hostname: ips[0]!, servername: opts.servername ?? host },
          (err, socket) => {
            if (err || !socket) {
              callback(err ?? new SsrfError('unresolvable', 'connect failed'), null);
              return;
            }
            const peer = socket.remoteAddress;
            if (peer && !isAddressPermitted(host, peer, port, options)) {
              socket.destroy();
              callback(new SsrfError('blocked_ip', 'connected peer is blocked'), null);
              return;
            }
            callback(null, socket);
          },
        );
      })
      .catch((err: unknown) => callback(err as Error, null));
  };
  return new Agent({ connect });
}

/**
 * The fetch callers must use. Validates the initial URL, follows only
 * same-origin `3xx` redirects (bounded, re-validated per hop, intermediate
 * bodies cancelled), rejects cross-origin redirects so credentials never
 * cross origins, and dispatches through a guarded connector.
 */
export async function guardedFetch(
  rawUrl: string,
  init: RequestInit = {},
  options: UrlGuardOptions,
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? 5;
  const dispatcher = createGuardedDispatcher(options);
  try {
    let current = await assertUrlSafe(rawUrl, options);
    const bodyIsStream = init.body instanceof ReadableStream;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      // Use undici's OWN fetch (version-matched to our dispatcher — Node's
      // global fetch runs a different internal undici and rejects it). A
      // connector SsrfError surfaces as a wrapped TypeError; unwrap the cause.
      let res: Response;
      try {
        const undiciInit = {
          ...(init as unknown as Parameters<typeof undiciFetch>[1]),
          redirect: 'manual' as const,
          dispatcher,
        };
        res = await undiciFetch(current, undiciInit);
      } catch (err) {
        if (err instanceof TypeError && err.cause instanceof SsrfError) throw err.cause;
        throw err;
      }
      if (!REDIRECT_STATUSES.has(res.status)) return res;
      const location = res.headers.get('location');
      if (!location) return res;
      const next = new URL(location, current);
      await res.body?.cancel(); // never retain the intermediate connection
      if (next.origin !== current.origin) {
        throw new SsrfError('cross_origin_redirect', 'refusing cross-origin redirect');
      }
      if (bodyIsStream) {
        throw new SsrfError(
          'cross_origin_redirect',
          'cannot replay a streaming body across a redirect',
        );
      }
      await assertUrlSafe(next.href, options);
      current = next;
    }
    throw new SsrfError('too_many_redirects', `exceeded ${String(maxRedirects)} redirects`);
  } finally {
    await dispatcher.close();
  }
}
