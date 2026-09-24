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
import { createHash, randomBytes } from 'node:crypto';
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
import { incarnationOf, reauthorizeRequiredCheck } from '../providers/provider-health';
import type { Redis } from 'ioredis';
import {
  ConnectSessionStore,
  OauthSessionUnavailableError,
  mintPkce,
  type ConnectSession,
} from './connect-sessions';
import { AccountClaimError, extractChatgptAccountId } from './account-claim';
import {
  TokenEndpointError,
  fetchTokenSet,
  type OauthTokenFetch,
  type TokenSet,
} from './oauth-client';
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

// ---- add-provider-health-signals ----
/** A grant verified by a successful exchange/refresh is not liveness-due again for
 * this long (the proactive sweep's liveness window). */
export const VERIFIED_TTL_MS = 24 * 60 * 60 * 1000;
/** A liveness check that failed transiently is retried no sooner than this. */
export const VERIFIED_RETRY_TTL_MS = 60 * 60 * 1000;
/** One 401-triggered forced refresh per provider and credential per window. */
const FORCED_COOLDOWN_MS = 10 * 60 * 1000;
/** One test-connection inline repair per provider per window. */
const TEST_REPAIR_COOLDOWN_MS = 60 * 1000;

export const verifiedKey = (providerId: string): string => `oauth:verified:${providerId}`;
/** Fenced by a fingerprint of the credential version — a SHA-256 of the stored
 * ciphertext (not secret; its hash reveals nothing), truncated. */
const forcedClaimKey = (providerId: string, envelope: string): string =>
  `oauth:forced:${providerId}:${createHash('sha256').update(envelope).digest('hex').slice(0, 16)}`;
const testRepairKey = (providerId: string): string => `oauth:test-forced:${providerId}`;

export type ForceRefreshReason = '401' | 'test' | 'scheduled';
/** refreshed — the token endpoint rotated the tokens; adopted — the stored
 * credential had already changed (another path renewed it); transient — IdP
 * unreachable/5xx, backoff held, or the lock wait timed out (nothing written);
 * reauthorize_required — durably recorded; aborted — deleted, cleared, or not an
 * OAuth credential (nothing written). */
export type ForceRefreshOutcome =
  'refreshed' | 'adopted' | 'transient' | 'reauthorize_required' | 'aborted';

export interface ResolvedCredential {
  readonly credential: string;
  readonly authScheme: AuthScheme;
  /** INTERNAL (add-provider-health-signals): the stored envelope ciphertext this
   * resolution used — the newly written one after a lazy refresh. The compare key
   * for a forced refresh and the health incarnation guard. Never logged, never
   * placed in an adapter config, never returned by any API. */
  readonly envelope: string;
  readonly oauthBeta?: string;
  /** TRUSTED envelope data for the Responses protocol (add-chatgpt-responses):
   * emitted as the `chatgpt-account-id` header. Never logged or exposed. */
  readonly oauthAccountId?: string;
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

/** The ONE durable reauthorize-required write (add-provider-health-signals): the
 * credential state plus the shared `credential`/`refresh` check record, both inside
 * the caller's credential lock. Neither write changes the incarnation, so the
 * health write's guard (the row as just re-read under the lock) always holds. */
async function markReauthorizeRequired(
  tx: PersistencePort,
  principal: Principal,
  fresh: ProviderRow,
): Promise<void> {
  await tx.providers.update(principal, fresh.id, { credentialError: 'reauthorize_required' });
  await tx.providers.setHealth(
    principal,
    fresh.id,
    reauthorizeRequiredCheck(),
    incarnationOf(fresh),
  );
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
      throw new UnprocessableEntityException(
        'unknown or expired connect session — restart connect',
      );
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
      const inserted = await this.db.providers.insert(principal, {
        name: session.name ?? preset.displayName,
        kind: 'subscription',
        protocol: preset.protocol,
        baseUrl: preset.baseUrl,
        encryptedCredentials: envelope,
        oauthPreset: preset.id,
        credentialExpiresAt: new Date(tokens.expiresAt),
        credentialError: null,
      });
      await this.markVerified(inserted.id);
      return inserted;
    }

