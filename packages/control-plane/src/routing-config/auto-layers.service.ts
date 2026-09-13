import { Inject, Injectable } from '@nestjs/common';
import {
  PERSISTENCE_PORT,
  type PersistencePort,
  type Principal,
  type RoutingSettingsValue,
  type ThresholdCalibrationEventRowView,
} from '@polyrouter/shared/server';
import {
  CALIBRATION_CONFIG,
  CALIBRATION_RAILS,
  EDGE_WIDTH,
  type CalibrationConfig,
  type CalibrationRails,
} from '../calibration/calibration.config';
import {
  ROUTING_CONFIG,
  autoLayerCapability,
  effectiveAutoLayers,
  effectiveThresholds,
  type RoutingConfig,
} from '../proxy/routing.config';
import { SemanticClassifierService } from '../semantic/semantic-classifier.service';
import { SemanticRuntimeService } from '../semantic/semantic-runtime.service';
import type { AutoLayersDto } from './auto-layers.dto';

/** The tenant's effective auto-layer state plus what the instance is capable of
 * (#20), extended with the calibration trio (add-auto-threshold-calibration):
 * an INERT stored pair (anchor-stale or rail-violating) reads as nulls —
 * never presented as active. */
export interface AutoLayersView {
  structural: boolean;
  cascade: boolean;
  /** add-semantic-routing: the effective L2 preference (capability × pref). */
  semantic: boolean;
  structuralAvailable: boolean;
  cascadeAvailable: boolean;
  /** add-semantic-routing: flag ∧ the WHOLE classifier ready (embedder +
   * centroids). false = the honest "off instance-wide" affordance. */
  semanticAvailable: boolean;
  /** fix-image-healthcheck-and-l2-hint: the conjunction's two halves, surfaced
   * separately so the UI can name WHICH half an unavailable L2 is missing.
   * Invariant: `semanticAvailable === semanticFlagEnabled && semanticClassifierReady`.
   * fix-semantic-boot-embed-budget splits the MODEL half again: a missing
   * bundle and a bundle that loaded but yielded no centroids both reduced to
   * `semanticClassifierReady:false`, and an operator's remedy differs entirely
   * between them, so `semanticEmbedderReady` reports the embedder alone.
   * Second invariant: `semanticClassifierReady ⟹ semanticEmbedderReady` —
   * centroids cannot exist without the embedder that built them, so only SIX
   * of the eight flag/embedder/classifier triples are reachable. */
  semanticFlagEnabled: boolean;
  semanticEmbedderReady: boolean;
  semanticClassifierReady: boolean;
  /** add-semantic-workloads: the semantic WORKLOAD source — capability (the
   * semantic capability ∧ the five workload centroids ready) and the effective
   * flag (semantic effective ∧ available; no separate tenant preference). The
   * dashboard's reserved Workload-target rows go live on the effective flag. */
  semanticWorkloadAvailable: boolean;
  semanticWorkload: boolean;
  /** add-semantic-learning: the effective learning preference (enabled ∧ semantic
   * effective) and whether the instance can learn (= semanticAvailable). */
  semanticLearning: boolean;
  semanticLearningAvailable: boolean;
  calibration: {
    enabled: boolean;
    calibratedHigh: number | null;
    calibratedLow: number | null;
    instanceHigh: number;
    instanceLow: number;
    effectiveHigh: number;
    effectiveLow: number;
    /** Per-agent scope (add-per-agent-calibration). Every agent of the tenant,
     * so the UI can say INHERITING rather than leaving the reader to infer it
     * from an absence. */
    agents: AgentCalibrationView[];
    /** The tenant pair is FROZEN: it holds a calibrated pair whose own
     * post-exclusion evidence has been below the acting floor on BOTH edges
     * for a full window. It is still governing every inheriting agent while no
     * longer being informed by the traffic it governs, so it is disclosed
     * rather than silently presented as current. Null when there is no tenant
     * pair to freeze. */
    tenantPairStarved: boolean | null;
  };
}

/** One agent's calibration state for the read surface. */
export interface AgentCalibrationView {
  id: string;
  name: string;
  /** Null = INHERITING the tenant pair. Not "uncalibrated": the agent is being
   * routed by a real, possibly calibrated pair — its tenant's. */
  calibratedHigh: number | null;
  calibratedLow: number | null;
  anchorHigh: number | null;
  anchorLow: number | null;
  epoch: number;
  /** Whether the stored pair is the one actually routing. A pair whose anchor
   * has gone stale is presented as inert, exactly as the tenant pair is. */
  active: boolean;
  /** Current-epoch evidence AT THIS AGENT'S SCOPE — only for a pair-holder,
   * where the counts are what its own next move would be judged on. */
  evidence: { highSamples: number; lowSamples: number } | null;
}

const DEFAULT_HISTORY_LIMIT = 20;
/** Bound on the agent list this read renders, matching the sibling evidence
 * endpoint: an unbounded list is an unbounded DOM and an unbounded query count. */
