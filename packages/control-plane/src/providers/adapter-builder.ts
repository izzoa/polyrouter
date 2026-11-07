import { Injectable } from '@nestjs/common';
import type { ProviderConfig, ProviderKind, ProviderProtocol } from '@polyrouter/data-plane';
import {
  SsrfError,
  assertUrlSafe,
  decryptSecret,
  resolvePlainCredentialValue,
  type Principal,
  type ProviderRow,
} from '@polyrouter/shared/server';
import { planUsageSourcesFor } from '../plan-usage/plan-usage-sources';
import { SubscriptionOauthService } from '../subscription-oauth/subscription-oauth.service';
import { keyPresetForRow } from '../subscription-presets/key-presets';
import { identityHeaders } from './client-identity';
import { providerMaxTokensQuirks, type MaxTokensSpelling } from './providers.dto';

export type AdapterBuildFailure = 'no_base_url' | 'address_rejected' | 'no_credential';

/** A configuration-level reason an adapter cannot be built. Carries a FIXED
 * message (never the URL, the credential, or an upstream body); each caller maps
 * it to its own surface — the proxy to a 503, management to a 422. */
export class AdapterBuildError extends Error {
  constructor(
    readonly reason: AdapterBuildFailure,
    message: string,
  ) {
    super(message);
    this.name = 'AdapterBuildError';
  }
}

export interface AdapterBuildOptions {
  /** The IR-omitted `max_tokens` default the Anthropic adapter synthesizes. */
  readonly defaultMaxOutputTokens: number;
  /** Per-call timeout bounds (proxy: effective/probe; batch: its own); omitted =
   * the adapter's defaults (the management path's behaviour). */
  readonly bounds?: {
    readonly firstByteTimeoutMs: number;
    readonly idleTimeoutMs: number;
    readonly streamEventTimeoutMs: number;
  };
  /** Name-time SSRF gate at build (the proxy's contract, default true). The
   * guarded transport re-validates at connect regardless; `false` preserves a
   * management path's call-time refusal semantics (test-connection reports it). */
  readonly assertAddress?: boolean;
}

/** A built adapter config plus the stored credential envelope it was built from
 * (add-provider-health-signals). `usedEnvelope` is INTERNAL — the compare key for
 * a forced refresh and the health incarnation guard — and is deliberately kept
 * OUT of the config, so it never reaches an adapter, a log line, or a response.
 * Null for a keyless local provider. */
export interface BuiltAdapterConfig {
  readonly config: ProviderConfig;
  readonly usedEnvelope: string | null;
}

export interface AdapterBuilderRuntime {
  /** Provider-credential encryption key (#7). */
  readonly key: string;
  readonly mode: 'selfhosted' | 'cloud';
}

/**
 * The ONE place a provider row becomes an adapter configuration (add-batch-
 * inference D4): credential decrypt or OAuth resolution, SSRF gate, the
 * max_tokens quirk, and timeout bounds. The request path, the batch path, and
 * provider management all build through it, so none can drift from the others —
 * a batch could never, say, skip the OAuth refresh the proxy performs. The
 * factory is deliberately NOT owned here: each module keeps its own overridable
 * adapter-factory token (the test seam), and applies it to the returned config.
 */
@Injectable()
export class ProviderAdapterBuilder {
  constructor(
    private readonly runtime: AdapterBuilderRuntime,
    private readonly oauth: SubscriptionOauthService,
  ) {}

  async buildConfig(
    principal: Principal,
    provider: ProviderRow,
    opts: AdapterBuildOptions,
  ): Promise<ProviderConfig> {
    return (await this.buildConfigWithCredential(principal, provider, opts)).config;
  }

