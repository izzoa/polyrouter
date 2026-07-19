/**
 * Server-held OAuth connect sessions (add-subscription-oauth). Redis-backed so the
 * paste-back completion works across instances (invariant 10): short TTL, bound to the
 * creating principal AND their authenticated dashboard session, single-use via an
 * ATOMIC claim (GETDEL) consumed BEFORE the token exchange — a double-submit cannot
 * double-exchange. A per-principal cap bounds outstanding sessions (a new start beyond
 * the cap evicts the oldest). Redis unavailable → typed failure (fail closed).
 * The PKCE verifier is short-lived and useless without the code; it never touches logs.
 */
import { randomBytes, createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

export const SESSION_TTL_S = 600;
export const MAX_SESSIONS_PER_PRINCIPAL = 5;

const KEY = (id: string): string => `oauth:sess:${id}`;
const IDX = (principalKey: string): string => `oauth:sessidx:${principalKey}`;

export interface ConnectSession {
  readonly state: string;
  readonly verifier: string;
  readonly preset: string;
  readonly principalKey: string;
  readonly authSessionId: string;
  /** Set for a reauthorization session — completion updates this row in place. */
  readonly providerId?: string;
  readonly name?: string;
}

export class OauthSessionUnavailableError extends Error {
  constructor() {
    super('connect sessions unavailable'); // fixed message; fail closed on Redis outage
    this.name = 'OauthSessionUnavailableError';
  }
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function mintPkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export class ConnectSessionStore {
  constructor(private readonly redis: Redis) {}

  /** Store a new session; evicts the principal's oldest beyond the cap. */
  async create(session: ConnectSession): Promise<string> {
    const id = b64url(randomBytes(24));
    try {
      await this.redis.set(KEY(id), JSON.stringify(session), 'EX', SESSION_TTL_S);
      const idx = IDX(session.principalKey);
      await this.redis.lpush(idx, id);
      await this.redis.expire(idx, SESSION_TTL_S);
      const evicted = await this.redis.lrange(idx, MAX_SESSIONS_PER_PRINCIPAL, -1);
      if (evicted.length > 0) {
        await this.redis.ltrim(idx, 0, MAX_SESSIONS_PER_PRINCIPAL - 1);
        await this.redis.del(...evicted.map(KEY));
      }
      return id;
    } catch {
      throw new OauthSessionUnavailableError();
    }
  }

  /** ATOMIC single-use claim: the session is consumed before any exchange, so a
   * concurrent double-submit yields exactly one winner. Returns null for an
   * unknown/expired/already-consumed session. */
  async claim(id: string): Promise<ConnectSession | null> {
    let raw: string | null;
    try {
      raw = await this.redis.getdel(KEY(id));
    } catch {
      throw new OauthSessionUnavailableError();
    }
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as ConnectSession;
    } catch {
      return null;
    }
  }
}
