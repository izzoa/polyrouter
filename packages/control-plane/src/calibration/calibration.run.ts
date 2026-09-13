import { Logger } from '@nestjs/common';
import {
  userPrincipal,
  type CalibrationSweepTenant,
  type PersistencePort,
  type RoutingSettingsValue,
  type ThresholdCalibrationEventInput,
  type ThresholdCalibrationEventRowView,
  type CalibrationSweepAgent,
  type CalibrationEdgeStats,
} from '@polyrouter/shared/server';
import { effectiveThresholds, type StructuralConfig } from '../proxy/routing.config';
import { calibrationHalted, gapAdmissible } from './calibration.config';
import {
  COOLDOWN_DAYS,
  EDGE_WIDTH,
  RATE_HIGH,
  RATE_LOW,
  type CalibrationConfig,
  type CalibrationRails,
} from './calibration.config';

/** One sweep's outcome — the job log line. */
export interface OccurrenceSummary {
  tenants: number;
  moves: number;
  rebases: number;
  skips: number;
}

interface EdgeDecision {
  edge: 'high' | 'low';
  samples: number;
  failures: number;
  rate: number;
  /** Evidence strength for joint-gap arbitration as an EXACT rational
   * |failures/samples − bound| = |failures·10⁴ − bound₁₀₄·samples| / (samples·10⁴)
   * (r3-Med-4): raw float subtraction turns mathematically-equal deviations
   * into unequal doubles and breaks the high-edge tie-break. */
  strengthNum: number;
  strengthDen: number;
}

const DAY_MS = 86_400_000;

/** Per-edge cooldown, evaluated within ONE scope (add-per-agent-calibration).
 * `agentId === null` selects the tenant's own events; an agent id selects that
 * agent's. Nothing crosses: a tenant move places no agent's edge in cooldown,
 * and one agent's move places none on another's. */
function cooldownFor(
  recent: readonly ThresholdCalibrationEventRowView[],
  agentId: string | null,
  now: number,
): (edge: 'high' | 'low') => boolean {
  const cooledSince = now - COOLDOWN_DAYS * DAY_MS;
  return (edge) =>
    recent.some(
      (e) =>
        e.agentId === agentId && e.edge === edge && Date.parse(e.createdAt) > cooledSince,
    );
}

/** Threshold arithmetic is 4-decimal: repeated binary-float steps (0.47 −
 * 0.02 = 0.44999999999999996) would drift the stored pair, break the anchor
 * equality check, and miss inclusive rail boundaries. Every derived
 * threshold value is rounded before comparison or persistence. */
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

const fmt = (n: number): string => n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');

/** Is `pref`'s stored pair inert under the CURRENT config — anchor mismatch or
 * rail violation? (The hot path's `effectiveThresholds` makes the same call;
 * this names the hygiene condition.) */
function pairIsStale(
  cfg: Pick<StructuralConfig, 'high' | 'low'>,
  pref: RoutingSettingsValue,
  rails: CalibrationRails,
): boolean {
  if (pref.calibratedHigh === null) return false; // nothing stored
  const eff = effectiveThresholds(cfg, pref, rails);
  return eff.high !== pref.calibratedHigh || eff.low !== pref.calibratedLow;
}

/**
 * One calibration sweep (add-auto-threshold-calibration), extracted queue-free
 * for direct unit testing. Pass A retires stale stored pairs for EVERY tenant
 * holding one (enabled or not — no pair may lurk to silently reactivate);
 * Pass B applies bounded moves for calibration-enabled tenants. Every write is
 * conditional on the observed state (a concurrent user action wins) and
 * transactional with its audit event(s). A failing tenant is logged
 * (secret-free) and the sweep continues (invariant 11 analog).
 */
