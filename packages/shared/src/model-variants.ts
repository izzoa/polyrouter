/**
 * Model-id variant classification — the PURE primitives (add-model-variant-detection).
 *
 * At the shared ROOT, not under `server/`, for the same reason the routing-target
 * helpers are: the dashboard needs the canonical parser, and a second copy in the
 * frontend would be free to disagree with the one the router enforces. The
 * provider-scoped entry point (`variantForProvider`) stays server-side, because
 * billing families are a server concept.
 *
 * An aggregator encodes a SKU variant as a suffix on the model id
 * (`openai/gpt-6-astra:batch`). A `:batch` SKU is not a synchronous model at all:
 * it is the catalog's 50%-priced representation of the provider's asynchronous
 * batch tier, whose own API takes the PLAIN slug — so nothing is ever sent to the
 * suffixed id.
 *
 * ALLOWLIST, never shape: "text after the last colon" would classify
 * `anthropic.claude-haiku-4-5-20251001-v1:0` as variant `0`. An unknown suffix
 * classifies as nothing and the model stays routable — failing safe.
 */

/** Known aggregator variant tokens. BUNDLED DATA: adding one is a change, never a
 * runtime inference. Sourced from the live OpenRouter catalog + its variant docs. */
export const MODEL_VARIANTS: readonly string[] = [
  'batch',
  'free',
  'nitro',
  'floor',
  'extended',
  'thinking',
  'online',
  'exacto',
];

/** Variants no synchronous request can reach. `batch` is the whole set today:
 * its SKU exists to price an async batch tier. Every other variant is a normal,
 * synchronously-callable model that is classified for DISPLAY only. Routability
 * is DERIVED from this set (never a stored boolean that could drift). */
export const NON_ROUTABLE_VARIANTS: readonly string[] = ['batch'];

export interface ParsedModelVariant {
  /** The id minus exactly one matched suffix, ORIGINAL CASING PRESERVED. */
  readonly base: string;
  /** The matched token, lower-cased (always a `MODEL_VARIANTS` member). */
  readonly variant: string;
}

/**
 * Classify an external model id, or null when its final `:`-segment is not a
 * known variant token.
 *
 * Only the candidate SUFFIX is lower-cased, for the allowlist test. The returned
 * `base` keeps the id's original casing: `external_model_id` is stored and matched
 * exactly as the provider gave it, so a lower-cased base would fail to find the
 * sibling row this pairing exists to locate.
 */
export function parseModelVariant(externalModelId: string): ParsedModelVariant | null {
  const id = externalModelId.trim();
  const colon = id.lastIndexOf(':');
  if (colon <= 0 || colon === id.length - 1) return null;
  const suffix = id
    .slice(colon + 1)
    .trim()
    .toLowerCase();
  if (!MODEL_VARIANTS.includes(suffix)) return null;
  const base = id.slice(0, colon).trim();
  if (base === '') return null;
  return { base, variant: suffix };
}

/** Whether a stored `variant` value makes its model unroutable. Null/absent (no
 * variant) and every routable token answer false. */
export function isNonRoutableVariant(variant: string | null | undefined): boolean {
  return variant !== null && variant !== undefined && NON_ROUTABLE_VARIANTS.includes(variant);
}
