/**
 * No-queue admission semaphore (add-semantic-embedder D6, clink r1 High-3).
 * `tryAcquire` never waits: at saturation the caller is rejected IMMEDIATELY
 * (fail-open — the request proceeds without the layer). The returned release
 * is idempotent and must be tied to the RAW inference settling, not to the
 * caller's timeout — ORT cannot hard-cancel a running CPU inference, so
 * permits-held-until-settle is what bounds orphaned native work.
 */
export class TrySemaphore {
  private inFlight = 0;

  constructor(private readonly width: number) {
    if (!Number.isInteger(width) || width < 1) {
      throw new Error('TrySemaphore width must be a positive integer');
    }
  }

  get saturated(): boolean {
    return this.inFlight >= this.width;
  }

  /** Returns an idempotent release, or null when saturated (no queue, ever). */
  tryAcquire(): (() => void) | null {
    if (this.inFlight >= this.width) return null;
    this.inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
    };
  }
}
