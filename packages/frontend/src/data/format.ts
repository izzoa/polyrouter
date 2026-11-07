/** Display formatting for USD per-1M prices. Listed estimates are derived from
 * per-token rates ×1e6, which leaves float64 noise ("$0.19999999999999998") — six
 * significant digits kills the noise (it lives at ~16 significant digits) while
 * preserving every real price ("$0.2", "$2.5", "$0.0375", "$15"). Display only —
 * recorded cost never flows through here (invariant 4). */
export function fmtUsd(v: number): string {
  if (!Number.isFinite(v)) return '$?';
  return `$${String(Number(v.toPrecision(6)))}`;
}

/** A relative time for an ISO timestamp — "just now", "Nm ago", "Nh ago", else the
 * calendar date; "never" for a missing or unparseable value. Shared by the agents
 * table ("last used") and the provider card's health line (add-provider-health-
 * signals). `now` is injectable for tests. */
export function fmtWhen(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'never';
  const secs = Math.round((now - t) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${String(Math.floor(secs / 60))}m ago`;
  if (secs < 86400) return `${String(Math.floor(secs / 3600))}h ago`;
  return new Date(t).toLocaleDateString();
}

/** The FUTURE counterpart of `fmtWhen` (classify-plan-quota-errors, design D11): an absolute
 * clock time in the viewer's zone with the zone's short name, "18:00 UTC", plus the month and
 * day when the instant is not on the viewer's current calendar day, "Nov 9, 18:00 UTC". An
 * absolute time never goes stale on screen, so the caller needs no ticking clock. `null` for
 * an unparseable or an already-passed instant, so a caller can never show "just now" for a
 * future end. `timeZone` exists so tests can pin the output; omitted, it is the viewer's. */
export function fmtUntil(iso: string, now: number = Date.now(), timeZone?: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t) || t <= now) return null;
  const zone = timeZone === undefined ? {} : { timeZone };
  const day = new Intl.DateTimeFormat('en-US', {
    ...zone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });
  const clock = new Intl.DateTimeFormat('en-US', {
    ...zone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  const time = clock.format(t);
  if (day.format(t) === day.format(now)) return time;
  const date = new Intl.DateTimeFormat('en-US', { ...zone, month: 'short', day: 'numeric' });
  return `${date.format(t)}, ${time}`;
}
