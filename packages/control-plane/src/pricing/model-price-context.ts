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
