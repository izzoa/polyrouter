/**
 * Subscription OAuth core (add-subscription-oauth): connect sessions → token exchange →
 * provider rows, plus the credential-resolution seam with coalesced, rotation-safe
 * refresh. Invariants enforced here:
 *
 *  - tokens/pastes never logged or echoed (invariant 8) — fixed messages only;
 *  - every credential mutation (refresh write, reauthorize completion; PATCH takes the
 *    same key in providers.service) serializes on ONE per-provider advisory lock,
 *    re-reading inside it, so rotation can never be clobbered (invariant 10);
 *  - refresh is pre-request only; `credential`-kind failures are fallback-eligible and
 *    breaker-NEUTRAL; while `credential_error` is set, resolution fails locally with
 *    no identity-provider call;
 *  - only a successful REAUTHORIZATION resets the provider breaker — an ordinary
 *    refresh preserves genuine upstream failure history (codex round 2).
 */
import { randomBytes } from 'node:crypto';
import {
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  PERSISTENCE_FACILITIES,
  PERSISTENCE_PORT,
  REDIS_CLIENT,
  TamperedCredentialError,
  credentialLockKey,
  decryptSecret,
  encryptSecret,
  parseCredentialEnvelope,
  serializeOauthCredential,
  type OauthCredential,
  type PersistenceFacilities,
  type PersistencePort,
  type Principal,
  type ProviderRow,
} from '@polyrouter/shared/server';
import { ProviderError, RedisBreakerStore, type AuthScheme } from '@polyrouter/data-plane';
import { AdvisoryLockTimeoutError } from '../database/port';
import type { Redis } from 'ioredis';
import {
  ConnectSessionStore,
  OauthSessionUnavailableError,
  mintPkce,
  type ConnectSession,
} from './connect-sessions';
import { AccountClaimError, extractChatgptAccountId } from './account-claim';
import { TokenEndpointError, fetchTokenSet, type OauthTokenFetch, type TokenSet } from './oauth-client';
import { PasteParseError, parsePastedRedirect } from './paste';
import { OAUTH_PRESETS, buildAuthorizeUrl, findPreset, type OauthPreset } from './presets';

export const SUBSCRIPTION_OAUTH_RUNTIME = 'polyrouter:subscription-oauth-runtime';
export const OAUTH_TOKEN_FETCH = 'polyrouter:oauth-token-fetch';
export const OAUTH_PRESET_LOOKUP = 'polyrouter:oauth-preset-lookup';

export interface SubscriptionOauthRuntime {
  readonly key: string; // PROVIDER_CREDENTIAL_KEY
  readonly mode: 'selfhosted' | 'cloud';
}
export interface PresetRegistry {
  find(id: string): OauthPreset | undefined;
  list(): readonly OauthPreset[];
}
export const defaultPresetRegistry: PresetRegistry = {
  find: findPreset,
  list: () => OAUTH_PRESETS,
};
export const defaultTokenFetch: OauthTokenFetch = fetchTokenSet;

/** Refresh when within this margin of expiry (hot path stays decrypt + compare). */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** Cross-instance backoff after a transient IdP failure (no re-dial storms). */
const BACKOFF_MS = 30_000;
/** Bound on waiting for the cross-instance credential lock. */
const LOCK_WAIT_MS = 20_000;

const backoffKey = (providerId: string): string => `oauth:backoff:${providerId}`;

export interface ResolvedCredential {
  readonly credential: string;
  readonly authScheme: AuthScheme;
  readonly oauthBeta?: string;
  /** TRUSTED envelope data for the Responses protocol (add-chatgpt-responses):
   * emitted as the `chatgpt-account-id` header. Never logged or exposed. */
  readonly oauthAccountId?: string;
  /** TRUSTED preset-registry data: the designated validating-probe model for a
   * models-endpoint-less protocol. */
  readonly probeModel?: string;
}

export interface StartResult {
  readonly sessionId: string;
  readonly authorizeUrl: string;
}

