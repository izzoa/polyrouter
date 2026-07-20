import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  PERSISTENCE_PORT,
  type BodyCaptureContext,
  type BodyCaptureMode,
  type BodyCaptureOverride,
  type BodyCaptureSettingsValue,
  type PersistencePort,
  type Principal,
} from '@polyrouter/shared/server';
import { BODY_CAPTURE_CONFIG, type BodyCaptureConfig } from './body-capture.config';

export interface BodyCaptureStatusView {
  mode: BodyCaptureMode;
  retentionDays: number | null;
  droppedCount: number;
  lastPurgeAt: string | null;
  lastPurgeCount: number;
  /** False on a non-selfhosted instance — the card renders read-only. */
  available: boolean;
  agents: { id: string; name: string; override: BodyCaptureOverride | null }[];
}

const OFF: BodyCaptureSettingsValue = {
  mode: 'off',
  retentionDays: 30,
  captureEpoch: 0,
  droppedCount: 0,
  lastPurgeAt: null,
  lastPurgeCount: 0,
};

/** Owner-facing settings surface + the proxy's capture-context seam
 * (add-body-capture). The selfhosted gate lives HERE twice over: the enable
 * path rejects on cloud, and `contextFor` returns 'off' regardless of stored
 * state (a smuggled row never captures). */
@Injectable()
export class BodyCaptureService {
  constructor(
    @Inject(PERSISTENCE_PORT) private readonly db: PersistencePort,
    @Inject(BODY_CAPTURE_CONFIG) private readonly cfg: BodyCaptureConfig,
  ) {}

  /** Per-direction plaintext cap for the proxy's buffers. */
  get maxBytes(): number {
    return this.cfg.maxBytes;
  }

  /** The per-request seam (D1): one indexed read; 'off' short-circuits
   * everything downstream (no collector is ever allocated). */
  async contextFor(principal: Principal, agentId: string | null): Promise<BodyCaptureContext> {
    if (!this.cfg.selfhosted) return { mode: 'off', override: null, retentionDays: null, epoch: 0 };
    return this.db.bodyCapture.captureContext(principal, agentId);
  }

  async status(principal: Principal): Promise<BodyCaptureStatusView> {
    const [settings, agents] = await Promise.all([
      this.db.bodyCapture.getSettings(principal),
      this.db.agents.list(principal),
    ]);
    const s = settings ?? OFF;
    return {
      mode: this.cfg.selfhosted ? s.mode : 'off',
      retentionDays: s.retentionDays,
      droppedCount: s.droppedCount,
      lastPurgeAt: s.lastPurgeAt?.toISOString() ?? null,
      lastPurgeCount: s.lastPurgeCount,
      available: this.cfg.selfhosted,
      agents: agents.map((a) => ({
        id: a.id,
        name: a.name,
        override: a.bodyCaptureOverride === 'always' || a.bodyCaptureOverride === 'never'
          ? a.bodyCaptureOverride
          : null,
      })),
    };
  }

  /** `retentionDays: null` requires the explicit keepForever flag — infinite is
   * a choice, never a blank (user decision 2026-07-20). */
  async update(
    principal: Principal,
    patch: { mode?: BodyCaptureMode; retentionDays?: number | null; keepForever?: boolean },
  ): Promise<BodyCaptureStatusView> {
    const current = (await this.db.bodyCapture.getSettings(principal)) ?? OFF;
    const mode = patch.mode ?? current.mode;
    if (mode !== 'off' && !this.cfg.selfhosted) {
      throw new BadRequestException('body capture is available on selfhosted instances only');
    }
    let retention: number | null | undefined = undefined;
    if (patch.retentionDays !== undefined) {
      if (patch.retentionDays === null && patch.keepForever !== true) {
        throw new BadRequestException(
          'infinite retention requires the explicit keepForever choice',
        );
      }
      retention = patch.retentionDays;
    }
    await this.db.bodyCapture.upsertSettings(principal, {
      mode,
      ...(retention !== undefined ? { retentionDays: retention } : {}),
    });
    return this.status(principal);
  }

  /** Purge-all (also the disable-with-purge path): bumps the epoch so queued
   * writer drafts can never resurrect (D9). */
  async purgeNow(principal: Principal): Promise<{ purged: number }> {
    return { purged: await this.db.bodyCapture.purgeAll(principal) };
  }

  async setAgentOverride(
    principal: Principal,
    agentId: string,
    override: BodyCaptureOverride | null,
  ): Promise<void> {
    if (override !== null && !this.cfg.selfhosted) {
      throw new BadRequestException('body capture is available on selfhosted instances only');
    }
    const ok = await this.db.bodyCapture.setAgentOverride(principal, agentId, override);
    if (!ok) throw new NotFoundException('agent not found');
  }
}