export async function runCalibrationOccurrence(
  db: PersistencePort,
  structural: Pick<StructuralConfig, 'high' | 'low'>,
  cfg: CalibrationConfig,
  rails: CalibrationRails,
  now: number,
  logger: Pick<Logger, 'warn' | 'log'> = new Logger('Calibration'),
): Promise<OccurrenceSummary> {
  const summary: OccurrenceSummary = { tenants: 0, moves: 0, rebases: 0, skips: 0 };

  // --- Pass A: hygiene — rebase stale pairs regardless of the enabled flag.
  let stored: CalibrationSweepTenant[] = [];
  try {
    stored = await db.routingSettings.listWithCalibratedPair();
  } catch (err) {
    logger.warn(`calibration hygiene enumeration failed: ${String((err as Error).message)}`);
  }
  for (const t of stored) {
    try {
      const v = t.value;
      if (!pairIsStale(structural, v, rails)) continue;
      const applied = await db.routingSettings.setCalibrated(
        userPrincipal(t.ownerUserId),
        null,
        {
          enabled: null, // hygiene applies to disabled tenants too
          high: v.calibratedHigh,
          low: v.calibratedLow,
          anchorHigh: v.calibratedAnchorHigh,
          anchorLow: v.calibratedAnchorLow,
          epoch: v.calibrationEpoch,
        },
        {
          trigger: 'rebase',
          oldHigh: v.calibratedHigh ?? structural.high,
          oldLow: v.calibratedLow ?? structural.low,
          newHigh: structural.high,
          newLow: structural.low,
          anchorHigh: structural.high,
          anchorLow: structural.low,
          reason: `rebase; oldAnchor=${fmt(v.calibratedAnchorHigh ?? -1)}/${fmt(v.calibratedAnchorLow ?? -1)}; instance=${fmt(structural.high)}/${fmt(structural.low)}`,
        },
      );
      if (applied) summary.rebases += 1;
    } catch (err) {
      summary.skips += 1;
      logger.warn(`calibration rebase failed for a tenant: ${String((err as Error).message)}`);
    }
  }

  // --- Pass A2: agent hygiene — stale-anchored pairs and self-silenced ones,
  // for EVERY tenant regardless of its flag (add-per-agent-calibration).
  try {
    summary.rebases += await hygieneAgents(db, structural, cfg, rails, now, logger);
  } catch (err) {
    logger.warn(`agent hygiene failed: ${String((err as Error).message)}`);
  }

  // --- Pass B: moves — calibration-enabled tenants only.
  let enabled: CalibrationSweepTenant[];
  try {
    enabled = await db.routingSettings.listCalibrationEnabled();
  } catch (err) {
    logger.warn(`calibration enumeration failed: ${String((err as Error).message)}`);
    return summary;
  }
  summary.tenants = enabled.length;

  for (const t of enabled) {
    try {
      const moved = await calibrateTenant(db, structural, cfg, rails, now, t);
      if (moved === 'moved') summary.moves += 1;
      else if (moved === 'skipped') summary.skips += 1;
      // --- Pass C: the SAME standard, one scope down. Runs after the tenant's
      // own pass so an agent anchors to the pair the tenant just settled on,
      // rather than to one this occurrence is about to replace.
      const agentOutcome = await calibrateAgents(db, structural, cfg, rails, now, t);
      summary.moves += agentOutcome.moves;
      summary.skips += agentOutcome.skips;
    } catch (err) {
      summary.skips += 1;
      logger.warn(`calibration skipped a tenant: ${String((err as Error).message)}`);
    }
  }
  logger.log(
    `calibration sweep: tenants=${String(summary.tenants)} moves=${String(summary.moves)} rebases=${String(summary.rebases)} skips=${String(summary.skips)}`,
  );
  return summary;
}

