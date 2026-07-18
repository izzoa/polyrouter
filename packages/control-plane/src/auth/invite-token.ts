import { createHash, randomBytes } from 'node:crypto';

/** Invite-token discipline mirrors agent keys (invariants 7/8): 24 random
 * bytes base64url; storage is prefix + SHA-256 hex ONLY — the raw token exists
 * exactly once, in the returned link/email. */

export const INVITE_TTL_MS = 72 * 60 * 60 * 1000; // 72h

export interface MintedInvite {
  token: string;
  tokenPrefix: string;
  tokenHash: string;
  expiresAt: Date;
}

export function mintInviteToken(now = new Date()): MintedInvite {
  const token = randomBytes(24).toString('base64url');
  return {
    token,
    tokenPrefix: token.slice(0, 12),
    tokenHash: hashInviteToken(token),
    expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
  };
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Shape sanity before hashing — rejects junk cheaply and uniformly. */
export function isPlausibleInviteToken(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{32}$/.test(token);
}
