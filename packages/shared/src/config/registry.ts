import { z } from 'zod';

/** A validated, merged configuration object keyed by environment-variable name. */
export type ConfigShape = Record<string, unknown>;

export interface ConfigProblem {
  variable: string;
  reason: string;
}

/**
 * Thrown when boot-time validation fails. The message names each offending
 * variable and why it is invalid, but never echoes the supplied value —
 * config errors must be safe to log even for secret variables.
 */
export class ConfigValidationError extends Error {
  public readonly problems: readonly ConfigProblem[];

  constructor(problems: ConfigProblem[]) {
    const lines = problems.map((p) => `  - ${p.variable}: ${p.reason}`);
    super(
      `Invalid configuration:\n${lines.join('\n')}\n` +
        'Fix the environment variables above and restart (values are never printed).',
    );
    this.name = 'ConfigValidationError';
    this.problems = problems;
  }
}

/** Builds a human-readable reason from a zod issue without ever including the input value. */
function describeIssue(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return `expected ${issue.expected}`;
    case 'invalid_value':
      return `expected one of: ${issue.values.map((v) => JSON.stringify(v)).join(', ')}`;
    case 'too_small':
      return `below minimum (${String(issue.minimum)})`;
    case 'too_big':
      return `above maximum (${String(issue.maximum)})`;
    case 'invalid_format':
      return `invalid format (expected ${issue.format})`;
    case 'custom':
      // refine() messages are author-controlled constants — never input values.
      return issue.message || 'invalid value';
    default:
      return 'invalid value';
  }
}

/**
 * Registry of per-capability config fragments. Each capability registers the
 * environment variables it introduces under a unique namespace; `load()`
 * validates the whole set exactly once at boot and fails fast on any problem.
 */
export class ConfigRegistry {
  private readonly fragments = new Map<string, z.ZodObject>();
  /** env var name -> owning namespace, to reject two fragments claiming one variable. */
  private readonly owners = new Map<string, string>();

  register(namespace: string, schema: z.ZodObject): void {
    if (this.fragments.has(namespace)) {
      throw new Error(`Config namespace "${namespace}" is already registered`);
    }
    for (const key of Object.keys(schema.shape)) {
      const owner = this.owners.get(key);
      if (owner !== undefined) {
        throw new Error(
          `Environment variable "${key}" is already registered by namespace "${owner}"`,
        );
      }
    }
    this.fragments.set(namespace, schema);
    for (const key of Object.keys(schema.shape)) {
      this.owners.set(key, namespace);
    }
  }

  load(env: NodeJS.ProcessEnv = process.env): ConfigShape {
    const problems: ConfigProblem[] = [];
    const merged: ConfigShape = {};
    for (const schema of this.fragments.values()) {
      const picked: Record<string, string | undefined> = {};
      for (const key of Object.keys(schema.shape)) {
        picked[key] = env[key];
      }
      const result = schema.safeParse(picked);
      if (result.success) {
        Object.assign(merged, result.data);
      } else {
        for (const issue of result.error.issues) {
          problems.push({
            variable: String(issue.path[0] ?? '(unknown)'),
            reason: describeIssue(issue),
          });
        }
      }
    }
    if (problems.length > 0) {
      throw new ConfigValidationError(problems);
    }
    return merged;
  }
}

/** The process-wide registry used by the application. Tests may construct their own. */
export const configRegistry = new ConfigRegistry();

export function registerConfig(namespace: string, schema: z.ZodObject): void {
  configRegistry.register(namespace, schema);
}

export function loadConfig<T extends ConfigShape = ConfigShape>(
  env: NodeJS.ProcessEnv = process.env,
): T {
  return configRegistry.load(env) as T;
}
