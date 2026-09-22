/**
 * Effective DISPLAY price resolution, shared by every surface that shows one
 * (add-provider-price-sync-and-edit; extracted by expand-models-listing when
 * `/v1/models` became a second caller).
 *
 * `pricing-catalog` requires the cost path and the display path to resolve
 * identically, which is why `resolveModelPrice` is a pure shared helper. The bulk
 * lookup AROUND it needs the same treatment: two surfaces deriving catalog keys
 * separately is exactly how the dashboard and the proxy would come to report
 * different prices for one model. Both go through here instead.
 *
 * Deliberately a plain function over the persistence port, NOT an injectable: the
 * proxy assembles `ProxyService` by hand in several harnesses, and a DI edge would
 * drag provider credential config into tests that have no business needing it.
 */
import {
  deriveModelKey,
  deriveNativeFamilyKey,
  resolveModelPrice,
  type ModelPriceRow,
  type ModelRow,
  type PersistencePort,
  type Principal,
  type ProviderRow,
} from '@polyrouter/shared/server';

/** The provenance of an `EffectivePrice` — the billing-resolver sources plus the
 * display-only `listed` estimate (add-provider-price-sync-and-edit). */
export type EffectivePriceSource =
  'model' | 'local' | 'bundled' | 'refresh' | 'manual' | 'native_family' | 'listed';

/** A model's current effective price for display (add-provider-price-sync-and-edit).
 * Resolved read-time through the SAME pure resolver the recorded-cost path uses
 * (record-listed-price-fallback): catalog → native-family → the per-provider `listed`
 * estimate, whichever wins. `estimated` is true for the `native_family` and `listed`
 * fallbacks. Historical RequestLog cost is the immutable request-time snapshot and is
 * unaffected by later price changes (invariant 4). */
export interface EffectivePrice {
  inputPricePer1m: number;
  outputPricePer1m: number;
  isFree: boolean;
  source: EffectivePriceSource;
  estimated: boolean;
}

/** Resolve a model's effective DISPLAY price: the pure billing resolver first
 * (model-own for custom/local → local-free → catalog → native family), and ONLY when
 * that is unknown, the per-provider `listed` estimate (flagged `estimated`). Display
 * only — this never recomputes historical cost (invariant 4). */
export function toEffectivePrice(
  model: ModelRow,
  providerKind: string,
  catalogRow: ModelPriceRow | null,
  nativeCatalogRow: ModelPriceRow | null = null,
  /** BATCH mode (add-batch-mode-help): the sibling aggregator twin whose captured
   * rate is the last-resort estimate. It lives on the TWIN's own row — not on this
   * model's and not on the catalog row — so a resolution that omitted it would
   * report null for exactly the provider whose batch rate is most often knowable. */
  batch: { twin: ModelRow | null } | null = null,
): EffectivePrice | null {
  // The listed fallback lives in the shared resolver (record-listed-price-fallback),
  // so display + recorded cost resolve identically — this supplies the model's
  // captured listed estimate and maps whatever source wins.
  const snap = resolveModelPrice(
    {
      providerKind,
      modelInputPricePer1m: model.inputPricePer1m,
      modelOutputPricePer1m: model.outputPricePer1m,
      modelIsFree: model.isFree,
      listedInputPricePer1m: model.listedInputPricePer1m,
      listedOutputPricePer1m: model.listedOutputPricePer1m,
      listedIsFree: model.listedIsFree ?? false,
    },
    catalogRow,
    nativeCatalogRow,
    batch === null
      ? undefined
      : {
          mode: 'batch',
          listedBatchInputPricePer1m: batch.twin?.listedInputPricePer1m ?? null,
          listedBatchOutputPricePer1m: batch.twin?.listedOutputPricePer1m ?? null,
        },
  );
  if (snap === null) return null;
  return {
    inputPricePer1m: snap.inputPricePer1m,
    outputPricePer1m: snap.outputPricePer1m,
    isFree: snap.isFree,
    source: snap.source,
    // Both the native-family (adjacent channel) and listed (provider's own
    // estimate) fallbacks are estimates, not authoritative catalog rates.
    estimated: snap.source === 'native_family' || snap.source === 'listed',
  };
}

/** A model's resolved capability description (honest-model-capabilities). Every
 * field is OPTIONAL and an absent field means **unknown** — no tier of the ladder
 * stated it. A `false` is an assertion ("this model cannot"), which is a stronger
 * and different claim than silence; conflating the two is what made `/v1/models`
 * advertise `supports_tools: false` for every model in existence. */
export interface EffectiveCapabilities {
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  contextWindow?: number;
  /** True when ANY resolved value came from below the exact catalog key — the
   * aggregator native-family row or the provider's own captured claim. Coarse by
   * design: per-field provenance would force a nested wire shape, and a caller
   * needing certainty per flag is better served by the dashboard. */
  estimated: boolean;
}

/** The per-provider capability claim captured at model sync (`listed_*` columns,
 * see provider-management). Display-grade evidence: the provider's own statement
 * about its own catalog, never a catalog value and never routing evidence. */
export interface ListedCapabilityClaim {
  supportsTools?: boolean | null;
  supportsVision?: boolean | null;
  supportsReasoning?: boolean | null;
  contextWindow?: number | null;
}

