import type { Admission } from './semaphore';

/**
 * Read-only activity observation over ONE loaded model
 * (recover-semantic-centroid-build).
 *
 * Recovery needs two facts the gate does not otherwise expose, and both are
 * easy to get subtly wrong:
 *
 *  - **Is any inference running?** NOT the same question as `saturated`: at a
 *    width above one an unsaturated gate can still hold in-flight work, so a
 *    consumer asking the first must never be handed the second.
 *  - **When was a REQUEST-PATH embed last attempted?** Attempts REFUSED for
 *    saturation count. A refused request is evidence of traffic — it is
 *    precisely the collision a background rebuild must notice — so counting
 *    only admissions would read a busy instance as quiet.
 *
 * It wraps `tryAcquire()` and the release it RETURNS, never `Embedder.embed()`.
 * That distinction is load-bearing: `embed-core` ties the release to RAW
 * settlement, so a caller that timed out or aborted leaves the permit held
 * while native work continues. A wrapper around `embed()` sees the caller's
 * promise, which settles early, and would report the model idle mid-inference.
 *
 * Purely observational: admission decisions, ordering, width and permit
 * lifetime are the wrapped gate's, unchanged.
 */
export interface ModelActivity {
  /** True while at least one native inference is outstanding (any path). */
  readonly inferenceInFlight: boolean;
  /** Epoch ms of the last request-path embed ATTEMPT, admitted or refused. */
  readonly lastRequestAttemptAt: number | null;
  /** True when nothing is in flight and no request-path attempt within `quietMs`. */
  isQuiet(quietMs: number, now?: number): boolean;
}

/** Which consumer an admission is for. Only `request` marks traffic. */
export type EmbedPath = 'request' | 'boot';

export interface ObservedAdmission extends Admission {
  readonly activity: ModelActivity;
}

/**
 * Wrap a gate so admissions are attributed and raw lifetime is observed. ONE
 * tracker per loaded model — created outside the per-seam factory, so every
 * seam over that model shares it, exactly as they share the gate itself.
 */
export function observeAdmission(inner: Admission): {
  readonly activity: ModelActivity;
  /** A gate view for `path`; all views share the tracker and the inner gate. */
  forPath(path: EmbedPath): Admission;
} {
  let outstanding = 0;
  let lastRequestAttemptAt: number | null = null;

  const activity: ModelActivity = {
    get inferenceInFlight(): boolean {
      return outstanding > 0;
    },
    get lastRequestAttemptAt(): number | null {
      return lastRequestAttemptAt;
    },
    isQuiet(quietMs: number, now = Date.now()): boolean {
      if (outstanding > 0) return false;
      if (lastRequestAttemptAt === null) return true;
      return now - lastRequestAttemptAt >= quietMs;
    },
  };

  const forPath = (path: EmbedPath): Admission => ({
    get saturated(): boolean {
      return inner.saturated;
    },
    get width(): number {
      return inner.width;
    },
    tryAcquire(): (() => void) | null {
      // Stamp BEFORE delegating: a refusal must still register as traffic.
      if (path === 'request') lastRequestAttemptAt = Date.now();
      const release = inner.tryAcquire();
      if (release === null) return null;
      outstanding += 1;
      // Idempotent, mirroring the inner release's own contract — the pipeline
      // may invoke it from both the settle and the error path.
      let counted = true;
      return () => {
        if (counted) {
          counted = false;
          outstanding -= 1;
        }
        release();
      };
    },
  });

  return { activity, forPath };
}
