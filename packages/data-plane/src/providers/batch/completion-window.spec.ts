/**
 * One completion window, referenced by every adapter and by the dashboard's help
 * text (add-batch-mode-help task 2.4).
 *
 * The adapters each declared their own `86_400_000`. That is fine while they agree —
 * and silently wrong the moment one does not, because the interface states a single
 * figure. Binding them to `BATCH_COMPLETION_WINDOW_MS` makes the disagreement
 * unrepresentable: a provider that needs a different window has to introduce a
 * per-provider one deliberately, and this test fails until the interface stops
 * claiming a single number.
 *
 * The test lives HERE rather than in the frontend because `@polyrouter/frontend`
 * depends on `@polyrouter/shared` and not on `@polyrouter/data-plane` — a frontend
 * test could not reach these adapters without breaking the workspace boundary.
 */
import { BATCH_COMPLETION_WINDOW_MS, BATCH_COMPLETION_WINDOW_TEXT } from '@polyrouter/shared';
import { createAnthropicBatchAdapter } from './anthropic-batch';
import { createOpenAiBatchAdapter } from './openai-batch';
import { createOpenRouterBatchAdapter } from './openrouter-batch';
import type { BatchTransport } from './transport';

/** Enough transport to construct an adapter — the factories derive their URLs from
 * `baseUrl`, and `limits` is all this test reads. No call is ever made. */
const transportFor = (baseUrl: string): BatchTransport =>
  ({
    baseUrl,
    protocol: 'openai_compatible',
    translate: {} as never,
    httpClient: {} as never,
    headers: () => ({}),
    credential: 'k',
    firstByteTimeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    maxResponseBytes: 1_024,
  }) as unknown as BatchTransport;

describe('the batch completion window is declared once', () => {
  const adapters = [
    ['openrouter', createOpenRouterBatchAdapter, 'https://openrouter.ai/api/v1'],
    ['anthropic', createAnthropicBatchAdapter, 'https://api.anthropic.com'],
    ['openai', createOpenAiBatchAdapter, 'https://api.openai.com/v1'],
  ] as const;

  it.each(adapters)('%s reports the shared window', (_name, make, baseUrl) => {
    expect(make(transportFor(baseUrl)).limits.completionWindowMs).toBe(BATCH_COMPLETION_WINDOW_MS);
  });

  it('states that window in the words the interface uses', () => {
    // The text and the number sit together in `@polyrouter/shared` so a change to one
    // is a visible change to the other; this pins that they still agree.
    expect(BATCH_COMPLETION_WINDOW_TEXT).toBe(
      `${String(BATCH_COMPLETION_WINDOW_MS / 3_600_000)} hours`,
    );
  });
});
