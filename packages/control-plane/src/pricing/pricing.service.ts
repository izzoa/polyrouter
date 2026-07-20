import { Inject, Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import {
  PERSISTENCE_FACILITIES,
  PERSISTENCE_PORT,
  deriveModelKey,
  deriveNativeFamilyKey,
  parseLiteLlmCatalog,
  resolveModelPrice,
  type BundledPrice,
  type ModelPriceInput,
  type ModelPriceRow,
  type ModelRow,
  type PersistenceFacilities,
  type PersistencePort,
  type PriceSnapshot,
  type PricingStatusMeta,
} from '@polyrouter/shared/server';
import { BUNDLED_CATALOG_VERSION, BUNDLED_PRICES } from './bundled-catalog';
import type { fetchLiteLlmCatalog } from './litellm-fetch';

export const PRICING_RUNTIME = 'polyrouter:pricing-runtime';
export const PRICING_FETCH = 'polyrouter:pricing-fetch';

export interface PricingRuntime {
  readonly mode: 'selfhosted' | 'cloud';
  readonly refreshUrl: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}
export type PricingFetch = typeof fetchLiteLlmCatalog;

export interface OverrideInput {
  readonly inputPricePer1m: number;
  readonly outputPricePer1m: number;
  readonly cacheReadPricePer1m?: number;
  readonly cacheWritePricePer1m?: number;
  readonly contextWindow?: number;
  readonly supportsTools?: boolean;
  readonly supportsVision?: boolean;
  readonly supportsReasoning?: boolean;
  readonly isFree?: boolean;
}

export interface RefreshInput {
  readonly source: 'bundled' | 'body' | 'litellm';
  readonly entries?: BundledPrice[];
}

/** A stable advisory-lock key so seed/refresh/override serialize (invariant 4:
 * one write path, monotonic, manual-respecting). */
const PRICING_LOCK = 0x70726963; // 'pric'

function toInput(entry: BundledPrice, validFrom: Date, source: string): ModelPriceInput {
  return {
    modelKey: entry.modelKey,
    inputPricePer1m: entry.inputPricePer1m,
    outputPricePer1m: entry.outputPricePer1m,
    cacheReadPricePer1m: entry.cacheReadPricePer1m ?? null,
    cacheWritePricePer1m: entry.cacheWritePricePer1m ?? null,
    contextWindow: entry.contextWindow ?? null,
    supportsTools: entry.supportsTools ?? false,
    supportsVision: entry.supportsVision ?? false,
    supportsReasoning: entry.supportsReasoning ?? false,
    isFree: entry.isFree ?? false,
    source,
    validFrom,
  };
}

function unchanged(entry: BundledPrice, latest: ModelPriceRow): boolean {
  return (
    entry.inputPricePer1m === latest.inputPricePer1m &&
    entry.outputPricePer1m === latest.outputPricePer1m &&
    (entry.cacheReadPricePer1m ?? null) === latest.cacheReadPricePer1m &&
    (entry.cacheWritePricePer1m ?? null) === latest.cacheWritePricePer1m &&
    (entry.contextWindow ?? null) === latest.contextWindow &&
    (entry.supportsTools ?? false) === latest.supportsTools &&
    (entry.supportsVision ?? false) === latest.supportsVision &&
    (entry.supportsReasoning ?? false) === latest.supportsReasoning &&
    (entry.isFree ?? false) === latest.isFree
  );
}

function validate(entry: BundledPrice): void {
  const finite = (n: number | undefined): boolean => n === undefined || Number.isFinite(n);
  if (!Number.isFinite(entry.inputPricePer1m) || !Number.isFinite(entry.outputPricePer1m)) {
    throw new UnprocessableEntityException('prices must be finite numbers');
  }
  if (
    entry.inputPricePer1m < 0 ||
    entry.outputPricePer1m < 0 ||
    (entry.cacheReadPricePer1m ?? 0) < 0 ||
    (entry.cacheWritePricePer1m ?? 0) < 0 ||
    !finite(entry.cacheReadPricePer1m) ||
    !finite(entry.cacheWritePricePer1m)
  ) {
    throw new UnprocessableEntityException('prices must be finite and non-negative');
  }
  if (entry.isFree === true && (entry.inputPricePer1m !== 0 || entry.outputPricePer1m !== 0)) {
    throw new UnprocessableEntityException('a free model must have zero input/output price');
  }
}

@Injectable()
export class PricingService {
  private readonly logger = new Logger('PricingService');

  constructor(
    @Inject(PERSISTENCE_PORT) private readonly db: PersistencePort,
    @Inject(PERSISTENCE_FACILITIES) private readonly facilities: PersistenceFacilities,
    @Inject(PRICING_RUNTIME) private readonly runtime: PricingRuntime,
    @Inject(PRICING_FETCH) private readonly fetchCatalog: PricingFetch,
  ) {}

  priceAt(modelKey: string, at: Date): Promise<ModelPriceRow | null> {
    return this.db.pricing.priceAt(modelKey, at);
  }

  listCatalog(now: Date): Promise<ModelPriceRow[]> {
    return this.db.pricing.listLatest(now);
  }

  async resolveForModel(
    model: Pick<ModelRow, 'externalModelId' | 'inputPricePer1m' | 'outputPricePer1m' | 'isFree'>,
    providerBaseUrl: string | null,
    providerKind: string,
    at: Date,
  ): Promise<PriceSnapshot | null> {
    const key =
      providerBaseUrl !== null ? deriveModelKey(providerBaseUrl, model.externalModelId) : null;
    const catalogRow = key !== null ? await this.db.pricing.priceAt(key, at) : null;
    // Native-family fallback (add-native-price-fallback): consulted ONLY after a
    // SUCCESSFUL null exact lookup — a thrown lookup propagates into the writer's
    // bounded retry path (a DB error is never treated as a catalog miss, so an
    // estimated snapshot can never shadow an existing exact row).
    let nativeRow = null;
    if (key !== null && catalogRow === null) {
      const nativeKey = deriveNativeFamilyKey(
        key.slice(0, key.indexOf(':')),
        model.externalModelId,
      );
      if (nativeKey !== null) nativeRow = await this.db.pricing.priceAt(nativeKey, at);
    }
    return resolveModelPrice(
      {
        providerKind,
        modelInputPricePer1m: model.inputPricePer1m,
        modelOutputPricePer1m: model.outputPricePer1m,
        modelIsFree: model.isFree,
      },
      catalogRow,
      nativeRow,
    );
  }

  /** The SINGLE write path. Serialized by an advisory lock; re-reads `latest`
   * inside the lock; skips a manual-latest (unless this is a manual), a
   * non-monotonic `valid_from`, and an unchanged entry. Returns rows written. */
  private applyVersions(
    entries: readonly BundledPrice[],
    validFrom: Date,
    source: string,
    skipInvalid = false,
    run?: { kind: 'litellm' | 'body' | 'bundled' },
  ): Promise<{ added: number; skipped: number }> {
    // Every entry is validated before it is written. A trusted/explicit source (bundled
    // snapshot, manual override, admin-supplied body) fails-fast on an invalid entry — a
    // real bug or bad operator input worth surfacing. Only the untrusted LIVE LiteLLM pull
    // (`skipInvalid`) skips + logs a bad row and continues, so one malformed upstream entry
    // can't throw inside the transaction and abort the WHOLE refresh, dropping every other
    // valid price update (A-13).
    //
    // For a trusted source, validate the WHOLE set up front — before acquiring the lock or
    // doing any DB work — so bad operator input is rejected without touching the database.
    if (!skipInvalid) for (const entry of entries) validate(entry);
    return this.facilities.withAdvisoryLock(PRICING_LOCK, async (tx) => {
      let written = 0;
      let skipped = 0;
      for (const entry of entries) {
        if (skipInvalid) {
          try {
            validate(entry);
          } catch (err) {
            skipped += 1;
            this.logger.warn(
              `pricing refresh (${source}): skipped invalid entry ${entry.modelKey}: ${(err as Error).message}`,
            );
            continue;
          }
        }
        const latest = await tx.pricing.latest(entry.modelKey);
        if (latest !== null) {
          if (source !== 'manual' && latest.source === 'manual') continue; // never clobber an override
          if (validFrom.getTime() <= latest.validFrom.getTime()) continue; // monotonic
          if (unchanged(entry, latest)) continue; // no-op
        }
        await tx.pricing.insertVersion(toInput(entry, validFrom, source));
        written += 1;
      }
      if (skipped > 0) {
        this.logger.warn(
          `pricing refresh (${source}): skipped ${String(skipped)} invalid entr(ies)`,
        );
      }
      // Run-ledger row (add-pricing-refresh-ui): INSIDE the same advisory-lock
      // transaction as the version apply — the catalog and the ledger commit
      // together or not at all (a completed refresh is never unrecorded, and
      // a recorded one is never uncommitted).
      if (run !== undefined) {
        await tx.pricing.insertRefreshRun({ kind: run.kind, added: written, skipped });
      }
      return { added: written, skipped };
    });
  }

  async seed(): Promise<number> {
    // Boot seeding is deterministic and runs in EVERY mode (the cloud gate
    // below covers only the OPERATOR entrypoints); it is not a refresh run.
    const { added } = await this.applyVersions(BUNDLED_PRICES, BUNDLED_CATALOG_VERSION, 'bundled');
    return added;
  }

  async override(modelKey: string, prices: OverrideInput, now: Date): Promise<number> {
    this.assertMutable(); // FIRST (r3-Low-6): the mode refusal is deterministic, never shadowed by validation
    const entry: BundledPrice = {
      modelKey,
      inputPricePer1m: prices.inputPricePer1m,
      outputPricePer1m: prices.outputPricePer1m,
      ...(prices.cacheReadPricePer1m !== undefined
        ? { cacheReadPricePer1m: prices.cacheReadPricePer1m }
        : {}),
      ...(prices.cacheWritePricePer1m !== undefined
        ? { cacheWritePricePer1m: prices.cacheWritePricePer1m }
        : {}),
      ...(prices.contextWindow !== undefined ? { contextWindow: prices.contextWindow } : {}),
      ...(prices.supportsTools !== undefined ? { supportsTools: prices.supportsTools } : {}),
      ...(prices.supportsVision !== undefined ? { supportsVision: prices.supportsVision } : {}),
      ...(prices.supportsReasoning !== undefined
        ? { supportsReasoning: prices.supportsReasoning }
        : {}),
      ...(prices.isFree !== undefined ? { isFree: prices.isFree } : {}),
    };
    validate(entry);
    const { added } = await this.applyVersions([entry], now, 'manual');
    return added;
  }

  /** Operator-mutation gate (add-pricing-refresh-ui): the archived contract
   * disables global-catalog mutations in cloud mode; enforced HERE so no
   * internal caller (the scheduler included) can bypass the HTTP guard.
   * Boot `seed()` is deliberately exempt. */
  private assertMutable(): void {
    if (this.runtime.mode !== 'selfhosted') {
      throw new Error('catalog mutations are disabled in cloud mode');
    }
  }

  async refresh(input: RefreshInput, now: Date): Promise<number> {
    this.assertMutable(); // cloud never mutates the global catalog (defense in depth)
    if (input.source === 'bundled') {
      // An ENDPOINT-invoked bundled re-apply is an operator action — recorded
      // as a bundled-kind run (boot seeding records nothing).
      const { added } = await this.applyVersions(
        BUNDLED_PRICES,
        BUNDLED_CATALOG_VERSION,
        'bundled',
        false,
        { kind: 'bundled' },
      );
      return added;
    }
    if (input.source === 'body') {
      // Admin-supplied body: fail-fast in applyVersions on any invalid entry (bad operator
      // input is worth surfacing, not silently dropping).
      const { added } = await this.applyVersions(input.entries ?? [], now, 'refresh', false, {
        kind: 'body',
      });
      return added;
    }
    // litellm: guarded fetch → parse → apply. `skipInvalid`: one malformed UPSTREAM row is
    // skipped+logged, not fatal, so it can't abort the whole refresh (A-13).
    const json = await this.fetchCatalog(this.runtime.refreshUrl, {
      mode: this.runtime.mode,
      timeoutMs: this.runtime.timeoutMs,
      maxBytes: this.runtime.maxBytes,
    });
    const entries = parseLiteLlmCatalog(json);
    // A live pull COMPLETES only with a populated, accepted catalog: valid
    // JSON that parses to zero entries ({}, [], scalars, all-malformed) is a
    // FAILED run — garbage must never advance freshness as "+0 — no changes".
    if (entries.length === 0) {
      throw new Error('pricing refresh (litellm): catalog yielded no accepted entries');
    }
    const { added } = await this.applyVersions(entries, now, 'refresh', true, {
      kind: 'litellm',
    });
    this.logger.log(`pricing refresh (litellm): ${String(added)} version(s) appended`);
    return added;
  }

  status(now: Date): Promise<PricingStatusMeta> {
    return this.db.pricing.statusMeta(now);
  }
}
