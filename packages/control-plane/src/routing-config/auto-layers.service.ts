import { Inject, Injectable } from '@nestjs/common';
import {
  PERSISTENCE_PORT,
  type PersistencePort,
  type Principal,
  type RoutingSettingsValue,
  type ThresholdCalibrationEventRowView,
} from '@polyrouter/shared/server';
import { CALIBRATION_RAILS, type CalibrationRails } from '../calibration/calibration.config';
import {
  ROUTING_CONFIG,
  autoLayerCapability,
  effectiveAutoLayers,
  effectiveThresholds,
  type RoutingConfig,
} from '../proxy/routing.config';
import type { AutoLayersDto } from './auto-layers.dto';

/** The tenant's effective auto-layer state plus what the instance is capable of
 * (#20), extended with the calibration trio (add-auto-threshold-calibration):
 * an INERT stored pair (anchor-stale or rail-violating) reads as nulls —
 * never presented as active. */
export interface AutoLayersView {
  structural: boolean;
  cascade: boolean;
  structuralAvailable: boolean;
  cascadeAvailable: boolean;
  calibration: {
    enabled: boolean;
    calibratedHigh: number | null;
    calibratedLow: number | null;
    instanceHigh: number;
    instanceLow: number;
    effectiveHigh: number;
    effectiveLow: number;
  };
}

const DEFAULT_HISTORY_LIMIT = 20;

/** Per-tenant auto-layer preference (#20) + threshold-calibration state.
 * Effective = capability × preference: capability is the boot-resolved
 * `ROUTING_CONFIG` (what the routers can do), preference is the owner-scoped
 * `routing_settings` row (absent → inherit-on). `cascade → structural` is
 * normalized on write. Calibration writes here touch ONLY the enabled flag —
 * never the calibrated quad or epoch (those belong to the calibrator/revert). */
@Injectable()
export class AutoLayersService {
  constructor(
    @Inject(PERSISTENCE_PORT) private readonly db: PersistencePort,
    @Inject(ROUTING_CONFIG) private readonly cfg: RoutingConfig,
    @Inject(CALIBRATION_RAILS) private readonly rails: CalibrationRails,
  ) {}

  async get(principal: Principal): Promise<AutoLayersView> {
    const pref = await this.db.routingSettings.get(principal);
    return this.effective(pref);
  }

  async set(principal: Principal, dto: AutoLayersDto): Promise<AutoLayersView> {
    // Full replacement of the LAYER flags; cascade consumes structural's
    // ambiguity signal, so enabling cascade forces structural on (mirrors the
    // DB check + the boot `cascade implies structural` rule). The calibration
    // flag is optional — omission preserves (r1-Med-7).
    const structuralEnabled = dto.structural || dto.cascade;
    const saved = await this.db.routingSettings.upsert(principal, {
      structuralEnabled,
      cascadeEnabled: dto.cascade,
      ...(dto.calibration !== undefined ? { calibrationEnabled: dto.calibration } : {}),
    });
    return this.effective(saved);
  }

  /** One-click revert (add-auto-threshold-calibration): a conditional clear —
   * the `revert` event is appended ONLY when a pair was actually cleared, so
   * concurrent/repeated reverts produce exactly one event and later calls are
   * idempotent no-ops. */
  async revert(principal: Principal): Promise<AutoLayersView> {
    // USER-WINS (r3-Med-2): one locked transaction clears WHATEVER pair is
    // present — no pre-read expected state, so a calibrator move landing
    // mid-flight cannot make the user's one-click revert a silent no-op. A
    // false return means no pair existed (idempotent no-op, no event).
    const { high: instanceHigh, low: instanceLow } = this.cfg.structural;
    await this.db.routingSettings.clearCalibrated(principal, (observed) => ({
      trigger: 'revert',
      oldHigh: observed.calibratedHigh ?? instanceHigh,
      oldLow: observed.calibratedLow ?? instanceLow,
      newHigh: instanceHigh,
      newLow: instanceLow,
      anchorHigh: instanceHigh,
      anchorLow: instanceLow,
      reason: `revert; ${String(observed.calibratedHigh ?? instanceHigh)}/${String(observed.calibratedLow ?? instanceLow)}→instance`,
    }));
    return this.get(principal);
  }

  history(principal: Principal, limit?: number): Promise<ThresholdCalibrationEventRowView[]> {
    return this.db.calibrationEvents.list(principal, limit ?? DEFAULT_HISTORY_LIMIT);
  }

  private effective(pref: RoutingSettingsValue | null): AutoLayersView {
    const cap = autoLayerCapability(this.cfg);
    const { high: instanceHigh, low: instanceLow } = this.cfg.structural;
    const eff = effectiveThresholds(this.cfg.structural, pref, this.rails);
    // A pair is presented ONLY while it is the pair actually routing — an
    // inert (stale/poisoned) pair reads as uncalibrated.
    const active = eff.high !== instanceHigh || eff.low !== instanceLow;
    return {
      ...effectiveAutoLayers(cap, pref), // A-45: one shared formula (also used by the proxy)
      structuralAvailable: cap.structural,
      cascadeAvailable: cap.cascade,
      calibration: {
        enabled: pref?.calibrationEnabled ?? false,
        calibratedHigh: active ? eff.high : null,
        calibratedLow: active ? eff.low : null,
        instanceHigh,
        instanceLow,
        effectiveHigh: eff.high,
        effectiveLow: eff.low,
      },
    };
  }
}
