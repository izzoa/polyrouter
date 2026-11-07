/** DI token for the ONE plan-cooldown store of the application (classify-plan-quota-errors).
 * Kept in its own file so `ProvidersService` can inject it without importing the module
 * (and through it Redis and observability) into the provider layer. Re-exported by
 * `plan-cooldown.module.ts`. */
export const PLAN_COOLDOWN_STORE = 'polyrouter:plan-cooldown-store';
