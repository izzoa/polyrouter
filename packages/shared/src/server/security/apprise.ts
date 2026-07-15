import { SsrfError } from './ssrf';
import { assertNetworkHostSafe, type NetworkHostOptions } from './network-host';

/**
 * SSRF guard for a user-supplied Apprise target URL (#15a, spec §10.1/§11.2).
 * The Apprise *sidecar* makes the actual per-target connection, so this is
 * defense-in-depth (the authoritative control is network egress policy on the
 * container). Host-bearing schemes (the caller supplies the destination host,
 * incl. `mailto`'s `smtp=` override) are SSRF-validated; fixed public-service
 * schemes are allowed; unknown schemes are rejected (fail-closed).
 */

/** Schemes whose destination host is caller-controlled (validate it). */
export const APPRISE_HOST_BEARING_SCHEMES = new Set([
  'http',
  'https',
  'ntfy',
  'ntfys',
  'gotify',
  'gotifys',
  'json',
  'jsons',
  'xml',
  'xmls',
  'form',
  'forms',
  'matrix',
  'matrixs',
  'mailto',
  'mailtos',
  'mqtt',
  'mqtts',
  'rsyslog',
]);

/** Schemes that resolve to a fixed public service (host is not user-chosen). */
export const APPRISE_FIXED_SERVICE_SCHEMES = new Set([
  'discord',
  'tgram',
  'telegram',
  'slack',
  'pover',
  'pushover',
  'gchat',
  'gchats',
  'twilio',
  'msteams',
  'pushbullet',
  'pbul',
  'signal',
  'signals',
  'wxteams',
]);

/** Host-override query params some Apprise plugins honor (`mailto?smtp=…`). */
const HOST_OVERRIDE_PARAMS = ['smtp', 'host'];

export async function assertAppriseTargetSafe(
  rawUrl: string,
  opts: NetworkHostOptions,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError('bad_protocol', 'invalid apprise url');
  }
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  if (APPRISE_FIXED_SERVICE_SCHEMES.has(scheme)) return; // fixed public host
  if (!APPRISE_HOST_BEARING_SCHEMES.has(scheme)) {
    throw new SsrfError('bad_protocol', `unsupported apprise scheme`);
  }
  const targets: { host: string; port: number }[] = [];
  if (url.hostname) targets.push({ host: url.hostname, port: portFor(url, scheme) });
  for (const param of HOST_OVERRIDE_PARAMS) {
    const v = url.searchParams.get(param);
    if (v) targets.push({ host: v, port: 0 }); // override port unknown → IP-tier check only
  }
  if (targets.length === 0) throw new SsrfError('unresolvable', 'apprise target has no host');
  for (const t of targets) await assertNetworkHostSafe(t.host, t.port, opts);
}

function portFor(url: URL, scheme: string): number {
  if (url.port) return Number(url.port);
  if (scheme === 'https' || scheme.endsWith('s')) return 443;
  if (scheme === 'http' || scheme.startsWith('json') || scheme.startsWith('xml')) return 80;
  return 0;
}
