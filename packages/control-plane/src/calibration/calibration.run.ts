import { Logger } from '@nestjs/common';
import {
  userPrincipal,
  type CalibrationSweepTenant,
  type PersistencePort,
  type RoutingSettingsValue,
  type ThresholdCalibrationEventInput,
} from '@polyrouter/shared/server';
import { effectiveThresholds, type StructuralConfig } from '../proxy/routing.config';
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
  if (round4(structural.high - structural.low) < rails.minGap) return 'skipped';
  if (round4(eff.high - EDGE_WIDTH) <= round4(eff.low + EDGE_WIDTH)) return 'skipped';

  const anchorHigh = v.calibratedAnchorHigh ?? structural.high;
  const anchorLow = v.calibratedAnchorLow ?? structural.low;

  // Per-edge cooldown from the tenant's recent events (daily cadence — 20
  // rows comfortably cover the cooldown window).
  const recent = await db.calibrationEvents.list(principal, 20);
  const cooledSince = now - COOLDOWN_DAYS * DAY_MS;
  const inCooldown = (edge: 'high' | 'low'): boolean =>
    recent.some((e) => e.edge === edge && Date.parse(e.createdAt) > cooledSince);

  const stats = await db.analytics.calibrationStats(
    principal,
    { from: new Date(now - cfg.windowDays * DAY_MS), to: new Date(now) },
    { high: eff.high, low: eff.low, edgeWidth: EDGE_WIDTH, epoch: v.calibrationEpoch },
  );

  const candidates: EdgeDecision[] = [];
  const he = stats.highEdge;
  if (he.samples >= cfg.minEdgeSamples) {
    const rate = he.failures / he.samples;
    if (
      rate >= RATE_HIGH &&
      round4(eff.high - cfg.step) >= round4(anchorHigh - cfg.maxDrift) &&
      round4(eff.high - cfg.step) < eff.high && // never a zero-value move
      !inCooldown('high')
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
      !inCooldown('low')
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
  if (candidates.length === 0) return 'noop';

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
  if (gapOf(finalPair(applied)) < rails.minGap && applied.length === 2) {
    // Exact cross-multiplied comparison — integer arithmetic, no float noise;
    // a TRUE tie deterministically keeps the high edge (r3-Med-4).
    applied.sort((a, b) => {
      const cmp = b.strengthNum * a.strengthDen - a.strengthNum * b.strengthDen;
      if (cmp !== 0) return cmp;
      return a.edge === 'high' ? -1 : 1;
    });
    applied = [applied[0]!];
  }
  if (gapOf(finalPair(applied)) < rails.minGap) return 'noop';

  const target = finalPair(applied);
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
      anchorHigh: structural.high,
      anchorLow: structural.low,
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

  // Conditional transactional apply — observed state or nothing (r1-Med-5);
  // one audit row per applied edge in the same transaction.
  const ok = await db.routingSettings.setCalibrated(
    principal,
    { high: target.high, low: target.low, anchorHigh: structural.high, anchorLow: structural.low },
    {
      enabled: true,
      high: v.calibratedHigh,
      low: v.calibratedLow,
      anchorHigh: v.calibratedAnchorHigh,
      anchorLow: v.calibratedAnchorLow,
      epoch: v.calibrationEpoch,
    },
    events,
  );
  return ok ? 'moved' : 'skipped'; // skipped = a concurrent user action won
}
