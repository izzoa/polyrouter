import { Inject, Injectable } from '@nestjs/common';
import { PERSISTENCE_PORT, type PersistencePort, type Principal } from '@polyrouter/shared/server';
import {
  ROUTING_CONFIG,
  autoLayerCapability,
  effectiveAutoLayers,
  type RoutingConfig,
} from '../proxy/routing.config';
import type { AutoLayersDto } from './auto-layers.dto';

/** The tenant's effective auto-layer state plus what the instance is capable of
 * (#20). `*Available` reflects the boot capability (`ROUTING_AUTO_LAYERS`); the
 * effective flags are `available && (preference ?? on)`. */
export interface AutoLayersView {
  structural: boolean;
  cascade: boolean;
  structuralAvailable: boolean;
  cascadeAvailable: boolean;
}

/** Per-tenant auto-layer preference (#20). Effective = capability × preference:
 * capability is the boot-resolved `ROUTING_CONFIG` (what the routers can do),
 * preference is the owner-scoped `routing_settings` row (absent → inherit-on).
 * `cascade → structural` is normalized on write so a stored row can never enable
 * cascade with structural off. */
@Injectable()
export class AutoLayersService {
  constructor(
    @Inject(PERSISTENCE_PORT) private readonly db: PersistencePort,
    @Inject(ROUTING_CONFIG) private readonly cfg: RoutingConfig,
  ) {}

  async get(principal: Principal): Promise<AutoLayersView> {
    const pref = await this.db.routingSettings.get(principal);
    return this.effective(pref);
  }

  async set(principal: Principal, dto: AutoLayersDto): Promise<AutoLayersView> {
    // Full replacement; cascade consumes structural's ambiguity signal, so
    // enabling cascade forces structural on (mirrors the DB check + the boot
    // `cascade implies structural` rule).
    const structuralEnabled = dto.structural || dto.cascade;
    const saved = await this.db.routingSettings.upsert(principal, {
      structuralEnabled,
      cascadeEnabled: dto.cascade,
    });
    return this.effective(saved);
  }

  private effective(
    pref: {
      structuralEnabled: boolean;
      cascadeEnabled: boolean;
    } | null,
  ): AutoLayersView {
    const cap = autoLayerCapability(this.cfg);
    return {
      ...effectiveAutoLayers(cap, pref), // A-45: one shared formula (also used by the proxy)
      structuralAvailable: cap.structural,
      cascadeAvailable: cap.cascade,
    };
  }
}
