import { registerConfig, z } from '@polyrouter/shared';
import { bootstrap } from '../main';

/**
 * Test-only entrypoint for the fail-fast boot e2e. The initial variable set
 * is all-defaulted, so this registers a REQUIRED variable and then runs the
 * real bootstrap: spawned without TEST_REQUIRED_TOKEN it must exit non-zero
 * naming the variable (and never a value).
 */
registerConfig('boot-failfast-fixture', z.object({ TEST_REQUIRED_TOKEN: z.string() }));

void bootstrap();
