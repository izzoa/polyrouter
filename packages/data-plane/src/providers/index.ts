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
  ModelListing,
  ProviderListedPricing,
  ProviderModelCapabilities,
  ConnectionResult,
} from './adapter';
export { DEFAULT_FIRST_BYTE_TIMEOUT_MS, MAX_MODEL_ID_LEN, MAX_PARSED_MODELS } from './adapter';
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
export type {
  ProviderErrorKind,
  SanitizedMessage,
  CaptureInput,
  CaptureContext,
  ClassifyMeta,
} from './errors';
export {
  KIMI_MESSAGES,
  MINIMAX_CODES,
  ZAI_CODES,
  ZAI_FLUSH_TIME_ZONE,
  classifyPlanError,
  parseRetryAfter,
  parseZaiResetTime,
} from './plan-errors';
export type {
  KimiPlanErrorEntry,
  PlanClassification,
  PlanErrorDialect,
  PlanErrorEntry,
  PlanHeaders,
  PlanReset,
  PlanWindow,
} from './plan-errors';
export {
  DEFAULT_PLAN_COOLDOWN_CONFIG,
  FailoverPlanCooldownStore,
  InMemoryPlanCooldownStore,
  PLAN_COOLDOWN_KINDS,
  RedisPlanCooldownStore,
  computeUntil,
  isPlanCooldownKind,
  planDefaultMs,
} from './plan-cooldown';
export type {
  PlanCooldown,
  PlanCooldownConfig,
  PlanCooldownInput,
  PlanCooldownKind,
  PlanCooldownSource,
  PlanCooldownStore,
} from './plan-cooldown';
export {
  MAX_TAP_LINE_BYTES,
  PLAN_USAGE_DIALECTS,
  parseAnthropicUnified,
  parseCodex,
  parsePlanUsageHeaders,
  readOpencodeBillingFromJson,
  tapUsageFrames,
} from './plan-usage';
export type {
  PlanUsageBilling,
  PlanUsageDialect,
  PlanUsageObservation,
  PlanUsageReset,
  PlanUsageSpan,
  PlanUsageWindow,
  UsageHeaders,
} from './plan-usage';
export {
  CLAIM_REFRESH_LUA,
  CLEAR_LUA,
  EXTEND_REFRESH_LUA,
  FailoverPlanUsageStore,
  InMemoryPlanUsageStore,
  MERGE_LUA,
  PLAN_USAGE_LIMITS,
  PlanUsageRecorder,
  READ_MANY_LUA,
  RedisPlanUsageStore,
  mergeSnapshot,
  parseSnapshot,
  sanitizeObservation,
  snapshotExpiresAt,
} from './plan-usage-store';
export type {
  FailoverPlanUsageOptions,
  PlanUsageMergeResult,
  PlanUsageRead,
  PlanUsageRecorderOptions,
  PlanUsageRefreshClaim,
  PlanUsageSnapshot,
  PlanUsageSource,
  PlanUsageStore,
  StoredPlanUsageBilling,
  StoredPlanUsageWindow,
} from './plan-usage-store';
export {
  PLAN_USAGE_ANTHROPIC_BETA,
  PLAN_USAGE_EXTRA_HEADERS,
  PLAN_USAGE_PARSER_IDS,
  USAGE_MESSAGES,
  USAGE_READ_MAX_BYTES,
  USAGE_READ_TIMEOUT_MS,
  parsePlanUsageBody,
  readPlanUsage,
} from './plan-usage-read';
export type {
  PlanUsageExtraHeader,
  PlanUsageParserId,
  PlanUsageProbe,
  PlanUsageReadDeps,
  PlanUsageReadResult,
} from './plan-usage-read';
export { createGuardedHttpClient, readSseChunks, joinUrl, openRequest } from './http';
export type { HttpBody, HttpClient, HttpResponse, HttpInit, GuardedClientOptions } from './http';
export { createHttpProviderAdapter, parseModelList } from './http-adapter';
export { mergeHeaderLayers } from './header-layers';
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
  BreakerCompletionSource,
  BreakerOpenListener,
  BreakerSettleInfo,
  BreakerSettleListener,
  BreakerSettlement,
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
