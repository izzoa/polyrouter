/**
 * The batch spend ceiling (add-batch-inference D20, task 3.4) — pure.
 *
 * `Σ input_estimate × batch_in + Σ output_cap × batch_out`, where `input_estimate`
 * is the routing-grade `chars/4` estimate (an ESTIMATE, not a bound: dense text can
 * exceed it) and `output_cap` is the item's own `max_tokens`, else the model's
 * catalog `max_output_tokens`. Output cannot overshoot the cap; input overshoot is
 * bounded by the estimate's error. When no finite ceiling exists — an item with no
 * cap anywhere, or an unknown batch rate — the result says so, and the caller
 * refuses under a `block` budget (`batch_unbounded`) rather than admitting an
 * unbounded job.
 */

export interface CeilingItem {
  /** The wire body's serialized length — `chars/4` is the estimate. */
  readonly chars: number;
  /** The item's own output cap, when the request carries one. */
  readonly maxOutputTokens: number | null;
}

export interface BatchRate {
  /** USD per 1M tokens — the batch-tier pair. */
  readonly inputPricePer1m: number;
  readonly outputPricePer1m: number;
}

export type Ceiling =
  | { readonly kind: 'bounded'; readonly micros: number; readonly estimatedInputTokens: number }
  | {
      readonly kind: 'unbounded';
      readonly reason: 'unknown_rate' | 'no_output_cap';
      readonly estimatedInputTokens: number;
    };

export function estimateInputTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

export function computeCeiling(
  items: readonly CeilingItem[],
  rate: BatchRate | null,
  catalogMaxOutputTokens: number | null,
): Ceiling {
  let inputTokens = 0;
  let outputTokens = 0;
  let uncapped = false;
  for (const item of items) {
    inputTokens += estimateInputTokens(item.chars);
    const cap = item.maxOutputTokens ?? catalogMaxOutputTokens;
    if (cap === null || !Number.isFinite(cap) || cap <= 0) uncapped = true;
    else outputTokens += cap;
  }
  if (rate === null) {
    return { kind: 'unbounded', reason: 'unknown_rate', estimatedInputTokens: inputTokens };
  }
  if (uncapped) {
    return { kind: 'unbounded', reason: 'no_output_cap', estimatedInputTokens: inputTokens };
  }
  // USD/1M × tokens = µ$ exactly (the 1e6 factors cancel); round UP so the
  // reservation never understates.
  const micros = Math.ceil(
    inputTokens * rate.inputPricePer1m + outputTokens * rate.outputPricePer1m,
  );
  return { kind: 'bounded', micros, estimatedInputTokens: inputTokens };
}