function principalKeyOf(principal: Principal): string {
  return principal.kind === 'user' ? `user:${principal.userId}` : `org:${principal.orgId}`;
}

/** The Responses protocol addresses requests by account id — derived from the
 * preset's pinned protocol, so the two can never disagree. */
function presetRequiresAccountId(preset: OauthPreset): boolean {
  return preset.protocol === 'openai_responses';
}

function reauthorizeRequired(): ProviderError {
  return new ProviderError('credential', 'subscription credential needs reauthorization');
}
function idpUnavailable(): ProviderError {
  return new ProviderError('credential', 'identity provider unavailable');
}
function tampered(): ProviderError {
  return new ProviderError('credential', 'stored credential is invalid');
}

@Injectable()
export class SubscriptionOauthService {
  private readonly sessions: ConnectSessionStore;
  private readonly breakerStore: RedisBreakerStore;
  /** In-process refresh coalescing: at most ONE flight (and one DB connection at the
   * lock) per provider per instance. */
  private readonly inflight = new Map<string, Promise<ResolvedCredential>>();

  constructor(
    @Inject(PERSISTENCE_PORT) private readonly db: PersistencePort,
    @Inject(PERSISTENCE_FACILITIES) private readonly facilities: PersistenceFacilities,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(SUBSCRIPTION_OAUTH_RUNTIME) private readonly rt: SubscriptionOauthRuntime,
    @Inject(OAUTH_TOKEN_FETCH) private readonly tokenFetch: OauthTokenFetch,
    @Inject(OAUTH_PRESET_LOOKUP) private readonly presets: PresetRegistry,
  ) {
    this.sessions = new ConnectSessionStore(redis);
    // Same 'cb:' key space as the proxy's Redis breaker — reset (reauthorize-only)
    // deletes the shared record. The proxy's in-memory FALLBACK store (Redis outage)
    // is per-instance and unreachable from here; in that degraded mode a reauthorized
    // provider may serve out one short cooldown — accepted, documented.
    this.breakerStore = new RedisBreakerStore(redis);
  }

  // ---- connect / reauthorize ----

  /** The preset an OAuth-connected provider row is bound to (undefined for
   * non-OAuth rows or an unknown preset id). */
  presetFor(provider: Pick<ProviderRow, 'oauthPreset'>): OauthPreset | undefined {
    return provider.oauthPreset === null ? undefined : this.presets.find(provider.oauthPreset);
  }

  /** The enabled presets, as the dashboard's card list (id + display name only). */
  listEnabledPresets(): Array<{ id: string; displayName: string }> {
    return this.presets
      .list()
      .filter((p) => p.enabled)
      .map((p) => ({ id: p.id, displayName: p.displayName }));
  }

  async start(
    principal: Principal,
    authSessionId: string,
    input: { preset: string; name?: string },
  ): Promise<StartResult> {
    const preset = this.presets.find(input.preset);
    if (!preset || !preset.enabled) {
      throw new UnprocessableEntityException('unknown or unavailable subscription preset');
    }
    return this.mintSession(principal, authSessionId, preset, {
      ...(input.name !== undefined ? { name: input.name } : {}),
    });
  }

  /** Reauthorize derives and retains the EXISTING preset from the row — a session can
   * never swap presets (round-1 review). Allowed even for a since-disabled preset. */
  async startReauthorize(
    principal: Principal,
    authSessionId: string,
    providerId: string,
  ): Promise<StartResult> {
    const row = await this.db.providers.findById(principal, providerId);
    if (!row || row.oauthPreset === null) throw new NotFoundException();
    const preset = this.presets.find(row.oauthPreset);
    if (!preset) throw new UnprocessableEntityException('unknown subscription preset');
    return this.mintSession(principal, authSessionId, preset, { providerId });
  }