  /** `buildConfig` plus the envelope the build actually used — for a subscription
   * provider, the one `resolveCredential` resolved (the NEWLY written one when the
   * build lazily refreshed); otherwise the stored envelope. */
  async buildConfigWithCredential(
    principal: Principal,
    provider: ProviderRow,
    opts: AdapterBuildOptions,
  ): Promise<BuiltAdapterConfig> {
    if (provider.baseUrl === null) {
      throw new AdapterBuildError('no_base_url', 'provider has no base_url');
    }
    const kind = provider.kind as ProviderKind;
    // Resolve the outbound token-cap spelling to the data-plane quirk — the SAME
    // helper for every path, so proxy, batch, and test-connection never diverge
    // (add-max-tokens-spelling). Inert for non-`openai_compatible` protocols.
    const quirks = providerMaxTokensQuirks(
      provider.protocol,
      kind,
      provider.maxTokensSpelling as MaxTokensSpelling,
    );
    if (opts.assertAddress !== false) {
      try {
        await assertUrlSafe(provider.baseUrl, {
          context: { mode: this.runtime.mode, providerKind: kind },
        });
      } catch (err) {
        if (err instanceof SsrfError) {
          throw new AdapterBuildError('address_rejected', 'provider address rejected');
        }
        throw err;
      }
    }
    // Preset-declared client identity (allow-preset-client-identity, design D4): the ONE
    // availability rule decides, the row's switch gates, and the result rides
    // `extraHeaders` for EVERY credential path — independent of how the credential
    // resolved (a key preset's plain api_key path included). The key is omitted, not
    // set to undefined, when nothing is declared or the switch is off.
    const identity = identityHeaders(provider, this.oauth.availableClientIdentity(provider), 'api');
    // A key preset's trusted absolute listing URL (add-key-subscription-presets, design D6):
    // read from the BUNDLED constants through the coherence gate, so a drifted `base_url`, an
    // unknown marker or a non-subscription row gets none, and no preset value can reach a host
    // the preset does not pin. A plain import — no constructor argument.
    const presetMatch = keyPresetForRow(provider);
    const modelsUrl = presetMatch?.region.modelsUrl;
    // The region's plan-error dialect (classify-plan-quota-errors, design D2): the SAME gate and
    // the same plain import, so it reaches only a row still equal to a region pin that declares
    // one — never a host match, an OAuth row, a drifted or unbound row.
    const errorDialect = presetMatch?.region.errorDialect;
    // The plan-usage dialect (add-subscription-quota-display, design D1): through the ONE gate,
    // `planUsageSourcesFor` over the single preset lookup, so it reaches only a row still on its
    // preset's pinned endpoint and never comes from the host or the request.
    const usageDialect = planUsageSourcesFor(
      provider,
      this.oauth.identityBindingFor(provider),
    )?.dialect;
    const common = {
      protocol: provider.protocol as ProviderProtocol,
      baseUrl: provider.baseUrl,
      kind,
      mode: this.runtime.mode,
      ...(quirks !== undefined ? { quirks } : {}),
      defaultMaxOutputTokens: opts.defaultMaxOutputTokens,
      ...(opts.bounds ?? {}),
      ...(identity !== undefined ? { extraHeaders: identity } : {}),
      ...(modelsUrl !== undefined ? { modelsUrl } : {}),
      ...(errorDialect !== undefined ? { errorDialect } : {}),
      ...(usageDialect !== undefined ? { usageDialect } : {}),
    };
    // Subscription providers resolve through the subscription-oauth seam: it unwraps
    // a plain paste, or refreshes an OAuth token (pre-request only — invariant 3)
    // and supplies authScheme/oauthBeta. Credential failures are
    // ProviderError('credential') — fallback-eligible, breaker-neutral — and pass
    // through untouched.
    if (kind === 'subscription' && provider.encryptedCredentials !== null) {
      const r = await this.oauth.resolveCredential(principal, provider);
      return {
        config: {
          ...common,
          credential: r.credential,
          authScheme: r.authScheme,
          ...(r.oauthBeta !== undefined ? { oauthBeta: r.oauthBeta } : {}),
          ...(r.oauthAccountId !== undefined ? { oauthAccountId: r.oauthAccountId } : {}),
        },
        usedEnvelope: r.envelope,
      };
    }
    let credential = '';
    if (provider.encryptedCredentials !== null) {
      // Plain path: unwrap the typed envelope (legacy raw passes through). OAuth
      // envelopes resolve through the subscription-oauth seam above instead.
      credential = resolvePlainCredentialValue(
        decryptSecret(provider.encryptedCredentials, this.runtime.key),
      );
    } else if (kind !== 'local') {
      throw new AdapterBuildError('no_credential', 'provider has no credential');
    }
    return { config: { ...common, credential }, usedEnvelope: provider.encryptedCredentials };
  }
}
