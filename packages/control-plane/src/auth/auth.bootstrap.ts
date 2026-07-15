import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { IDENTITY_PORT, type IdentityPort } from '@polyrouter/shared/server';
import type { BaseConfig } from '@polyrouter/shared';
import { AUTH_INSTANCE } from './auth.tokens';
import { isLoopbackAddress, loadAuthConfig, type AuthConfig } from './auth.config';
import type { AuthInstance } from './better-auth';

// `admin@localhost` (spec §11) fails Better Auth's email validator (needs a
// dotted domain), so the dev admin uses a clearly-local dotted form.
const SEED_EMAIL = 'admin@polyrouter.local';
const SEED_PASSWORD = 'changeme-dev-admin'; // dev-only; documented in the README, never logged

/**
 * Runs after the app is composed but before it serves: (1) reconcile any
 * zero-admin / missing-default-tier state left by a crashed post-commit hook;
 * (2) optionally seed a dev admin — loopback-bound, non-production, self-host
 * only, never logging the password.
 */
@Injectable()
export class AuthBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger('AuthBootstrap');
  private readonly auth: AuthConfig;
  private readonly base: BaseConfig;

  constructor(
    @Inject(IDENTITY_PORT) private readonly identity: IdentityPort,
    @Inject(AUTH_INSTANCE) private readonly authInstance: AuthInstance,
  ) {
    const cfg = loadAuthConfig();
    this.auth = cfg.auth;
    this.base = cfg.base;
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.maybeSeed();
    // Heal crashes AFTER a possible seed so the seeded user is covered too.
    await this.identity.ensureFirstAdmin();
    const healed = await this.identity.provisionMissingDefaultTiers();
    if (healed > 0) this.logger.warn(`Reconciled ${String(healed)} user(s) missing a default tier`);
  }

  private async maybeSeed(): Promise<void> {
    if (!this.auth.SEED_DATA) return;
    const eligible =
      this.base.MODE === 'selfhosted' &&
      this.base.NODE_ENV !== 'production' &&
      isLoopbackAddress(this.base.BIND_ADDRESS);
    if (!eligible) {
      throw new Error(
        'SEED_DATA is only allowed on a loopback-bound, non-production, self-hosted instance',
      );
    }
    if ((await this.identity.findAdminUserId()) !== null) return;
    try {
      await this.authInstance.signUpEmail({
        name: 'Admin',
        email: SEED_EMAIL,
        password: SEED_PASSWORD,
      });
      // NEVER log the password (invariant 8).
      this.logger.log(`Seeded dev admin ${SEED_EMAIL} (password documented in the README)`);
    } catch (err) {
      // A racing first signup may already have created it — tolerate.
      this.logger.warn(`Dev-admin seed skipped: ${(err as Error).message}`);
    }
  }
}
