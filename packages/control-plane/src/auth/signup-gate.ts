import { AsyncLocalStorage } from 'node:async_hooks';

/** Server-side invite bypass for the registration gate (user-administration).
 *
 * The public accept-invite endpoint atomically CLAIMS the invite first, then
 * runs the normal Better Auth signup wrapped in this ALS context; the gate
 * hooks honor the bypass only when the email matches the claimed invite.
 * Purely in-process — a client request can never carry or forge it. */
const inviteBypass = new AsyncLocalStorage<{ email: string }>();

export function runWithInviteBypass<T>(email: string, fn: () => Promise<T>): Promise<T> {
  return inviteBypass.run({ email: email.toLowerCase() }, fn);
}

/** The claimed-invite email for the current async context, or null. */
export function inviteBypassEmail(): string | null {
  return inviteBypass.getStore()?.email ?? null;
}
