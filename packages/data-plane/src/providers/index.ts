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
  AuthScheme,
  CallContext,
  ProviderModelInfo,
  ProviderListedPricing,
  ProviderModelCapabilities,
  ConnectionResult,
} from './adapter';
export { DEFAULT_FIRST_BYTE_TIMEOUT_MS, MAX_MODEL_ID_LEN } from './adapter';
export {
  ProviderError,
  ProviderCircuitOpenError,
  CallCancelledError,
  PROVIDER_ERROR_KINDS,
  shouldFallback,
  breakerImpact,
  classifyResponse,
  classifyNetworkError,
  classifyStreamError,
  captureProviderMessage,
  parseErrorEnvelope,
  sanitizeRequestId,
  scrubSecrets,
  VALIDATION_WITHHELD,
  POLICY_WITHHELD,
} from './errors';
export type { ProviderErrorKind, SanitizedMessage, CaptureInput, CaptureContext } from './errors';
export { createGuardedHttpClient, readSseChunks, joinUrl, openRequest } from './http';
export type { HttpBody, HttpClient, HttpResponse, HttpInit, GuardedClientOptions } from './http';
export { createHttpProviderAdapter, parseModelList } from './http-adapter';
export type { AdapterDeps, HttpAdapterSpec } from './http-adapter';
export type { BatchFactory, BatchTransport } from './batch/transport';
export { JsonStreamError, bytesOf, readJsonLines, scanTopLevelObject } from './batch/json-stream';
export type { JsonStreamEvent, JsonStreamFailure, JsonStreamOptions } from './batch/json-stream';
export { createOpenaiProviderAdapter } from './openai-adapter';
export { createAnthropicProviderAdapter } from './anthropic-adapter';
export { createResponsesProviderAdapter, guardEventIdle } from './responses-adapter';
export { createProviderAdapter, batchFactoryFor, servicingBatchFactoryFor } from './factory';
export type { BatchSeamInput } from './factory';
export {
  OPENROUTER_BATCH_STATUSES,
  OPENROUTER_STATUS_MAP,
  createOpenRouterBatchAdapter,
  openRouterBatchesUrl,
} from './batch/openrouter-batch';
export {
  ANTHROPIC_CUSTOM_ID,
  ANTHROPIC_PROCESSING_STATUSES,
  anthropicErrorKind,
  createAnthropicBatchAdapter,
  mapAnthropicStatus,
  parseMessageBatch,
} from './batch/anthropic-batch';
export {
  OPENAI_BATCH_STATUSES,
  OPENAI_JOB_ID_KEY,
  OPENAI_STATUS_MAP,
  createOpenAiBatchAdapter,
  multipartJsonl,
  parseOpenAiBatch,
} from './batch/openai-batch';
export { streamJsonDocument } from './batch/support';
export { BatchUpstreamNotFoundError, mapUpstreamStatus } from './batch';
export type {
  BatchAdapter,
  BatchLimits,
  BatchCounts,
  BatchItem,
  BatchItemOutcome,
  BatchListEntry,
  BatchStatusView,
  BatchSubmitInput,
  BatchSubmitResult,
  BatchUpstreamStatus,
} from './batch';
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
  BreakerAdmission,
  BreakerCompletion,
  BreakerOpenListener,
  BreakerStateListener,
} from './breaker';
export {
  PROBE_BOUND_CEILING_MS,
  PROBE_PATIENCE_MULTIPLIER,
  PROBE_RECORD_TTL_HEADROOM_MS,
  PROBE_SETTLE_HEADROOM_MS,
  probePatienceOf,
} from './probe-patience';
export type { ProbePatience } from './probe-patience';
