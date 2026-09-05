/**
 * Provider-scoped variant classification (add-model-variant-detection). The pure
 * primitives live at the shared ROOT (`model-variants`) so the dashboard shares
 * ONE parser with the router; this module adds the server-side scoping rule and
 * re-exports them, exactly as `server/index` re-exports the routing-target
 * helpers.
 *
 * AGGREGATOR-SCOPED: the `:batch`/`:free` convention is OpenRouter's, and a custom
 * endpoint may legitimately serve a model literally named `foo:batch`. Scoping is
 * by the provider's billing family, resolved through the SAME host->family map
 * price keys use (`deriveProviderFamily`), so the two can never drift.
 */
import { AGGREGATOR_FAMILIES } from '../pricing/resolve';
import { parseModelVariant, type ParsedModelVariant } from '../../model-variants';

export {
  MODEL_VARIANTS,
  NON_ROUTABLE_VARIANTS,
  isNonRoutableVariant,
  parseModelVariant,
} from '../../model-variants';
export type { ParsedModelVariant } from '../../model-variants';

/** `parseModelVariant` scoped to aggregator billing families — the form every
 * caller that touches a stored model should use. A direct, custom, or unmapped
 * provider classifies as null (unknown rather than wrong). */
export function variantForProvider(
  billingFamily: string | null,
  externalModelId: string,
): ParsedModelVariant | null {
  if (billingFamily === null) return null;
  if (!AGGREGATOR_FAMILIES.includes(billingFamily.trim().toLowerCase())) return null;
  return parseModelVariant(externalModelId);
}
