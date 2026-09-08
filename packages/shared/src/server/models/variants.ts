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

/**
 * Whether a MODEL is batch-capable, from its provider's batch seam plus whatever
 * evidence its catalog carries (fix-batch-capability-and-chain-alignment).
 *
 * The seam is necessary everywhere and sufficient only on a NATIVE family: there
 * batch is an endpoint over the whole account, so a model the provider serves
 * synchronously it will serve in a batch too, and there is no per-model record to
 * consult. On an AGGREGATOR family batch is a per-model SKU that only part of the
 * catalog carries, so the model needs evidence of its own: a batch-priced sibling
 * twin on that same provider. Without this split the seam alone reported every
 * priced OpenRouter model batchable, and a reservation on one of the ~84% with no
 * batch tier was accepted and then refused at submission.
 *
 * ONE rule, two callers — the dashboard's `batchCapable` flag and the
 * routing-entry write path. A second predicate would let the interface offer a
 * reservation the API refuses, or refuse one it offers.
 *
 * Deliberately NOT "a batch price resolved": native Anthropic publishes no batch
 * rate polyrouter can resolve, so that test would call every Anthropic model
 * unbatchable.
 */
export function modelBatchCapable(input: {
  /** Whether the provider carries the batch adapter seam at all. */
  readonly seam: boolean;
  /** The provider's billing family (`deriveProviderFamily`), null when unmapped. */
  readonly billingFamily: string | null;
  /** Whether a batch-priced sibling twin exists for this model on this provider. */
  readonly hasBatchTwin: boolean;
}): boolean {
  if (!input.seam) return false;
  // An unmapped family cannot hold the seam today (it is granted only to the three
  // known families), and if one ever did it would not be an aggregator — so the
  // seam decides rather than demanding evidence no aggregator convention produces.
  if (input.billingFamily === null) return true;
  if (!AGGREGATOR_FAMILIES.includes(input.billingFamily.trim().toLowerCase())) return true;
  return input.hasBatchTwin;
}