async function calibrateTenant(
  db: PersistencePort,
  structural: Pick<StructuralConfig, 'high' | 'low'>,
  cfg: CalibrationConfig,
  rails: CalibrationRails,
  now: number,
  t: CalibrationSweepTenant,
): Promise<'moved' | 'skipped' | 'noop'> {
  const principal = userPrincipal(t.ownerUserId);
  const v = t.value;
  if (v.calibratedHigh !== null && pairIsStale(structural, v, rails)) return 'noop'; // pass A owns it
  // Degenerate configs: rails cannot hold — no moves (r1-High-2/r2-High-1).
  // INCLUSIVE overlap comparison: the zones are [high−w, high) and
  // (low, low+w], so equality means one shared score.
  const eff = effectiveThresholds(structural, v, rails);
  // One shared definition with the read-time evidence report
  // (fix-calibration-evidence-honesty) — same two conditions, same rounding.
  if (calibrationHalted(structural, eff, rails)) return 'skipped';

  const anchorHigh = v.calibratedAnchorHigh ?? structural.high;
  const anchorLow = v.calibratedAnchorLow ?? structural.low;

  // Per-edge cooldown from the tenant's recent events (daily cadence — 20
  // rows comfortably cover the cooldown window). SCOPED: only tenant-scope
  // events (`agentId === null`) place a tenant edge in cooldown, so one
  // agent's move never freezes the tenant's, nor another agent's
  // (add-per-agent-calibration). The cooldown is per edge PER SCOPE, exactly
  // as the floor and every other rail is.
  const recent = await db.calibrationEvents.list(principal, 60);
  const inCooldown = cooldownFor(recent, null, now);

  const stats = await db.analytics.calibrationStats(
    principal,
    { from: new Date(now - cfg.windowDays * DAY_MS), to: new Date(now) },
    { high: eff.high, low: eff.low, edgeWidth: EDGE_WIDTH, epoch: v.calibrationEpoch },
  );

  const outcome = decideMove({
    base: structural,
    eff,
    anchorHigh,
    anchorLow,
    stats,
    inCooldown,
    cfg,
    rails,
    now,
  });
  if (outcome.kind === 'noop') return 'noop';

  // Conditional transactional apply — observed state or nothing (r1-Med-5);
  // one audit row per applied edge in the same transaction.
  const ok = await db.routingSettings.setCalibrated(
    principal,
    {
      high: outcome.target.high,
      low: outcome.target.low,
      anchorHigh: structural.high,
      anchorLow: structural.low,
    },
    {
      enabled: true,
      high: v.calibratedHigh,
      low: v.calibratedLow,
      anchorHigh: v.calibratedAnchorHigh,
      anchorLow: v.calibratedAnchorLow,
      epoch: v.calibrationEpoch,
    },
    outcome.events,
  );
  return ok ? 'moved' : 'skipped'; // skipped = a concurrent user action won
}

/** The DECISION core, shared verbatim by both scopes (add-per-agent-calibration).
 *
 * Every rail value, the arbitration and the survivor re-check live here and
 * nowhere else, so "the same standard at agent scope" is a fact about the code
 * rather than a promise in a document. The scopes differ ONLY in what they pass
 * in: the tenant anchors to the instance defaults, an agent to its tenant's
 * effective pair, and an agent additionally carries `globalBound` so the two
 * levels' drift caps cannot compound. */
export interface MoveInputs {
  /** The level ABOVE: instance defaults for a tenant, the tenant's effective
   * pair for an agent. Used for the halt check and stamped as the event anchor. */
  readonly base: { high: number; low: number };
  /** This scope's current effective pair. */
  readonly eff: { high: number; low: number };
  /** The stored anchor this scope's drift is measured from. */
  readonly anchorHigh: number;
  readonly anchorLow: number;
  readonly stats: CalibrationEdgeStats;
  readonly inCooldown: (edge: 'high' | 'low') => boolean;
  readonly cfg: CalibrationConfig;
  readonly rails: CalibrationRails;
  readonly now: number;
  /** The instance defaults, for the GLOBAL drift bound. Agent scope only: a
   * tenant at +cap and an agent at +cap beyond it is 2x cap from the instance,
   * outside the safety envelope (design Decision 4). Omitted at tenant scope,
   * where `anchorHigh`/`anchorLow` ARE the instance defaults. */
  readonly globalBound?: { high: number; low: number };
}

