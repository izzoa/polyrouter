/**
 * The route record (record-route-legs): one entry per EXECUTED leg of a request's
 * chain walk, stored in `request_log.route_legs` and returned verbatim by the request
 * listing as `routeLegs`. It records what only the routing reason carried before
 * (design D2): why and when each leg ended, the member that stopped a walk, and the
 * leg's capability and output-cap deferrals and clamps.
 *
 * Structure only (invariant 8): every value is a fixed enum, a boolean, a non-negative
 * integer, or an external model id that `routing_reason` and `attempt_failures` already
 * carry. It holds no provider id, message, label, prompt or response text.
 *
 * Indexes are positions in the leg's EFFECTIVE walk order (after deferral), the same
 * space as `AttemptFailureEntry.index`, so a deferral, a clamp, a stopper and a trail
 * entry for one member share an index. The array is in execution order: `[primary]`,
 * `[cheap]`, or `[cheap, escalation]`.
 */

/** The executed leg. A non-cascade walk is `primary`. */
export type RouteLegName = 'primary' | 'cheap' | 'escalation';

/** The leg names, in execution order within a cascade. */
export const ROUTE_LEG_NAMES: readonly RouteLegName[] = ['primary', 'cheap', 'escalation'];

/**
 * How the leg ended (design D3), a closed enum:
 * - `served`: the leg's answer was used (a member answered, a stream committed, or a
 *   cheap answer was kept). What happens after a stream commits is the row's status.
 * - `gate_failed`: cheap only — the quality gate judged the answer bad; escalated.
 * - `replay_failed`: cheap only (streamed) — the answer passed the gate but could not
 *   be replayed to the client; escalated.
 * - `exhausted`: every member failed or was skipped.
 * - `stopped`: a non-retryable failure stopped the walk.
 * - `deadline`: the walk's own deadline ended it (today only the cascade cheap leg).
 * - `cancelled`: the client left before commit.
 */
export type RouteLegEnd =
  'served' | 'gate_failed' | 'replay_failed' | 'exhausted' | 'stopped' | 'deadline' | 'cancelled';

/** Every leg end. */
export const ROUTE_LEG_ENDS: readonly RouteLegEnd[] = [
  'served',
  'gate_failed',
  'replay_failed',
  'exhausted',
  'stopped',
  'deadline',
  'cancelled',
];

/** A capability a deferred member was asserted to lack. */
export type RouteCapability = 'tools' | 'vision';

/** The capabilities a deferral can name. */
export const ROUTE_CAPABILITIES: readonly RouteCapability[] = ['tools', 'vision'];

/** A member the plan moved behind the others (fallback-routing deliverability). */
export type RouteDeferral =
  | {
      readonly index: number;
      readonly model: string;
      readonly reason: 'output_cap';
      /** The member's known output-token cap, below the request's ask. */
      readonly cap: number;
    }
  | {
      readonly index: number;
      readonly model: string;
      readonly reason: 'capability';
      readonly capabilities: readonly RouteCapability[];
    };

/** A dispatched member whose output-token ask was lowered to its cap. */
export interface RouteClamp {
  readonly index: number;
  readonly model: string;
  /** The cap the member was sent with. */
  readonly to: number;
}

/** The member being attempted when a `stopped`, `deadline` or `cancelled` walk ended. */
export interface RouteStopper {
  readonly index: number;
  readonly model: string;
  /** Whether the member had been handed to its adapter (false: the end beat dispatch). */
  readonly sent: boolean;
  /** `stopped` only: the stopper's mapped error kind. */
  readonly kind?: string;
  /** `stopped` only: the upstream HTTP status, when one existed. */
  readonly status?: number;
}

export interface RouteLeg {
  readonly leg: RouteLegName;
  readonly end: RouteLegEnd;
  /** Integer ms from the request's start (the origin of `duration_ms`) to the instant
   * the walk handed its result to the router: a buffered leg when its response was
   * complete or it gave up, a streamed leg at commit or when it gave up before. */
  readonly endedMs: number;
  /** `served` | `gate_failed` | `replay_failed`: the member whose answer the leg produced. */
  readonly servedIndex?: number;
  /** `stopped` | `deadline` | `cancelled`, when a member was being attempted. */
  readonly stopped?: RouteStopper;
  /** The request's output-token ask: present exactly when the leg records an
   * `output_cap` deferral or a clamp. */
  readonly ask?: number;
  readonly deferred?: readonly RouteDeferral[];
  readonly clamps?: readonly RouteClamp[];
}

/** At most one record per executed leg: `[primary]` or `[cheap, escalation]`. */
export const ROUTE_LEGS_MAX = 2;

/** Bound on the deferrals, and on the clamps, of one leg. */
export const ROUTE_LEG_LIST_MAX = 32;
