import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  PERSISTENCE_MAINTENANCE,
  deriveProviderFamily,
  variantForProvider,
  type PersistenceMaintenance,
} from '@polyrouter/shared/server';

/**
 * Classifies already-synced model rows after migrations and before serving
 * (add-model-variant-detection) — the same boot position as the bundled pricing
 * seed, and for the same reason: an instance that synced an aggregator's catalog
 * last month should behave correctly on this boot, not on its next sync.
 *
 * This is deliberately NOT done in the migration. Migrations here are Drizzle SQL
 * applied by `migrate()`, while the host->family map and the variant allowlist are
 * TypeScript; re-expressing either in SQL would fork the definition and drift on
 * the first host added. Running it here keeps exactly one derivation.
 *
 * The pass writes only rows whose stored value differs, so once converged it is a
 * read-only no-op on every subsequent boot.
 *
 * It is an instance-level pass, so it runs through the maintenance token
 * (add-batch-inference D19) from its own controller-free module — never from
 * `ProvidersModule`, which handles requests.
 */
@Injectable()
export class VariantClassificationBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger('VariantClassification');
  constructor(
    @Inject(PERSISTENCE_MAINTENANCE) private readonly maintenance: PersistenceMaintenance,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const { scanned, updated } = await this.maintenance.models.classifyVariants(
      ({ providerBaseUrl, externalModelId }) =>
        variantForProvider(
          providerBaseUrl === null ? null : deriveProviderFamily(providerBaseUrl),
          externalModelId,
        )?.variant ?? null,
    );
    if (updated > 0) {
      this.logger.log(
        `Classified ${String(updated)} model variant(s) of ${String(scanned)} scanned`,
      );
    }
  }
}
