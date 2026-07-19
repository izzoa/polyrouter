/** Display formatting for USD per-1M prices. Listed estimates are derived from
 * per-token rates ×1e6, which leaves float64 noise ("$0.19999999999999998") — six
 * significant digits kills the noise (it lives at ~16 significant digits) while
 * preserving every real price ("$0.2", "$2.5", "$0.0375", "$15"). Display only —
 * recorded cost never flows through here (invariant 4). */
export function fmtUsd(v: number): string {
  if (!Number.isFinite(v)) return '$?';
  return `$${String(Number(v.toPrecision(6)))}`;
}