/** Resolve ONE field down the ladder. Null and undefined are both "this tier did
 * not say"; only an explicit value stops the descent, so an exact-key row that
 * states tools but is silent on vision still lets the native row answer vision. */
function pickTier<T>(
  exact: T | null | undefined,
  native: T | null | undefined,
  listed: T | null | undefined,
): { value: T | undefined; estimated: boolean } {
  if (exact !== null && exact !== undefined) return { value: exact, estimated: false };
  if (native !== null && native !== undefined) return { value: native, estimated: true };
  if (listed !== null && listed !== undefined) return { value: listed, estimated: true };
  return { value: undefined, estimated: false };
}

/**
 * Resolve a model's effective DISPLAY capabilities: exact catalog key → aggregator
 * native-family key → the per-provider listed claim, **per field**.
 *
 * Deliberately a LOOSER ladder than the one output caps admit (exact key only).
 * A cap and a price are properties of the CHANNEL — an aggregator marks the price
 * up and may cap output lower, and an overstated cap silently truncates a caller's
 * response. Tool/vision/reasoning support is a property of the MODEL, which an
 * aggregator reselling it serves as the same weights, so the adjacent-channel row
 * is a sound description.
 *
 * It is NOT sound as routing evidence, and this resolution is never used as such:
 * `fallback-routing` admits the exact key alone, because demoting a member below
 * the order its owner configured on an inference that might be wrong trades a
 * certain harm for a speculative one.
 */
export function toEffectiveCapabilities(
  catalogRow: ModelPriceRow | null,
  nativeCatalogRow: ModelPriceRow | null = null,
  listed: ListedCapabilityClaim | null = null,
): EffectiveCapabilities {
  const tools = pickTier(
    catalogRow?.supportsTools,
    nativeCatalogRow?.supportsTools,
    listed?.supportsTools,
  );
  const vision = pickTier(
    catalogRow?.supportsVision,
    nativeCatalogRow?.supportsVision,
    listed?.supportsVision,
  );
  const reasoning = pickTier(
    catalogRow?.supportsReasoning,
    nativeCatalogRow?.supportsReasoning,
    listed?.supportsReasoning,
  );
  const contextWindow = pickTier(
    catalogRow?.contextWindow,
    nativeCatalogRow?.contextWindow,
    listed?.contextWindow,
  );
  return {
    ...(tools.value !== undefined ? { supportsTools: tools.value } : {}),
    ...(vision.value !== undefined ? { supportsVision: vision.value } : {}),
    ...(reasoning.value !== undefined ? { supportsReasoning: reasoning.value } : {}),
    ...(contextWindow.value !== undefined ? { contextWindow: contextWindow.value } : {}),
    estimated:
      tools.estimated || vision.estimated || reasoning.estimated || contextWindow.estimated,
  };
}

/** The per-model inputs `toEffectivePrice` needs, resolved in BULK: one providers
 * read + ONE key-filtered catalog read, never a query per model (invariant 9). */
export interface PriceContext {
  /** The owning provider row — exposed so a caller needing more than the kind
   * does not issue a SECOND providers read. */
  providerOf(model: ModelRow): ProviderRow | undefined;
  kindOf(model: ModelRow): string;
  catalogRowOf(model: ModelRow): ModelPriceRow | null;
  nativeRowOf(model: ModelRow): ModelPriceRow | null;
}

/**
 * Build the price context for a set of owned model rows. Native-family fallback
 * keys ride the SAME batch as the exact keys (derived up front — no follow-up
 * query per exact-key miss; add-native-price-fallback).
 */
export async function loadPriceContext(
  db: PersistencePort,
  principal: Principal,
  rows: readonly ModelRow[],
  at: Date = new Date(),
): Promise<PriceContext> {
  const providers = await db.providers.list(principal);
  const provById = new Map(providers.map((p) => [p.id, p]));
  const keyByModel = new Map<string, string>();
  const nativeKeyByModel = new Map<string, string>();
  const keys = new Set<string>();
  for (const r of rows) {
    const prov = provById.get(r.providerId);
    if (prov === undefined || prov.baseUrl === null) continue;
    const key = deriveModelKey(prov.baseUrl, r.externalModelId);
    if (key === null) continue;
    keyByModel.set(r.id, key);
    keys.add(key);
    const nativeKey = deriveNativeFamilyKey(key.slice(0, key.indexOf(':')), r.externalModelId);
    if (nativeKey !== null) {
      nativeKeyByModel.set(r.id, nativeKey);
      keys.add(nativeKey);
    }
  }
  const catalog = await db.pricing.priceAtMany([...keys], at);
  const catByKey = new Map(catalog.map((c) => [c.modelKey, c]));
  const rowFor = (map: Map<string, string>, m: ModelRow): ModelPriceRow | null => {
    const key = map.get(m.id);
    return key === undefined ? null : (catByKey.get(key) ?? null);
  };
  return {
    providerOf: (m) => provById.get(m.providerId),
    kindOf: (m) => provById.get(m.providerId)?.kind ?? 'custom',
    catalogRowOf: (m) => rowFor(keyByModel, m),
    nativeRowOf: (m) => rowFor(nativeKeyByModel, m),
  };
}