  private async mintSession(
    principal: Principal,
    authSessionId: string,
    preset: OauthPreset,
    extra: { name?: string; providerId?: string },
  ): Promise<StartResult> {
    const { verifier, challenge } = mintPkce();
    const state = randomBytes(24).toString('base64url');
    const session: ConnectSession = {
      state,
      verifier,
      preset: preset.id,
      principalKey: principalKeyOf(principal),
      authSessionId,
      ...(extra.providerId !== undefined ? { providerId: extra.providerId } : {}),
      ...(extra.name !== undefined ? { name: extra.name } : {}),
    };
    try {
      const sessionId = await this.sessions.create(session);
      return { sessionId, authorizeUrl: buildAuthorizeUrl(preset, state, challenge) };
    } catch (err) {
      if (err instanceof OauthSessionUnavailableError) {
        throw new ServiceUnavailableException('connect is temporarily unavailable');
      }
      throw err;
    }
  }

  async complete(
    principal: Principal,
    authSessionId: string,
    input: { sessionId: string; pasted: string },
  ): Promise<ProviderRow> {
    let session: ConnectSession | null;
    try {
      session = await this.sessions.claim(input.sessionId); // atomic single-use, pre-exchange
    } catch (err) {
      if (err instanceof OauthSessionUnavailableError) {
        throw new ServiceUnavailableException('connect is temporarily unavailable');
      }
      throw err;
    }
    // Unknown, expired, consumed, foreign-principal, or foreign-login-session all fail
    // closed with the same shape (no oracle).
    if (
      session === null ||
      session.principalKey !== principalKeyOf(principal) ||
      session.authSessionId !== authSessionId
    ) {
      throw new UnprocessableEntityException('unknown or expired connect session — restart connect');
    }
    const preset = this.presets.find(session.preset);
    if (!preset) throw new UnprocessableEntityException('unknown subscription preset');

    let code: string;
    try {
      const parsed = parsePastedRedirect(input.pasted, preset.redirectUri);
      if (parsed.state !== session.state) {
        throw new UnprocessableEntityException('sign-in state mismatch — restart connect');
      }
      code = parsed.code;
    } catch (err) {
      if (err instanceof PasteParseError) {
        throw new UnprocessableEntityException(err.message);
      }
      throw err;
    }

    let tokens: TokenSet;
    try {
      tokens = await this.tokenFetch({
        tokenEndpoint: preset.tokenEndpoint,
        clientId: preset.clientId,
        mode: this.rt.mode,
        encoding: preset.tokenRequestEncoding,
        grant: 'exchange',
        body: {
          grant_type: 'authorization_code',
          code,
          // `state` in the token body is a per-preset quirk: console.anthropic.com's
          // exchange takes it; auth.openai.com 400s on the unknown parameter.
          ...(preset.includeStateInExchange ? { state: session.state } : {}),
          redirect_uri: preset.redirectUri,
          code_verifier: session.verifier,
        },
      });
    } catch (err) {
      if (err instanceof TokenEndpointError) {
        if (err.kind === 'invalid_grant') {
          throw new UnprocessableEntityException('the sign-in code was rejected — restart connect');
        }
        throw new ServiceUnavailableException('the identity provider is unreachable — try again');
      }
      throw err;
    }
    // The exchange contract requires a refresh token (parse enforces it); this guard
    // keeps a nonconforming injected fetch from writing an unrenewable envelope.
    if (tokens.refreshToken === undefined) {
      throw new ServiceUnavailableException('the identity provider is unreachable — try again');
    }

    // Presets whose protocol addresses by account id (ChatGPT) capture it from the
    // exchange id_token BEFORE any write; a missing/invalid claim fails typed with a
    // FIXED message (the token/claims are never logged or echoed — invariant 8).
    let accountId: string | undefined;
    if (presetRequiresAccountId(preset)) {
      try {
        if (tokens.idToken === undefined) throw new AccountClaimError();
        accountId = extractChatgptAccountId(tokens.idToken);
      } catch (err) {
        if (err instanceof AccountClaimError) {
          throw new UnprocessableEntityException(
            'the sign-in response did not include the account details — restart connect',
          );
        }
        throw err;
      }
    }

    const envelope = encryptSecret(
      serializeOauthCredential({
        preset: preset.id,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        ...(accountId !== undefined ? { accountId } : {}),
      }),
      this.rt.key,
    );

    if (session.providerId === undefined) {
      return this.db.providers.insert(principal, {
        name: session.name ?? preset.displayName,
        kind: 'subscription',
        protocol: preset.protocol,
        baseUrl: preset.baseUrl,
        encryptedCredentials: envelope,
        oauthPreset: preset.id,
        credentialExpiresAt: new Date(tokens.expiresAt),
        credentialError: null,
      });
    }

    // Reauthorize: replace in place UNDER the credential lock, re-verifying the row is
    // still the same preset-connected provider the session was started for — a stale
    // completion (deleted/cleared/changed provider) writes nothing.
    const providerId = session.providerId;
    const presetId = session.preset;
    const row = await this.facilities.withAdvisoryLock(credentialLockKey(providerId), async (tx) => {
      const fresh = await tx.providers.findById(principal, providerId);
      if (
        !fresh ||
        fresh.kind !== 'subscription' ||
        fresh.oauthPreset !== presetId ||
        fresh.encryptedCredentials === null
      ) {
        throw new UnprocessableEntityException('provider changed — restart connect');
      }
      const updated = await tx.providers.update(principal, providerId, {
        encryptedCredentials: envelope,
        credentialExpiresAt: new Date(tokens.expiresAt),
        credentialError: null,
      });
      if (!updated) throw new NotFoundException();
      return updated;
    });
    // Reauthorize-ONLY breaker reset: the freshly reconnected provider must not serve a
    // cooldown earned by its dead credential. (Ordinary refresh never does this.)
    await this.breakerStore.reset(providerId).catch(() => undefined);
    return row;
  }