export type MoveOutcome =
  | { kind: 'noop' }
  | { kind: 'move'; target: { high: number; low: number }; events: ThresholdCalibrationEventInput[] };

export function decideMove(p: MoveInputs): MoveOutcome {
  const { eff, cfg, rails, now, anchorHigh, anchorLow, stats } = p;
  const candidates: EdgeDecision[] = [];
  const he = stats.highEdge;
  if (he.samples >= cfg.minEdgeSamples) {
    const rate = he.failures / he.samples;
    if (
      rate >= RATE_HIGH &&
      round4(eff.high - cfg.step) >= round4(anchorHigh - cfg.maxDrift) &&
      round4(eff.high - cfg.step) < eff.high && // never a zero-value move
      !p.inCooldown('high')
    ) {
      candidates.push({
        edge: 'high',
        samples: he.samples,
        failures: he.failures,
        rate,
        strengthNum: Math.abs(he.failures * 10_000 - RATE_HIGH * 10_000 * he.samples),
        strengthDen: he.samples * 10_000,
      });
    }
  }
  const le = stats.lowEdge;
  if (le.samples >= cfg.minEdgeSamples) {
    const rate = le.failures / le.samples;
    if (
      rate <= RATE_LOW &&
      round4(eff.low + cfg.step) <= round4(anchorLow + cfg.maxDrift) &&
      round4(eff.low + cfg.step) > eff.low && // never a zero-value move
      !p.inCooldown('low')
    ) {
      candidates.push({
        edge: 'low',
        samples: le.samples,
        failures: le.failures,
        rate,
        strengthNum: Math.abs(le.failures * 10_000 - RATE_LOW * 10_000 * le.samples),
        strengthDen: le.samples * 10_000,
      });
    }
  }
  if (candidates.length === 0) return { kind: 'noop' };

  // EVERY final candidate is gap-checked (r2-High-1): joint first; if the
  // joint pair breaches, keep the stronger-evidenced edge (tie → high — its
  // failures are the costlier mistake), then re-check the survivor ALONE and
  // apply nothing if it still breaches.
  let applied = [...candidates];
  const finalPair = (list: EdgeDecision[]): { high: number; low: number } => ({
    high: round4(eff.high - (list.some((c) => c.edge === 'high') ? cfg.step : 0)),
    low: round4(eff.low + (list.some((c) => c.edge === 'low') ? cfg.step : 0)),
  });
  const gapOf = (pair: { high: number; low: number }): number => round4(pair.high - pair.low);
  // `gapAdmissible`, not a bare `< minGap`: the minimum gap equals twice the
  // edge width at the shipped constants, so a bare check admits a pair whose
  // zones are tangent and which `calibrationHalted` then freezes forever
  // (fix-tangent-gap-rail).
  if (!gapAdmissible(gapOf(finalPair(applied)), rails) && applied.length === 2) {
    // Exact cross-multiplied comparison — integer arithmetic, no float noise;
    // a TRUE tie deterministically keeps the high edge (r3-Med-4).
    applied.sort((a, b) => {
      const cmp = b.strengthNum * a.strengthDen - a.strengthNum * b.strengthDen;
      if (cmp !== 0) return cmp;
      return a.edge === 'high' ? -1 : 1;
    });
    applied = [applied[0]!];
  }
  if (!gapAdmissible(gapOf(finalPair(applied)), rails)) return { kind: 'noop' };

  const target = finalPair(applied);
  // The GLOBAL bound (agent scope only): the caps must not compound across the
  // two levels. Checked on the TARGET, so a move is refused rather than
  // written and then inerted by the resolver on the next read.
  const g = p.globalBound;
  if (
    g !== undefined &&
    (round4(g.high - target.high) > cfg.maxDrift || round4(target.low - g.low) > cfg.maxDrift)
  ) {
    return { kind: 'noop' };
  }

  // Sequential per-edge events (high first) so before/after pairs chain
  // linearly (r2-Low-7).
  applied.sort((a) => (a.edge === 'high' ? -1 : 1));
  let cursor = { high: eff.high, low: eff.low };
  const events: ThresholdCalibrationEventInput[] = applied.map((c) => {
    const next = {
      high: c.edge === 'high' ? round4(cursor.high - cfg.step) : cursor.high,
      low: c.edge === 'low' ? round4(cursor.low + cfg.step) : cursor.low,
    };
    const e: ThresholdCalibrationEventInput = {
      trigger: 'calibrator',
      oldHigh: cursor.high,
      oldLow: cursor.low,
      newHigh: next.high,
      newLow: next.low,
      anchorHigh: p.base.high,
      anchorLow: p.base.low,
      windowFrom: new Date(now - cfg.windowDays * DAY_MS),
      windowTo: new Date(now),
      edge: c.edge,
      edgeSamples: c.samples,
      edgeFailures: c.failures,
      reason: `edge=${c.edge}; n=${String(c.samples)}; fail=${String(c.failures)}; rate=${c.rate.toFixed(3)}; ${fmt(c.edge === 'high' ? cursor.high : cursor.low)}→${fmt(c.edge === 'high' ? next.high : next.low)}`,
    };
    cursor = next;
    return e;
  });
  return { kind: 'move', target, events };
}




