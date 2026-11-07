import type { ProviderRow } from '@polyrouter/shared/server';
import {
  bindingMatches,
  type IdentityBinding,
  type PlanUsageDeclaration,
} from '../providers/client-identity';

/** What a coherent subscription row may observe: a passive reply dialect, a usage endpoint, or
 * both (add-subscription-quota-display, design D1). */
export type PlanUsageSources = PlanUsageDeclaration;

/**
 * The ONE gate every plan-usage consumer reads (the adapter builder, the proxy's attempt
 * builder, Test, sync, the view and Refresh usage). It adds no preset lookup and no pin test of
 * its own: `binding` is what `SubscriptionOauthService.identityBindingFor(row)` returned, and
 * the pin is `bindingMatches` from `client-identity.ts`, the same function `clientIdentityFor`
 * calls, so identity and plan usage cannot disagree about which rows are coherent.
 *
 * Returns the binding's usage declaration only while the row is a `subscription` provider still
 * on the preset's pinned endpoint and protocol; null for an unbound row, a drifted row, an
 * "Other subscription" row, a pay-as-you-go row on a preset host, and a preset that declares no
 * usage source. A plain function over its arguments, so no constructor changes anywhere.
 */
export function planUsageSourcesFor(
  row: Pick<ProviderRow, 'kind' | 'baseUrl' | 'protocol'>,
  binding: IdentityBinding | undefined,
): PlanUsageSources | null {
  if (!bindingMatches(row, binding)) return null;
  const usage = binding?.usage;
  if (usage === undefined) return null;
  if (usage.dialect === undefined && usage.probe === undefined) return null;
  return usage;
}
