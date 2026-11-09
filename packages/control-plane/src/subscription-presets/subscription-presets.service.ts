/**
 * Key-preset connect and list (add-key-subscription-presets, design D7).
 *
 * Nothing here dials out: a connect creates the pinned row and the user verifies
 * afterwards with Test / Sync. The registry is read through `KEY_PRESET_LOOKUP`, bound with
 * `useValue` to the bundled constants — no env var, config value or request field can
 * override it (design D6), so an unverified preset can never be offered around the
 * enablement gate.
 */
import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import {
  PERSISTENCE_PORT,
  encryptSecret,
  serializePlainCredential,
  type PersistencePort,
  type Principal,
  type ProviderInsertInput,
  type ProviderRow,
} from '@polyrouter/shared/server';
import { normalizeAndGateBaseUrl } from '../providers/base-url-gate';
import { PROVIDERS_RUNTIME, type ProvidersRuntime } from '../providers/providers.service';
import type { KeyPresetConnectDto } from './subscription-presets.dto';
import {
  KEY_PRESET_LOOKUP,
  offeredRegions,
  type KeyHint,
  type KeyPreset,
  type KeyPresetRegion,
  type KeyPresetRegistry,
  type KeyPresetRisk,
} from './key-presets';

/** The display-safe view of one offered region: no full URL, only the host. */
export interface KeyPresetRegionDto {
  id: string;
  label: string;
  host: string;
  imitationRequired: boolean;
}

/** The display-safe view of one offered preset (spec: "The offered key presets are listed as
 * non-secret display data"). No credential, no listing URL, no identity value. */
export interface KeyPresetDto {
  id: string;
  displayName: string;
  regions: KeyPresetRegionDto[];
  keyHint: KeyHint | null;
  /** The effective level: `high` whenever an offered region needs imitation. */
  termsRisk: KeyPresetRisk;
  riskCopy: string;
  termsUrl: string;
  requiresAcknowledgement: boolean;
  /** Whether the preset declares an optional client identity (redesign-subscription-picker
   * D3): a boolean only, so the picker can say the identity-imitation switch exists. Never the
   * identity's label, header name or value — the switch itself lives in Edit. */
  declaresIdentity: boolean;
}

/** Whether connecting this preset needs `acknowledgeTermsRisk: true` — a `high` preset, or
 * one with an offered imitation-required region (which is `high` by rule). */
function requiresAck(preset: KeyPreset, offered: readonly KeyPresetRegion[]): boolean {
  return preset.risk === 'high' || offered.some((r) => r.imitationRequired);
}

function toDto(preset: KeyPreset, offered: readonly KeyPresetRegion[]): KeyPresetDto {
  const ack = requiresAck(preset, offered);
  return {
    id: preset.id,
    displayName: preset.displayName,
    regions: offered.map((r) => ({
      id: r.id,
      label: r.label,
      host: new URL(r.baseUrl).host,
      imitationRequired: r.imitationRequired,
    })),
    keyHint: preset.keyHint,
    termsRisk: ack ? 'high' : preset.risk,
    riskCopy: preset.riskCopy,
    termsUrl: preset.termsUrl,
    requiresAcknowledgement: ack,
    declaresIdentity: preset.clientIdentity !== undefined,
  };
}

@Injectable()
export class SubscriptionPresetsService {
  private readonly mode: 'selfhosted' | 'cloud';
  private readonly key: string;

  constructor(
    @Inject(PERSISTENCE_PORT) private readonly db: PersistencePort,
    @Inject(KEY_PRESET_LOOKUP) private readonly presets: KeyPresetRegistry,
    @Inject(PROVIDERS_RUNTIME) runtime: ProvidersRuntime,
  ) {
    this.mode = runtime.mode;
    this.key = runtime.key;
  }

  /** Only presets with at least one offered region, and in each only offered regions. Never
   * varies by principal. */
  listAvailable(): KeyPresetDto[] {
    const out: KeyPresetDto[] = [];
    for (const preset of this.presets.list()) {
      const offered = offeredRegions(preset);
      if (offered.length > 0) out.push(toDto(preset, offered));
    }
    return out;
  }

  /**
   * Design D7 steps 1-5 (step 1, the DTO, ran in the pipe). Every rejection is a typed
   * `422` raised BEFORE any write; the only write is the tenant-scoped insert.
   */
  async connect(principal: Principal, dto: KeyPresetConnectDto): Promise<ProviderRow> {
    const preset = this.presets.find(dto.preset);
    const offered = preset === undefined ? [] : offeredRegions(preset);
    if (preset === undefined || offered.length === 0) {
      throw new UnprocessableEntityException('unknown or unavailable preset');
    }

    // Offered-region resolution (design D3): the region is required when more than one is
    // offered, and defaults to the sole offered one otherwise. A named region must be one of
    // the OFFERED ones (a disabled region is refused like an unknown one).
    let region: KeyPresetRegion;
    if (dto.region === undefined) {
      if (offered.length > 1) {
        throw new UnprocessableEntityException('region is required for this preset');
      }
      region = offered[0]!;
    } else {
      const named = offered.find((r) => r.id === dto.region);
      if (named === undefined) {
        throw new UnprocessableEntityException('unknown or unavailable region');
      }
      region = named;
    }

    // The high-risk acknowledgement (design D8): enforced here, never only in the UI, and
    // never stored.
    if (requiresAck(preset, offered) && dto.acknowledgeTermsRisk !== true) {
      throw new UnprocessableEntityException(
        'this preset needs an explicit terms acknowledgement (acknowledgeTermsRisk: true)',
      );
    }

    // Defense in depth: the pinned constant goes through the SAME gate as a user-supplied
    // base_url (design D7 step 4).
    const baseUrl = await normalizeAndGateBaseUrl(this.mode, 'subscription', region.baseUrl);

    const name =
      dto.name ??
      (offered.length > 1 ? `${preset.displayName} (${region.label})` : preset.displayName);
    const values: ProviderInsertInput = {
      name,
      kind: 'subscription',
      protocol: region.protocol,
      baseUrl,
      keyPreset: preset.id,
      // WRAPPED as a plain typed credential: a pasted `polycred:v1:` lookalike can never
      // forge an OAuth envelope (add-subscription-oauth).
      encryptedCredentials: encryptSecret(serializePlainCredential(dto.credential), this.key),
      ...(region.maxTokensSpelling !== undefined
        ? { maxTokensSpelling: region.maxTokensSpelling }
        : {}),
    };
    return this.db.providers.insert(principal, values);
  }
}
