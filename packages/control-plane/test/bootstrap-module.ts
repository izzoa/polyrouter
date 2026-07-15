import { Module } from '@nestjs/common';
import { HealthController } from '../src/health/health.controller';

/** Minimal module for app-bootstrap e2e (ValidationPipe, health, CORS, SPA).
 * Deliberately excludes the auth plane so these suites don't pull in the
 * ESM-only better-auth package — the real-app auth integration (including the
 * health @Public exemption under the session guard) is covered by auth.e2e. */
@Module({ controllers: [HealthController] })
export class BootstrapTestModule {}