  // ---- credential resolution (both adapter-build sites) ----

  async resolveCredential(principal: Principal, provider: ProviderRow): Promise<ResolvedCredential> {
    if (provider.encryptedCredentials === null) {
      throw new ProviderError('credential', 'provider has no credential');
    }
    // Durable credential-error: fail locally BEFORE any decrypt/IdP work — a dead
    // grant (or an unreadable envelope recorded below) is never re-probed per request.
    // A Responses row keeps failing fast even after a PATCH cleared its preset (the
    // protocol itself cannot run on a pasted credential).
    if (
      provider.credentialError !== null &&
      (provider.oauthPreset !== null || provider.protocol === 'openai_responses')
    ) {
      throw reauthorizeRequired();
    }
    let parsed;
    try {
      parsed = parseCredentialEnvelope(decryptSecret(provider.encryptedCredentials, this.rt.key));
    } catch (err) {
      // For a row that CLAIMS an OAuth connection, an undecryptable (wrong key) or
      // marker-malformed envelope is a durable credential failure: persist
      // reauthorize_required (serialized on the credential lock) and fail
      // breaker-NEUTRAL — never a tripping 'unavailable' setup error.
      if (provider.oauthPreset !== null) {
        await this.persistCredentialError(principal, provider.id).catch(() => undefined);
        throw tampered();
      }
      if (err instanceof TamperedCredentialError) throw tampered();
      throw err;
    }
    if (parsed.kind === 'plain') {
      // The Responses protocol cannot run on a pasted credential (no account id) —
      // durable tampered state, never an api_key call with a wrong-shaped header set.
      if (provider.protocol === 'openai_responses') {
        await this.persistCredentialError(principal, provider.id).catch(() => undefined);
        throw tampered();
      }
      return { credential: parsed.value, authScheme: 'api_key' };
    }
    const preset = this.coherentPreset(provider, parsed.cred);
    // A Responses envelope without its account id is tampered/incomplete — durable
    // reauthorize-required, decided BEFORE any cheap-path return.
    if (presetRequiresAccountId(preset) && parsed.cred.accountId === undefined) {
      await this.persistCredentialError(principal, provider.id).catch(() => undefined);
      throw tampered();
    }
    const now = Date.now();
    if (parsed.cred.expiresAt - now > REFRESH_MARGIN_MS) {
      return this.resolved(parsed.cred.accessToken, preset, parsed.cred.accountId); // cheap path
    }
    // Transient-failure backoff: don't re-dial the IdP; serve the still-valid token.
    if ((await this.redis.get(backoffKey(provider.id)).catch(() => null)) !== null) {
      if (parsed.cred.expiresAt > now) {
        return this.resolved(parsed.cred.accessToken, preset, parsed.cred.accountId);
      }
      throw idpUnavailable();
    }
    const existing = this.inflight.get(provider.id);
    if (existing) return existing;
    const flight = this.refreshFlight(principal, provider.id, preset).finally(() => {
      this.inflight.delete(provider.id);
    });
    this.inflight.set(provider.id, flight);
    return flight;
  }

