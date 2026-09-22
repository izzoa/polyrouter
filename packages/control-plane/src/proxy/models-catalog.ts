/**
 * The `/v1/models` catalog (expand-models-listing).
 *
 * One protocol-neutral entry set, assembled ONCE and rendered into either wire
 * shape. Assembling once is the point: the routable filter and the bare-id
 * ambiguity rule are what keep the listing and the resolver's phase-1 matrix in
 * agreement, and computing them per envelope would let the two drift.
 */
import { AUTO_ALIAS, isNonRoutableVariant } from '@polyrouter/shared/server';
import type { EffectiveCapabilities } from '../pricing/model-price-context';

/**
 * The router does not track model creation dates, so `created` is FIXED and
 * identical across every entry — present for schema conformance, nothing more.
 * The only per-model timestamp we hold is the provider-sync time, which is
 * rewritten on every sync; backing the field with it would churn a client's
 * cached or sorted catalog for reasons that have nothing to do with the models.
 */
export const CATALOG_CREATED = 0;
const CATALOG_CREATED_AT = new Date(CATALOG_CREATED * 1000).toISOString();

const OWNED_BY = 'polyrouter';

/** The effective display price, already resolved by the shared resolver so this
 * surface, the dashboard, and the cost path can never report different figures.
 * `estimated` carries the resolver's own marking (invariant 4) — a `native_family`
 * or `listed` figure is an estimate and must never render as a bare number. */
export interface CatalogPrice {
  inputPricePer1m: number;
  outputPricePer1m: number;
  isFree: boolean;
  source: string;
  estimated: boolean;
}

/** The model fields the catalog reads. Structural on purpose: `SafeModel`
 * satisfies it, so the builder is testable without the management projection. */
export interface CatalogModel {
  providerId: string;
  externalModelId: string;
  displayName: string | null;
  variant: string | null;
  effectivePrice: CatalogPrice | null;
  /** Resolved by the SHARED capability ladder (honest-model-capabilities), not
   * read from the model row — the row never carried capability truth, and the
   * columns that looked as though they did had no writer at all. */
  capabilities: EffectiveCapabilities;
}

/**
 * One advertised id, protocol-neutral.
 *
 * Every optional field is ABSENT rather than null when unknown. A virtual id
 * (`auto`, a tier key) names a SET of models, so no single context window,
 * capability flag, or price describes it: a minimum understates and makes
 * clients over-truncate, a maximum overstates and fails upstream, and a
 * representative member's value changes silently when a tier is reordered. An
 * absent key lets a client fall back to its own default; a wrong one makes it
 * size and cost its requests against a figure that was never true.
 */
export interface CatalogEntry {
  id: string;
  displayName: string;
  contextWindow?: number;
  /** Tri-state: `true`, `false`, or ABSENT = unknown. A rendered `false` asserts
   * the model is known to lack the capability, which is a different and stronger
   * claim than having no information — and a client reading it will route around
   * a model that may well be capable. */
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  /** Set only when some capability value resolved BELOW the exact catalog key
   * (the aggregator native-family row, or the provider's own captured claim). */
  capabilitiesEstimated?: boolean;
  price?: CatalogPrice;
}

/** A tier key or `auto`: an id that resolves, and describes nothing. */
function virtualEntry(id: string): CatalogEntry {
  return { id, displayName: id };
}

function modelEntry(id: string, m: CatalogModel): CatalogEntry {
  const c = m.capabilities;
  return {
    id,
    displayName: m.displayName ?? id,
    // Absent, never null — and for the capability flags, absent rather than
    // `false`: the resolver already omits what no tier of the ladder stated.
    ...(c.contextWindow !== undefined ? { contextWindow: c.contextWindow } : {}),
    ...(c.supportsTools !== undefined ? { supportsTools: c.supportsTools } : {}),
    ...(c.supportsVision !== undefined ? { supportsVision: c.supportsVision } : {}),
    ...(c.supportsReasoning !== undefined ? { supportsReasoning: c.supportsReasoning } : {}),
    // `estimated` is true only when a value actually resolved from a lower tier,
    // so this never marks an entry that describes nothing.
    ...(c.estimated ? { capabilitiesEstimated: true } : {}),
    ...(m.effectivePrice !== null ? { price: m.effectivePrice } : {}),
  };
}

