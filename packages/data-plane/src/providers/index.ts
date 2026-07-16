/**
 * Public surface of the provider-call layer. Consumed by #7 (management/catalog
 * sync) and #10 (proxy routing/fallback). Consumes #5's IR; stores nothing.
 */
export type {
  ProviderAdapter,
  ProviderConfig,
  ProviderKind,
  ProviderProtocol,
  RuntimeMode,
  CallContext,
  ProviderModelInfo,
  ConnectionResult,
} from './adapter';
export { DEFAULT_FIRST_BYTE_TIMEOUT_MS } from './adapter';
export {
  ProviderError,
  ProviderCircuitOpenError,
  CallCancelledError,
  shouldFallback,
  breakerImpact,
  classifyResponse,
  classifyNetworkError,
  classifyStreamError,
} from './errors';
export type { ProviderErrorKind } from './errors';
export { createGuardedHttpClient, readSseChunks, joinUrl, openRequest } from './http';
export type { HttpClient, HttpResponse, HttpInit, GuardedClientOptions } from './http';
export { createHttpProviderAdapter, parseModelList } from './http-adapter';
export type { AdapterDeps, HttpAdapterSpec } from './http-adapter';
export { createOpenaiProviderAdapter } from './openai-adapter';
export { createAnthropicProviderAdapter } from './anthropic-adapter';
export { createProviderAdapter } from './factory';
export {
  CircuitBreaker,
  InMemoryBreakerStore,
  RedisBreakerStore,
  withBreaker,
  withBreakerStream,
  decide,
  applyComplete,
  DEFAULT_BREAKER_CONFIG,
  INITIAL_RECORD,
} from './breaker';
export type {
  BreakerStore,
  BreakerConfig,
  BreakerRecord,
  BreakerState,
  BreakerOutcome,
  BreakerDecision,
  BreakerToken,
  BreakerRedis,
  CircuitBreakerOptions,
  Admission,
  BreakerCompletion,
  BreakerOpenListener,
  BreakerStateListener,
} from './breaker';