  private resolved(
    accessToken: string,
    preset: OauthPreset,
    accountId?: string,
  ): ResolvedCredential {
    return {
      credential: accessToken,
      authScheme: 'oauth_bearer',
      ...(preset.oauthBeta !== undefined ? { oauthBeta: preset.oauthBeta } : {}),
      ...(accountId !== undefined ? { oauthAccountId: accountId } : {}),
      ...(preset.probeModel !== undefined ? { probeModel: preset.probeModel } : {}),
    };
  }

  /** Envelope↔row coherence (round-1): the preset named by the tokens must be the
   * row's preset, on a subscription row pinned to the preset's endpoint. */
  private coherentPreset(provider: ProviderRow, cred: OauthCredential): OauthPreset {
    const preset = this.presets.find(cred.preset);
    if (
      !preset ||
      provider.kind !== 'subscription' ||
      provider.oauthPreset !== cred.preset ||
      provider.baseUrl !== preset.baseUrl ||
      provider.protocol !== preset.protocol
    ) {
      throw tampered();
    }
    return preset;
  }

  /** Persist the durable reauthorize-required state, serialized on the same
   * per-provider credential lock as every other mutation. */
  private async persistCredentialError(principal: Principal, providerId: string): Promise<void> {
    await this.facilities.withAdvisoryLock(
      credentialLockKey(providerId),
      (tx) =>
        tx.providers.update(principal, providerId, {
          credentialError: 'reauthorize_required',
          status: 'error',
        }),
      { lockTimeoutMs: LOCK_WAIT_MS },
    );
  }

  /** The single-flight refresh: a GENUINELY bounded lock wait (transaction-local
   * lock_timeout — a timeout aborts the tx and frees the connection; no detached
   * waiter survives) → locked re-read → refresh → in-lock persist. All mutations
   * share the lock, so the in-lock write cannot clobber a concurrent
   * PATCH/reauthorize. On a lock timeout: ONE unlocked re-read (the winner may have
   * finished) — adopt a fresh envelope or fail transient. */
  private async refreshFlight(
    principal: Principal,
    providerId: string,
    presetHint: OauthPreset,
  ): Promise<ResolvedCredential> {
    try {
      return await this.facilities.withAdvisoryLock(
        credentialLockKey(providerId),
        (tx) => this.refreshUnderLock(tx, principal, providerId),
        { lockTimeoutMs: LOCK_WAIT_MS },
      );
    } catch (err) {
      if (!(err instanceof AdvisoryLockTimeoutError)) throw err;
      const fresh = await this.db.providers.findById(principal, providerId);
      if (fresh && fresh.encryptedCredentials !== null && fresh.credentialError === null) {
        const reread = parseCredentialEnvelope(
          decryptSecret(fresh.encryptedCredentials, this.rt.key),
        );
        if (reread.kind === 'oauth' && reread.cred.expiresAt - Date.now() > 0) {
          return this.resolved(reread.cred.accessToken, presetHint, reread.cred.accountId);
        }
      }
      throw idpUnavailable();
    }
  }

