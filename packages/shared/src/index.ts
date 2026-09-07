export const APP_NAME = 'polyrouter';
/** The polyrouter project's canonical public URL — used as the `HTTP-Referer` for OpenRouter
 * app attribution (add-openrouter-attribution). Deliberately NOT named `APP_URL`, which is the
 * operator's own instance origin (auth callbacks/cookies). A project constant, not per-instance. */
export const PROJECT_URL = 'https://polyrouter.app';
/** OpenRouter's API host — the gate for disclosing app-attribution headers. Kept as its own
 * constant (not the pricing `PROVIDER_FAMILY_HOSTS` map) so pricing-map growth can never broaden
 * what identity we disclose to whom. */
export const OPENROUTER_HOST = 'openrouter.ai';

export { formatRoutingTarget, parseRoutingTarget } from './routing-target';
export type { RoutingTarget } from './routing-target';
// Pure model-id variant primitives (add-model-variant-detection): browser-safe and
// shared verbatim with `@polyrouter/shared/server`, so the dashboard and the router
// classify a SKU identically — one parser, no drift.
export {
  MODEL_VARIANTS,
  NON_ROUTABLE_VARIANTS,
  isNonRoutableVariant,
  parseModelVariant,
} from './model-variants';
export type { ParsedModelVariant } from './model-variants';
export {
  AUTO_ALIAS,
  DEFAULT_TIER_KEY,
  MAX_MODELS_PER_TIER,
  RULE_MATCH_TYPES,
  SEMANTIC_WORKLOAD_CLASSES,
  SEMANTIC_WORKLOAD_CLASSIFIER_VERSION,
  STRUCTURAL_WORKLOAD_CLASSES,
  STRUCTURAL_WORKLOAD_CLASSIFIER_VERSION,
  TIER_HEADER_NAME,
  TIER_KEY_PATTERN,
  WORKLOAD_CLASSES,
  WORKLOAD_NONE,
  WORKLOAD_SOURCES,
  WORKLOAD_TAXONOMY_VERSION,
} from './routing-constants';
export type {
  RuleMatchType,
  SemanticWorkloadClass,
  StructuralWorkloadClass,
  WorkloadClass,
  WorkloadSource,
  WorkloadVerdictClass,
} from './routing-constants';
export { z } from 'zod';
export {
  ConfigRegistry,
  ConfigValidationError,
  configRegistry,
  registerConfig,
  loadConfig,
} from './config/registry';
export type { ConfigProblem, ConfigShape } from './config/registry';
export { BASE_CONFIG_NAMESPACE, baseConfigSchema } from './config/base';
export type { AppConfig, BaseConfig } from './config/base';
export { HARNESS_TYPES, HARNESS_LABELS, connectionSnippet, isHarnessType } from './harness';
export type { HarnessType } from './harness';
export { ATTEMPT_FAILURES_MAX } from './attempt-failures';
export {
  BATCH_COMPLETION_WINDOW_MS,
  BATCH_COMPLETION_WINDOW_TEXT,
  BATCH_ENDPOINTS,
  BATCH_JOB_ERROR_KINDS,
  BATCH_JOB_STATUSES,
  BATCH_JOB_TERMINAL_STATUSES,
  isBatchJobTerminal,
} from './batch-jobs';
export type {
  BatchEndpoint,
  BatchJobErrorKind,
  BatchJobStatus,
  BatchJobTerminalStatus,
} from './batch-jobs';
export type { AttemptFailureEntry } from './attempt-failures';
