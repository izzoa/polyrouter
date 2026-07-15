/** A RoutingRule's `target` is stored as one opaque string; this is the single
 * parser/formatter both the management API (#9) and the proxy (#10) use, so a
 * target is encoded and decoded identically on both sides. Pure — no throw.
 *
 * Format: `tier:<key>` or `model:<id>`. The reference (`key`/`id`) is the
 * remainder after the first `:`, verbatim — model ids and tier keys are opaque
 * and may themselves contain characters, so we split only on the first colon. */

export type RoutingTarget = { kind: 'tier'; key: string } | { kind: 'model'; id: string };

const TIER_PREFIX = 'tier:';
const MODEL_PREFIX = 'model:';

/** Parse a stored target. Returns null on any malformed input (unknown prefix
 * or empty reference) — callers surface a clean validation error, never a throw. */
export function parseRoutingTarget(raw: string): RoutingTarget | null {
  if (raw.startsWith(TIER_PREFIX)) {
    const key = raw.slice(TIER_PREFIX.length);
    return key.length > 0 ? { kind: 'tier', key } : null;
  }
  if (raw.startsWith(MODEL_PREFIX)) {
    const id = raw.slice(MODEL_PREFIX.length);
    return id.length > 0 ? { kind: 'model', id } : null;
  }
  return null;
}

/** Format a target back to its stored string. Round-trips with parseRoutingTarget. */
export function formatRoutingTarget(target: RoutingTarget): string {
  return target.kind === 'tier' ? `${TIER_PREFIX}${target.key}` : `${MODEL_PREFIX}${target.id}`;
}
