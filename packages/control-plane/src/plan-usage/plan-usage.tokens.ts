/** DI tokens of the plan-usage module (add-subscription-quota-display, design D6). Kept in their
 * own file so a consumer can inject them without importing the module (and through it Redis and
 * observability) into its own layer. Re-exported by `plan-usage.module.ts`. */

/** The ONE failover plan-usage store of the application. */
export const PLAN_USAGE_STORE = 'polyrouter:plan-usage-store';

/** The ONE recorder in front of that store; the proxy's circuit breaker hosts it. */
export const PLAN_USAGE_RECORDER = 'polyrouter:plan-usage-recorder';

/** The usage-endpoint read function. Bound with `useValue` to `readPlanUsage`, so an e2e suite
 * replaces it with `.overrideProvider(PLAN_USAGE_READER)` and never reaches a real provider. */
export const PLAN_USAGE_READER = 'polyrouter:plan-usage-reader';
