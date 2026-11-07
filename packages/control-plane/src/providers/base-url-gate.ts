import { UnprocessableEntityException } from '@nestjs/common';
import { SsrfError, assertUrlSafe } from '@polyrouter/shared/server';
import type { ProviderKind } from '@polyrouter/data-plane';

/**
 * Reject userinfo/query/fragment, SSRF-gate the address with the per-kind context, reject
 * `local` outside self-host, and return the normalized URL (`new URL(x).href`).
 *
 * The ONE implementation behind provider create/update/actions AND the key-preset connect
 * path (add-key-subscription-presets, design D7 step 4): a preset's pinned `base_url` goes
 * through the same gate as a user-supplied one, as defense in depth.
 */
export async function normalizeAndGateBaseUrl(
  mode: 'selfhosted' | 'cloud',
  kind: ProviderKind,
  baseUrl: string,
): Promise<string> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new UnprocessableEntityException('invalid base_url');
  }
  if (url.username !== '' || url.password !== '') {
    throw new UnprocessableEntityException('base_url must not contain embedded credentials');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new UnprocessableEntityException('base_url must not contain a query or fragment');
  }
  if (kind === 'local' && mode !== 'selfhosted') {
    throw new UnprocessableEntityException('local providers require MODE=selfhosted');
  }
  try {
    await assertUrlSafe(url.href, { context: { mode, providerKind: kind } });
  } catch (err) {
    if (err instanceof SsrfError) {
      throw new UnprocessableEntityException('base_url failed SSRF validation');
    }
    throw err;
  }
  return url.href;
}