/**
 * Every id this tenant may address, in listing order: `auto`, the tier keys,
 * then per routable model its always-routable provider-qualified id plus its
 * bare id when that id is unambiguous.
 *
 * Non-routable variants (today, batch-priced twins) are excluded entirely, and
 * ambiguity is counted over the ROUTABLE set only — so excluding one can never
 * withdraw a bare id that does resolve.
 */
export function buildCatalog(
  models: readonly CatalogModel[],
  tierKeys: readonly string[],
): CatalogEntry[] {
  const routable = models.filter((m) => !isNonRoutableVariant(m.variant));
  const bareCount = new Map<string, number>();
  for (const m of routable) {
    bareCount.set(m.externalModelId, (bareCount.get(m.externalModelId) ?? 0) + 1);
  }
  const entries: CatalogEntry[] = [virtualEntry(AUTO_ALIAS), ...tierKeys.map(virtualEntry)];
  for (const m of routable) {
    entries.push(modelEntry(`${m.providerId}:${m.externalModelId}`, m));
    if (bareCount.get(m.externalModelId) === 1) entries.push(modelEntry(m.externalModelId, m));
  }
  return entries;
}

/** The additive descriptive fields, in either envelope's snake_case. Prices are
 * per-1M USD — the convention the rest of the system and the whole dashboard
 * speak, deliberately not OpenRouter's per-token strings. */
function metadata(e: CatalogEntry): Record<string, unknown> {
  return {
    ...(e.contextWindow !== undefined ? { context_window: e.contextWindow } : {}),
    ...(e.supportsTools !== undefined ? { supports_tools: e.supportsTools } : {}),
    ...(e.supportsVision !== undefined ? { supports_vision: e.supportsVision } : {}),
    ...(e.supportsReasoning !== undefined ? { supports_reasoning: e.supportsReasoning } : {}),
    // Flat booleans stay flat and the marker rides beside them: the consumers of
    // this envelope are OpenAI- and Anthropic-SDK clients that read flat fields,
    // so nesting the flags to hang one shared marker off the group would move a
    // released field for symmetry no client benefits from.
    ...(e.capabilitiesEstimated === true ? { capabilities_estimated: true } : {}),
    ...(e.price !== undefined
      ? {
          pricing: {
            input_per_1m: e.price.inputPricePer1m,
            output_per_1m: e.price.outputPricePer1m,
            is_free: e.price.isFree,
            source: e.price.source,
            estimated: e.price.estimated,
          },
        }
      : {}),
  };
}

export function renderOpenAiEntry(e: CatalogEntry): Record<string, unknown> {
  return {
    id: e.id,
    object: 'model',
    created: CATALOG_CREATED,
    owned_by: OWNED_BY,
    ...metadata(e),
  };
}

export function renderAnthropicEntry(e: CatalogEntry): Record<string, unknown> {
  return {
    type: 'model',
    id: e.id,
    display_name: e.displayName,
    created_at: CATALOG_CREATED_AT,
    ...metadata(e),
  };
}

export function renderOpenAiList(entries: readonly CatalogEntry[]): Record<string, unknown> {
  return { object: 'list', data: entries.map(renderOpenAiEntry) };
}

/** The Anthropic list shape. The catalog is returned as ONE complete page — no
 * cursor is accepted or honored — so `has_more` is always false. */
export function renderAnthropicList(entries: readonly CatalogEntry[]): Record<string, unknown> {
  return {
    data: entries.map(renderAnthropicEntry),
    has_more: false,
    first_id: entries[0]?.id ?? null,
    last_id: entries[entries.length - 1]?.id ?? null,
  };
}