/** The parent pair, re-read so a tenant move applied moments ago in Pass B is
 * already reflected. Any failure degrades to the value the sweep already holds:
 * this pass must never make a tenant's own move look skipped (invariant 1). */
async function safeSettings(
  db: PersistencePort,
  principal: ReturnType<typeof userPrincipal>,
): Promise<RoutingSettingsValue | null> {
  try {
    return await db.routingSettings.get(principal);
  } catch {
    return null;
  }
}

/** Pass C — per-AGENT moves, under the identical standard (add-per-agent-calibration).
 *
 * Same floor, statistic, step, drift cap, gap, hysteresis, cooldown and
 * contraction-only rule, because it calls `decideMove` — the one place any of
 * those live. What differs is only the inputs: an agent anchors to its
 * tenant's EFFECTIVE pair, draws its own evidence, carries its own epoch and
 * cooldown, and is additionally bounded globally from the instance defaults.
 *
 * An agent below the floor simply earns nothing and keeps inheriting. That is
 * the designed steady state, not a failure to act. */
async function calibrateAgents(
  db: PersistencePort,
  structural: Pick<StructuralConfig, 'high' | 'low'>,
  cfg: CalibrationConfig,
  rails: CalibrationRails,
  now: number,
  t: CalibrationSweepTenant,
): Promise<{ moves: number; skips: number }> {
  const out = { moves: 0, skips: 0 };
  const principal = userPrincipal(t.ownerUserId);
  const v = t.value;

  // The parent the agents refine.
  const parentValue = (await safeSettings(db, principal)) ?? v;
  const parent = effectiveThresholds(structural, parentValue, rails);

  // A degenerate PARENT halts every agent beneath it: an agent's zones are
  // carved out of the same interval, so if the parent's already touch, no
  // agent pair inside it can avoid it (task 4.5). Same predicate as the tenant
  // scope — a restatement here is how the two would drift apart.
  if (calibrationHalted(structural, parent, rails)) return out;

  let agentRows: CalibrationSweepAgent[];
  let recent: ThresholdCalibrationEventRowView[];
  try {
    agentRows = await db.agentCalibration.listForCalibration(principal);
    if (agentRows.length === 0) return out;
    recent = await db.calibrationEvents.list(principal, 200);
  } catch {
    // An instance that has not yet wired the agent surfaces, or a transient
    // read failure: the tenant scope is unaffected and keeps working. Degrade,
    // never fail (invariant 1).
    return out;
  }
  const window = { from: new Date(now - cfg.windowDays * DAY_MS), to: new Date(now) };

  for (const a of agentRows) {
    try {
      const promoted = a.calibratedHigh !== null;
      // A stale agent pair is Pass A's business (one level down), not a move's.
      const own = effectiveThresholds(parent, a, rails);
      if (promoted && own.high === parent.high && own.low === parent.low) continue;

      // The agent's own zones must clear the shared gap rail inside the parent.
      if (calibrationHalted(parent, own, rails)) {
        out.skips += 1;
        continue;
      }

      const stats = await db.analytics.calibrationStats(principal, window, {
        high: own.high,
        low: own.low,
        edgeWidth: EDGE_WIDTH,
        // Membership and freshness travel together: a promoted agent reads its
        // OWN epoch over agent-scoped rows; an unpromoted one bootstraps from
        // its tenant-scoped rows at the TENANT's epoch.
        epoch: promoted ? a.calibrationEpoch : parentValue.calibrationEpoch,
        scope: promoted
          ? { kind: 'agent', agentId: a.id }
          : { kind: 'agent-bootstrap', agentId: a.id },
      });

      const outcome = decideMove({
        base: parent,
        eff: own,
        anchorHigh: a.calibratedAnchorHigh ?? parent.high,
        anchorLow: a.calibratedAnchorLow ?? parent.low,
        stats,
        inCooldown: cooldownFor(recent, a.id, now),
        cfg,
        rails,
        now,
        globalBound: structural,
      });
      if (outcome.kind === 'noop') continue;

      const applied = await db.agentCalibration.setCalibrated(
        principal,
        a.id,
        {
          high: outcome.target.high,
          low: outcome.target.low,
          anchorHigh: parent.high,
          anchorLow: parent.low,
        },
        {
          high: a.calibratedHigh,
          low: a.calibratedLow,
          anchorHigh: a.calibratedAnchorHigh,
          anchorLow: a.calibratedAnchorLow,
          epoch: a.calibrationEpoch,
        },
        // A promotion or move DERIVES its anchor from the parent, so it pins
        // the parent it read (design Decision 7). A tenant move that lands
        // first makes this fail rather than writing a pair stale on arrival.
        {
          high: parentValue.calibratedHigh,
          low: parentValue.calibratedLow,
          epoch: parentValue.calibrationEpoch,
          membershipGeneration: parentValue.membershipGeneration,
        },
        outcome.events,
      );
      if (applied) out.moves += 1;
      else out.skips += 1;
    } catch {
      out.skips += 1;
    }
  }
  return out;
}


