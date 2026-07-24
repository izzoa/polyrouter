import { Injectable } from '@nestjs/common';
import type { Principal } from '@polyrouter/shared/server';
import type { AuthedRequest } from '../auth/principal.decorator';
import { SessionGuard } from '../auth/session.guard';

/**
 * Re-checks a long-lived stream's authorization (phase2-add-dashboard-event-stream).
 *
 * A seam, not a convenience: the controller must not depend on `SessionGuard`
 * directly (that would drag the ESM-only auth stack into every test that touches the
 * endpoint), while revalidation must still apply EXACTLY the guard's rules — including
 * self-host loopback auto-login. The production adapter therefore delegates to the
 * guard's single `resolvePrincipal` path, so the two can never drift.
 */
export interface StreamAuthorizer {
  revalidate(req: AuthedRequest): Promise<Principal | null>;
}

export const STREAM_AUTHORIZER = 'polyrouter:stream-authorizer';

@Injectable()
export class GuardStreamAuthorizer implements StreamAuthorizer {
  constructor(private readonly guard: SessionGuard) {}

  revalidate(req: AuthedRequest): Promise<Principal | null> {
    return this.guard.resolvePrincipal(req);
  }
}