  private async refreshUnderLock(
    tx: PersistencePort,
    principal: Principal,
    providerId: string,
  ): Promise<ResolvedCredential> {
    const fresh = await tx.providers.findById(principal, providerId);
    // Deleted row / cleared credential / no-longer-oauth: abort, write nothing.
    if (!fresh || fresh.encryptedCredentials === null) throw reauthorizeRequired();
    let parsed;
    try {
      parsed = parseCredentialEnvelope(decryptSecret(fresh.encryptedCredentials, this.rt.key));
    } catch {
      throw tampered();
    }
    if (parsed.kind === 'plain') {
      // A concurrent PATCH converted it to a pasted credential — adopt that. Except
      // for the Responses protocol, which cannot run on one: durable tampered state.
      if (fresh.protocol === 'openai_responses') {
        await tx.providers.update(principal, providerId, {
          credentialError: 'reauthorize_required',
          status: 'error',
        });
        throw tampered();
      }
      return { credential: parsed.value, authScheme: 'api_key' };
    }
    const preset = this.coherentPreset(fresh, parsed.cred);
    if (fresh.credentialError !== null) throw reauthorizeRequired();
    // A Responses envelope missing its account id: durable tampered (mirrors
    // resolveCredential — this path can be reached first by a queued waiter).
    if (presetRequiresAccountId(preset) && parsed.cred.accountId === undefined) {
      await tx.providers.update(principal, providerId, {
        credentialError: 'reauthorize_required',
        status: 'error',
      });
      throw tampered();
    }
    const now = Date.now();
    if (parsed.cred.expiresAt - now > REFRESH_MARGIN_MS) {
      return this.resolved(parsed.cred.accessToken, preset, parsed.cred.accountId); // another instance won
    }
    // Backoff RE-CHECK under the lock: a waiter queued before another instance's
    // transient failure must not dial the IdP the moment it acquires the lock.
    if ((await this.redis.get(backoffKey(providerId)).catch(() => null)) !== null) {
      if (parsed.cred.expiresAt > now) {
        return this.resolved(parsed.cred.accessToken, preset, parsed.cred.accountId);
      }
      throw idpUnavailable();
    }
    let tokens: TokenSet;
    try {
      tokens = await this.tokenFetch({
        tokenEndpoint: preset.tokenEndpoint,
        clientId: preset.clientId,
        mode: this.rt.mode,
        encoding: preset.tokenRequestEncoding,
        grant: 'refresh',
        body: { grant_type: 'refresh_token', refresh_token: parsed.cred.refreshToken },
      });
    } catch (err) {
      if (err instanceof TokenEndpointError && err.kind === 'invalid_grant') {
        // Durable reauthorize-required (visible after reload); subsequent resolutions
        // fail locally. Breaker-NEUTRAL by error kind.
        await tx.providers.update(principal, providerId, {
          credentialError: 'reauthorize_required',
          status: 'error',
        });
        throw reauthorizeRequired();
      }
      // Transient: keep tokens untouched; short cross-instance backoff; margin grace.
      await this.redis
        .set(backoffKey(providerId), '1', 'PX', BACKOFF_MS, 'NX')
        .catch(() => undefined);
      if (parsed.cred.expiresAt > now) {
        // Grace serves the FULL resolution — dropping accountId here would fail
        // Responses adapter construction while the token is still valid (r3).
        return this.resolved(parsed.cred.accessToken, preset, parsed.cred.accountId);
      }
      throw idpUnavailable();
    }
    await tx.providers.update(principal, providerId, {
      encryptedCredentials: encryptSecret(
        serializeOauthCredential({
          preset: preset.id,
          accessToken: tokens.accessToken,
          // Refresh-omission retention: a response without refresh_token keeps the
          // stored one (non-rotating endpoints).
          refreshToken: tokens.refreshToken ?? parsed.cred.refreshToken,
          expiresAt: tokens.expiresAt,
          // The account id is exchange-time data — RETAINED through every rotation.
          ...(parsed.cred.accountId !== undefined ? { accountId: parsed.cred.accountId } : {}),
        }),
        this.rt.key,
      ),
      credentialExpiresAt: new Date(tokens.expiresAt),
      credentialError: null,
    });
    return this.resolved(tokens.accessToken, preset, parsed.cred.accountId);
  }
}