/** Pass A2 — agent hygiene (add-per-agent-calibration).
 *
 * Two reasons to retire an agent pair, both conditional clears back to
 * inherited, audited, epoch advanced:
 *
 * 1. STALE ANCHOR or rail violation — the tenant moved (or the rails tightened)
 *    and the pair no longer applies. This is also the automatic DEMOTION that
 *    automatic promotion requires: nothing else would ever take a pair away.
 *
 * 2. STARVATION — the ratchet's recovery. A homogeneous agent whose score mass
 *    sits inside an edge zone can have its threshold walked across that mass in
 *    a few steps, after which every one of its rows bands confidently, stops
 *    being an ambiguous cascade row, and its evidence stream ends. One-way into
 *    silence, with no recovery: v1 assumed the next tenant move would rebase
 *    it, but the silenced agent is usually the one supplying the volume, so its
 *    tenant's pool may never reach the floor again.
 *
 * The starvation rail is deliberately NARROW, because the obvious version
 * clears pairs for reasons that have nothing to do with the pair. The evidence
 * population requires `decision_layer = 'cascade'`, so a tenant that switches
 * cascade off would otherwise lose every agent pair one window later; and the
 * window is bounded by `created_at`, the asynchronous INSERT time, so writer
 * backlog can look like silence. It therefore fires only when the agent is
 * demonstrably ALIVE — it made requests in the window — and produced no decided
 * ambiguous rows anyway. An agent with no rows at all is simply not being used,
 * and clearing its pair would punish absence rather than repair a ratchet. */
