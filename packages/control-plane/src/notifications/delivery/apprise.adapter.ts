import { guardedFetch } from '@polyrouter/shared/server';
import type { NotifyRuntime } from '../notify.config';
import type { AppriseConfig } from '../channel-config';

/**
 * Deliver via the Apprise API (#15a). The cloud egress gate is enforced **here**
 * (every delivery, not only create) so an existing/backup-restored channel can't
 * deliver in cloud without the sidecar-isolation attestation. The POST is
 * SSRF-guarded at connect time (`guardedFetch`); `APPRISE_API_URL` is the
 * operator's own configured sidecar (validated at boot), so it carries the
 * `local` provider kind — the §11.2 loopback exception applies in self-host, a
 * private sidecar still needs a port-bounded `NOTIFY_ALLOWED_ENDPOINTS` entry,
 * and cloud/metadata stay blocked. The body is drained under an abort deadline.
 * Throws only sanitized codes.
 */
export async function deliverApprise(
  config: AppriseConfig,
  /** The RENDERED chat value (add-branded-notifications). The adapter resolves
   * nothing — no event type reaches it, and no severity map lives here — so
   * exactly one mapping exists, in the renderer. `type`/`format` are optional
   * so a caller that supplies neither behaves exactly as before. */
  rendered: { title: string; body: string; type?: string; format?: string },
  rt: NotifyRuntime,
  timeoutMs: number,
): Promise<void> {
  if (rt.mode === 'cloud' && !rt.appriseEgressConfirmed)
    throw new Error('apprise_egress_unconfirmed');
  if (rt.appriseApiUrl === undefined) throw new Error('apprise_not_configured');
  const url = `${rt.appriseApiUrl.replace(/\/+$/, '')}/notify`;

  let status: number;
  try {
    const res = await guardedFetch(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          urls: config.urls.join(','),
          title: rendered.title,
          body: rendered.body,
          // Presentation only — neither field names a host, so no new egress
          // target is introduced (the SSRF contract is unchanged).
          ...(rendered.type !== undefined ? { type: rendered.type } : {}),
          ...(rendered.format !== undefined ? { format: rendered.format } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      },
      { context: { mode: rt.mode, providerKind: 'local' }, allowedEndpoints: rt.allowedEndpoints },
    );
    status = res.status;
    await res.text().catch(() => undefined); // drain (bounded by the signal)
  } catch {
    throw new Error('apprise_unreachable');
  }
  if (status < 200 || status >= 300) {
    throw new Error(`apprise_http_${Math.floor(status / 100)}xx`);
  }
}