const AGENT_SCOPE_CAP = 50;
/** The CALIBRATION window, not the caller's analytics range — these counts are
 * the calibrator's, and must agree with what it acts on. */
const CALIBRATION_READ_WINDOW_DAYS = 14;

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
    @Inject(CALIBRATION_CONFIG) private readonly calibrationCfg: CalibrationConfig,
    private readonly semantic: SemanticClassifierService,
    private readonly runtime: SemanticRuntimeService,
  ) {}

  async get(principal: Principal): Promise<AutoLayersView> {
    const pref = await this.db.routingSettings.get(principal);
    const view = this.effective(pref);
    // The per-agent scope is read-time only and must never make this endpoint
    // fail: a tenant's own calibration state is the answer to this request, and
    // the agent list is an addition to it (invariant 1).
    try {
      const scoped = await this.agentScope(principal, pref, view.calibration);
      return { ...view, calibration: { ...view.calibration, ...scoped } };
    } catch {
      return view;
    }
  }

  /** Per-agent calibration state plus the frozen-tenant-pair disclosure
   * (add-per-agent-calibration).
   *
   * Evidence is fetched only for agents that HOLD a pair — that is the set
   * whose counts mean something here (what its own next move is judged on),
   * and it keeps this a small bounded read rather than one query per agent on
   * a tenant with hundreds. Inheriting agents are still listed, because
   * "INHERITING" is a state the reader needs named rather than inferred from
   * an absence. */
  private async agentScope(
    principal: Principal,
    pref: RoutingSettingsValue | null,
    calibration: AutoLayersView['calibration'],
  ): Promise<Pick<AutoLayersView['calibration'], 'agents' | 'tenantPairStarved'>> {
    const rows = await this.db.agentCalibration.listForCalibration(principal);
    const parent = { high: calibration.effectiveHigh, low: calibration.effectiveLow };
    const window = {
      from: new Date(Date.now() - CALIBRATION_READ_WINDOW_DAYS * 86_400_000),
      to: new Date(),
    };

    const agents: AgentCalibrationView[] = [];
    for (const a of rows.slice(0, AGENT_SCOPE_CAP)) {
      const applied = effectiveThresholds(parent, a, this.rails);
      const active =
        a.calibratedHigh !== null && (applied.high !== parent.high || applied.low !== parent.low);
      let evidence: AgentCalibrationView['evidence'] = null;
      if (active) {
        const s = await this.db.analytics.calibrationStats(principal, window, {
          high: applied.high,
          low: applied.low,
          edgeWidth: EDGE_WIDTH,
          epoch: a.calibrationEpoch,
          scope: { kind: 'agent', agentId: a.id },
        });
        evidence = { highSamples: s.highEdge.samples, lowSamples: s.lowEdge.samples };
      }
      agents.push({
        id: a.id,
        name: a.name ?? a.id,
        calibratedHigh: active ? a.calibratedHigh : null,
        calibratedLow: active ? a.calibratedLow : null,
        anchorHigh: a.calibratedAnchorHigh,
        anchorLow: a.calibratedAnchorLow,
        epoch: a.calibrationEpoch,
        active,
        evidence,
      });
    }

    // The frozen-pair disclosure. Only meaningful when a tenant pair exists to
    // be frozen: without one there is nothing being presented as current.
    //
    // And only after a FULL WINDOW has passed since the last threshold event.
    // Without that clause this fires on every healthy tenant the moment it
    // moves: the epoch bump deliberately zeroes current-epoch evidence, so
    // "both edges below the floor right now" is the NORMAL state immediately
    // after a successful move. A tenant that moved inside the window is still
    // accumulating, which is the opposite of frozen.
    let tenantPairStarved: boolean | null = null;
    if (calibration.calibratedHigh !== null) {
      const [latest] = await this.db.calibrationEvents.list(principal, 1, 'tenant');
      const movedInsideWindow =
        latest !== undefined && Date.parse(latest.createdAt) > window.from.getTime();
      if (movedInsideWindow) return { agents, tenantPairStarved: false };
    }
    if (calibration.calibratedHigh !== null) {
      const t = await this.db.analytics.calibrationStats(principal, window, {
        high: parent.high,
        low: parent.low,
        edgeWidth: EDGE_WIDTH,
        epoch: pref?.calibrationEpoch ?? 0,
        scope: { kind: 'tenant' },
      });
      // BOTH edges below the floor. The floor applies per edge, so a tenant at
      // 70 high and 0 low is NOT starved — it has a live edge and will move.
      tenantPairStarved =
        t.highEdge.samples < this.calibrationCfg.minEdgeSamples &&
        t.lowEdge.samples < this.calibrationCfg.minEdgeSamples;
    }
    return { agents, tenantPairStarved };
  }

  async set(principal: Principal, dto: AutoLayersDto): Promise<AutoLayersView> {
    // Full replacement of the LAYER flags; cascade AND semantic consume
    // structural's ambiguity signal, so enabling either forces structural on
    // (mirrors the DB checks + the boot implication rules). semantic and
    // calibration are optional — omission preserves (the atomic dependency-
    // down normalization lives in the upsert; add-semantic-routing D7).
    const structuralEnabled = dto.structural || dto.cascade || (dto.semantic ?? false);
    const saved = await this.db.routingSettings.upsert(principal, {
      structuralEnabled,
      cascadeEnabled: dto.cascade,
      ...(dto.semantic !== undefined ? { semanticEnabled: dto.semantic } : {}),
      // Learning depends on the EFFECTIVE semantic; the upsert normalizes down.
      ...(dto.semanticLearning !== undefined
        ? { semanticLearningEnabled: dto.semanticLearning }
        : {}),
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

  /** Per-AGENT revert (add-per-agent-calibration), on USER-WINS terms: it
   * clears whatever pair is present under the row lock, so a calibrator move
   * landing mid-flight cannot turn it into a silent no-op. It pins NO parent —
   * a retreat to the level above is correct against any parent, and requiring
   * the tenant tuple would make a revert fail exactly when the tenant had just
   * moved. Touches one agent: the tenant pair and every sibling are untouched.
   *
   * Idempotent: reverting an already-inheriting agent is a 200 no-op that
   * appends no event and does not advance the membership generation. */
  async revertAgent(principal: Principal, agentId: string): Promise<AutoLayersView> {
    const rows = await this.db.agentCalibration.listForCalibration(principal);
    const a = rows.find((r) => r.id === agentId);
    // A foreign or unknown id resolves to nothing here because the list is
    // owner-scoped — no separate ownership check to forget (invariant 5).
    if (a === undefined || a.calibratedHigh === null) return this.get(principal);

    const pref = await this.db.routingSettings.get(principal);
    const parent = effectiveThresholds(this.cfg.structural, pref, this.rails);
    await this.db.agentCalibration.setCalibrated(
      principal,
      agentId,
      null,
      {
        high: a.calibratedHigh,
        low: a.calibratedLow,
        anchorHigh: a.calibratedAnchorHigh,
        anchorLow: a.calibratedAnchorLow,
        epoch: a.calibrationEpoch,
      },
      null,
      {
        trigger: 'revert',
        oldHigh: a.calibratedHigh,
        oldLow: a.calibratedLow ?? parent.low,
        newHigh: parent.high,
        newLow: parent.low,
        anchorHigh: parent.high,
        anchorLow: parent.low,
        reason: `agent revert; ${String(a.calibratedHigh)}/${String(a.calibratedLow)}→inherited`,
      },
    );
    return this.get(principal);
  }

  history(
    principal: Principal,
    limit?: number,
    scope?: string,
  ): Promise<ThresholdCalibrationEventRowView[]> {
    return this.db.calibrationEvents.list(principal, limit ?? DEFAULT_HISTORY_LIMIT, scope);
  }

  private effective(pref: RoutingSettingsValue | null): AutoLayersView {
    // Capability includes the WHOLE classifier readiness (add-semantic-
    // routing): flag ∧ embedder ∧ centroids — never merely a loaded embedder.
    const cap = autoLayerCapability(this.cfg, this.semantic.available, this.semantic.workloadReady);
    const { high: instanceHigh, low: instanceLow } = this.cfg.structural;
    const eff = effectiveThresholds(this.cfg.structural, pref, this.rails);
    // A pair is presented ONLY while it is the pair actually routing — an
    // inert (stale/poisoned) pair reads as uncalibrated.
    const active = eff.high !== instanceHigh || eff.low !== instanceLow;
    const layers = effectiveAutoLayers(cap, pref); // A-45: one shared formula (also used by the proxy)
    return {
      ...layers,
      structuralAvailable: cap.structural,
      cascadeAvailable: cap.cascade,
      semanticAvailable: cap.semantic,
      semanticWorkloadAvailable: cap.semanticWorkload,
      // The two halves come from the SAME boot-resolved singletons the
      // conjunction is built from, so they cannot drift from what routes.
      semanticFlagEnabled: this.cfg.autoLayers.has('semantic'),
      // From the SAME boot-resolved singletons the conjunction is built from,
      // never inferred from a sibling field — so the reported triple cannot
      // drift from what actually routes.
      semanticEmbedderReady: this.runtime.available,
      semanticClassifierReady: this.semantic.available,
      // Learning is effective only when semantic is (and the tenant opted in);
      // available only when the classifier is (learning rides the same stack).
      semanticLearning: layers.semantic && (pref?.semanticLearningEnabled ?? false),
      semanticLearningAvailable: cap.semantic,
      calibration: {
        enabled: pref?.calibrationEnabled ?? false,
        calibratedHigh: active ? eff.high : null,
        calibratedLow: active ? eff.low : null,
        instanceHigh,
        instanceLow,
        effectiveHigh: eff.high,
        effectiveLow: eff.low,
        agents: [],
        tenantPairStarved: null,
      },
    };
  }
}