async function hygieneAgents(
  db: PersistencePort,
  structural: Pick<StructuralConfig, 'high' | 'low'>,
  cfg: CalibrationConfig,
  rails: CalibrationRails,
  now: number,
  logger: Pick<Logger, 'warn' | 'log'>,
): Promise<number> {
  let held: CalibrationSweepAgent[];
  try {
    held = await db.agentCalibration.listWithCalibratedPair();
  } catch {
    return 0;
  }
  if (held.length === 0) return 0;

  const window = { from: new Date(now - cfg.windowDays * DAY_MS), to: new Date(now) };
  const parents = new Map<string, RoutingSettingsValue | null>();
  let cleared = 0;

  for (const a of held) {
    try {
      const principal = userPrincipal(a.ownerUserId);
      if (!parents.has(a.ownerUserId)) {
        parents.set(a.ownerUserId, await safeSettings(db, principal));
      }
      const parentValue = parents.get(a.ownerUserId) ?? null;
      const parent =
        parentValue === null
          ? { high: structural.high, low: structural.low }
          : effectiveThresholds(structural, parentValue, rails);

      // (1) Does the pair still apply on top of the CURRENT parent?
      const applied = effectiveThresholds(parent, a, rails);
      let reason: 'stale' | 'starved' | null =
        applied.high === parent.high && applied.low === parent.low ? 'stale' : null;

      // (2) Starvation — only for a pair that IS still applying, and only when
      // the agent is demonstrably alive. Cascade off for this tenant suppresses
      // the rail entirely: the silence is the feature being off, not the pair.
      if (reason === null && (parentValue?.cascadeEnabled ?? false)) {
        const stats = await db.analytics.calibrationStats(principal, window, {
          high: applied.high,
          low: applied.low,
          edgeWidth: EDGE_WIDTH,
          epoch: a.calibrationEpoch,
          scope: { kind: 'agent', agentId: a.id },
        });
        const decided =
          stats.highEdge.samples + stats.lowEdge.samples;
        if (decided === 0) {
          const { rows } = await db.agentCalibration.activity(principal, a.id, window);
          if (rows > 0) reason = 'starved';
        }
      }
      if (reason === null) continue;

      const ok = await db.agentCalibration.setCalibrated(
        principal,
        a.id,
        null,
        {
          high: a.calibratedHigh,
          low: a.calibratedLow,
          anchorHigh: a.calibratedAnchorHigh,
          anchorLow: a.calibratedAnchorLow,
          epoch: a.calibrationEpoch,
        },
        // NO parent pin: a clear is a retreat to the level above and is correct
        // against ANY parent. Pinning the old tuple would make hygiene expect
        // the pre-move parent, find the post-move one, and no-op forever on
        // exactly the stale state it exists to repair (r2b High-1).
        null,
        {
          trigger: 'rebase',
          oldHigh: a.calibratedHigh ?? parent.high,
          oldLow: a.calibratedLow ?? parent.low,
          newHigh: parent.high,
          newLow: parent.low,
          anchorHigh: parent.high,
          anchorLow: parent.low,
          reason: `agent ${reason}; oldAnchor=${fmt(a.calibratedAnchorHigh ?? -1)}/${fmt(a.calibratedAnchorLow ?? -1)}; parent=${fmt(parent.high)}/${fmt(parent.low)}`,
        },
      );
      if (ok) cleared += 1;
    } catch (err) {
      logger.warn(`agent hygiene skipped one: ${String((err as Error).message)}`);
    }
  }
  return cleared;
}