    // Reauthorize: replace in place UNDER the credential lock, re-verifying the row is
    // still the same preset-connected provider the session was started for — a stale
    // completion (deleted/cleared/changed provider) writes nothing.
    const providerId = session.providerId;
    const presetId = session.preset;
    const row = await this.facilities.withAdvisoryLock(
      credentialLockKey(providerId),
      async (tx) => {
        const fresh = await tx.providers.findById(principal, providerId);
        if (
          !fresh ||
          fresh.kind !== 'subscription' ||
          fresh.oauthPreset !== presetId ||
          fresh.encryptedCredentials === null
        ) {
          throw new UnprocessableEntityException('provider changed — restart connect');
        }
        // add-provider-health-signals: a reconnect is a new incarnation — the check
        // record resets to `unknown` (source `reconnect`) and the traffic record
        // clears in this SAME write, so nothing observed against the dead
        // credential is ever displayed (or recorded) for the new one.
        const updated = await tx.providers.updateResettingHealth(
          principal,
          providerId,
          {
            encryptedCredentials: envelope,
            credentialExpiresAt: new Date(tokens.expiresAt),
            credentialError: null,
          },
          'reconnect',
        );
        if (!updated) throw new NotFoundException();
        return updated;
      },
    );
    // Reauthorize-ONLY breaker reset: the freshly reconnected provider must not serve a
    // cooldown earned by its dead credential. (Ordinary refresh never does this.)
    await this.breakerStore.reset(providerId).catch(() => undefined);
    await this.markVerified(providerId);
    return row;
  }

  // ---- credential resolution (both adapter-build sites) ----

  async resolveCredential(
    principal: Principal,
    provider: ProviderRow,
  ): Promise<ResolvedCredential> {
    if (provider.encryptedCredentials === null) {
      throw new ProviderError('credential', 'provider has no credential');
    }
    const stored = provider.encryptedCredentials;
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
      parsed = parseCredentialEnvelope(decryptSecret(stored, this.rt.key));
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
      return { credential: parsed.value, authScheme: 'api_key', envelope: stored };
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
      return this.resolved(stored, parsed.cred.accessToken, preset, parsed.cred.accountId); // cheap path
    }
    // Transient-failure backoff: don't re-dial the IdP; serve the still-valid token.
    if ((await this.redis.get(backoffKey(provider.id)).catch(() => null)) !== null) {
      if (parsed.cred.expiresAt > now) {
        return this.resolved(stored, parsed.cred.accessToken, preset, parsed.cred.accountId);
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
    envelope: string,
    accessToken: string,
    preset: OauthPreset,
    accountId?: string,
  ): ResolvedCredential {
    return {
      credential: accessToken,
      authScheme: 'oauth_bearer',
      envelope,
      ...(preset.oauthBeta !== undefined ? { oauthBeta: preset.oauthBeta } : {}),
      ...(accountId !== undefined ? { oauthAccountId: accountId } : {}),
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
      async (tx) => {
        const fresh = await tx.providers.findById(principal, providerId);
        if (fresh) await markReauthorizeRequired(tx, principal, fresh);
      },
      { lockTimeoutMs: LOCK_WAIT_MS },
    );
  }

  /** Mark the grant verified for the proactive sweep's liveness window
   * (add-provider-health-signals). Best-effort: a lost key costs one budgeted
   * liveness re-check, never a failure. */
  private async markVerified(providerId: string, ttlMs = VERIFIED_TTL_MS): Promise<void> {
    await this.redis.set(verifiedKey(providerId), '1', 'PX', ttlMs).catch(() => undefined);
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
      const r = await this.facilities.withAdvisoryLock(
        credentialLockKey(providerId),
        (tx) => this.refreshUnderLock(tx, principal, providerId),
        { lockTimeoutMs: LOCK_WAIT_MS },
      );
      // A failure that WROTE durable state is returned, not thrown, from inside the
      // lock: `withAdvisoryLock` runs a transaction, and a throw would roll back the
      // very `reauthorize_required` write the spec requires to be durable
      // (add-provider-health-signals found this — it was never persisted before).
      if (!r.ok) throw r.error;
      // Only a REAL exchange verifies the grant — set after the lock's commit.
      if (r.exchanged) await this.markVerified(providerId);
      return r.resolved;
    } catch (err) {
      if (!(err instanceof AdvisoryLockTimeoutError)) throw err;
      const fresh = await this.db.providers.findById(principal, providerId);
      if (fresh && fresh.encryptedCredentials !== null && fresh.credentialError === null) {
        const reread = parseCredentialEnvelope(
          decryptSecret(fresh.encryptedCredentials, this.rt.key),
        );
        if (reread.kind === 'oauth' && reread.cred.expiresAt - Date.now() > 0) {
          return this.resolved(
            fresh.encryptedCredentials,
            reread.cred.accessToken,
            presetHint,
            reread.cred.accountId,
          );
        }
      }
      throw idpUnavailable();
    }
  }

  /** The lazy (pre-request) refresh under the lock. A failure that wrote durable
   * state is RETURNED (the caller throws it after the transaction commits). */
  private async refreshUnderLock(
    tx: PersistencePort,
    principal: Principal,
    providerId: string,
  ): Promise<
    | { readonly ok: true; readonly resolved: ResolvedCredential; readonly exchanged: boolean }
    | { readonly ok: false; readonly error: ProviderError }
  > {
    const fresh = await tx.providers.findById(principal, providerId);
    // Deleted row / cleared credential / no-longer-oauth: abort, write nothing.
    if (!fresh || fresh.encryptedCredentials === null) throw reauthorizeRequired();
    const stored = fresh.encryptedCredentials;
    let parsed;
    try {
      parsed = parseCredentialEnvelope(decryptSecret(stored, this.rt.key));
    } catch {
      throw tampered();
    }
    if (parsed.kind === 'plain') {
      // A concurrent PATCH converted it to a pasted credential — adopt that. Except
      // for the Responses protocol, which cannot run on one: durable tampered state.
      if (fresh.protocol === 'openai_responses') {
        await markReauthorizeRequired(tx, principal, fresh);
        return { ok: false, error: tampered() };
      }
      return {
        ok: true,
        resolved: { credential: parsed.value, authScheme: 'api_key', envelope: stored },
        exchanged: false,
      };
    }
    const preset = this.coherentPreset(fresh, parsed.cred);
    if (fresh.credentialError !== null) throw reauthorizeRequired();
    // A Responses envelope missing its account id: durable tampered (mirrors
    // resolveCredential — this path can be reached first by a queued waiter).
    if (presetRequiresAccountId(preset) && parsed.cred.accountId === undefined) {
      await markReauthorizeRequired(tx, principal, fresh);
      return { ok: false, error: tampered() };
    }
    const cred = parsed.cred;
    const grace = (): ResolvedCredential =>
      // Grace serves the FULL resolution — dropping accountId here would fail
      // Responses adapter construction while the token is still valid (r3).
      this.resolved(stored, cred.accessToken, preset, cred.accountId);
    const now = Date.now();
    if (cred.expiresAt - now > REFRESH_MARGIN_MS) {
      return { ok: true, resolved: grace(), exchanged: false }; // another instance won
    }
    // Backoff RE-CHECK under the lock: a waiter queued before another instance's
    // transient failure must not dial the IdP the moment it acquires the lock.
    if ((await this.redis.get(backoffKey(providerId)).catch(() => null)) !== null) {
      if (cred.expiresAt > now) return { ok: true, resolved: grace(), exchanged: false };
      return { ok: false, error: idpUnavailable() };
    }
    const r = await this.exchangeUnderLock(tx, principal, fresh, cred, preset);
    if (r.kind === 'refreshed') return { ok: true, resolved: r.resolved, exchanged: true };
    if (r.kind === 'reauthorize_required') return { ok: false, error: reauthorizeRequired() };
    // Transient: tokens untouched, backoff set; margin grace for a lazy caller only.
    if (cred.expiresAt > now) return { ok: true, resolved: grace(), exchanged: false };
    return { ok: false, error: idpUnavailable() };
  }

  /** The token-endpoint exchange + in-lock persist, shared by the lazy and forced
   * paths. `invalid_grant` → durable reauthorize-required (breaker-neutral by
   * kind); any other failure → transient: tokens untouched, short cross-instance
   * backoff. The breaker is never touched here. */
  private async exchangeUnderLock(
    tx: PersistencePort,
    principal: Principal,
    fresh: ProviderRow,
    cred: OauthCredential,
    preset: OauthPreset,
  ): Promise<
    | { readonly kind: 'refreshed'; readonly resolved: ResolvedCredential }
    | { readonly kind: 'reauthorize_required' }
    | { readonly kind: 'transient' }
  > {
    let tokens: TokenSet;
    try {
      tokens = await this.tokenFetch({
        tokenEndpoint: preset.tokenEndpoint,
        clientId: preset.clientId,
        mode: this.rt.mode,
        encoding: preset.tokenRequestEncoding,
        grant: 'refresh',
        body: { grant_type: 'refresh_token', refresh_token: cred.refreshToken },
      });
    } catch (err) {
      if (err instanceof TokenEndpointError && err.kind === 'invalid_grant') {
        // Durable reauthorize-required (visible after reload); subsequent resolutions
        // fail locally.
        await markReauthorizeRequired(tx, principal, fresh);
        return { kind: 'reauthorize_required' };
      }
      await this.redis
        .set(backoffKey(fresh.id), '1', 'PX', BACKOFF_MS, 'NX')
        .catch(() => undefined);
      return { kind: 'transient' };
    }
    const envelope = encryptSecret(
      serializeOauthCredential({
        preset: preset.id,
        accessToken: tokens.accessToken,
        // Refresh-omission retention: a response without refresh_token keeps the
        // stored one (non-rotating endpoints).
        refreshToken: tokens.refreshToken ?? cred.refreshToken,
        expiresAt: tokens.expiresAt,
        // The account id is exchange-time data — RETAINED through every rotation.
        ...(cred.accountId !== undefined ? { accountId: cred.accountId } : {}),
      }),
      this.rt.key,
    );
    await tx.providers.update(principal, fresh.id, {
      encryptedCredentials: envelope,
      credentialExpiresAt: new Date(tokens.expiresAt),
      credentialError: null,
    });
    return {
      kind: 'refreshed',
      resolved: this.resolved(envelope, tokens.accessToken, preset, cred.accountId),
    };
  }

  // ---- out-of-band (forced) refresh — add-provider-health-signals ----

  /** A FORCED refresh keyed on the stored credential the caller actually used
   * (`usedEnvelope`, the ciphertext — random IV per write, so every credential
   * mutation changes it). Under the per-provider lock, in order: the stored
   * envelope differs → `adopted` (another path renewed it; no exchange, no write);
   * a deleted/cleared/non-OAuth row → `aborted`; a durable credential error →
   * `reauthorize_required`; the transient backoff held → `transient`; OTHERWISE the
   * token endpoint is called REGARDLESS of expiry — never the lazy path's "fresh
   * enough" early return, so a 240h token rejected upstream is really refreshed. A
   * transient failure reports `transient` (margin grace serves only a lazy caller).
   * Never touches the breaker. May reject on an unexpected persistence error. */
  async forceRefresh(
    principal: Principal,
    providerId: string,
    usedEnvelope: string,
    _reason: ForceRefreshReason,
  ): Promise<ForceRefreshOutcome> {
    let outcome: ForceRefreshOutcome;
    try {
      outcome = await this.facilities.withAdvisoryLock(
        credentialLockKey(providerId),
        (tx) => this.forceUnderLock(tx, principal, providerId, usedEnvelope),
        { lockTimeoutMs: LOCK_WAIT_MS },
      );
    } catch (err) {
      if (err instanceof AdvisoryLockTimeoutError) return 'transient';
      throw err;
    }
    if (outcome === 'refreshed' || outcome === 'adopted') await this.markVerified(providerId);
    return outcome;
  }

  private async forceUnderLock(
    tx: PersistencePort,
    principal: Principal,
    providerId: string,
    usedEnvelope: string,
  ): Promise<ForceRefreshOutcome> {
    const fresh = await tx.providers.findById(principal, providerId);
    if (!fresh || fresh.encryptedCredentials === null) return 'aborted';
    if (fresh.encryptedCredentials !== usedEnvelope) return 'adopted';
    if (fresh.oauthPreset === null && fresh.protocol !== 'openai_responses') return 'aborted';
    if (fresh.credentialError !== null) return 'reauthorize_required';
    let parsed;
    try {
      parsed = parseCredentialEnvelope(decryptSecret(fresh.encryptedCredentials, this.rt.key));
    } catch {
      // An OAuth row whose envelope cannot be read is durably unusable.
      await markReauthorizeRequired(tx, principal, fresh);
      return 'reauthorize_required';
    }
    if (parsed.kind === 'plain') {
      if (fresh.protocol === 'openai_responses') {
        await markReauthorizeRequired(tx, principal, fresh);
        return 'reauthorize_required';
      }
      return 'aborted'; // a pasted credential has nothing to refresh
    }
    let preset: OauthPreset;
    try {
      preset = this.coherentPreset(fresh, parsed.cred);
    } catch {
      return 'aborted';
    }
    if (presetRequiresAccountId(preset) && parsed.cred.accountId === undefined) {
      await markReauthorizeRequired(tx, principal, fresh);
      return 'reauthorize_required';
    }
    if ((await this.redis.get(backoffKey(providerId)).catch(() => null)) !== null) {
      return 'transient';
    }
    const r = await this.exchangeUnderLock(tx, principal, fresh, parsed.cred, preset);
    return r.kind;
  }

  /** The proxy's 401 trigger: at most ONE forced refresh per provider AND per stored
   * credential per cooldown window, claimed atomically across instances. The claim
   * is fenced by a fingerprint of the credential the failing attempt used, so a late
   * 401 from a replaced credential can never consume its replacement's window. Fails
   * CLOSED (no claim → no refresh) and NEVER rejects — it runs off the request path. */
  async requestForcedRefresh(
    principal: Principal,
    providerId: string,
    usedEnvelope: string,
  ): Promise<ForceRefreshOutcome | 'skipped'> {
    try {
      const claimed = await this.redis.set(
        forcedClaimKey(providerId, usedEnvelope),
        '1',
        'PX',
        FORCED_COOLDOWN_MS,
        'NX',
      );
      if (claimed !== 'OK') return 'skipped';
      return await this.forceRefresh(principal, providerId, usedEnvelope, '401');
    } catch {
      return 'skipped';
    }
  }

  /** test-connection's repair limiter: at most one inline repair per provider per
   * minute. Fails CLOSED — a held claim or an unavailable Redis means no repair. */
  async claimTestRepair(providerId: string): Promise<boolean> {
    try {
      return (
        (await this.redis.set(
          testRepairKey(providerId),
          '1',
          'PX',
          TEST_REPAIR_COOLDOWN_MS,
          'NX',
        )) === 'OK'
      );
    } catch {
      return false;
    }
  }
}
