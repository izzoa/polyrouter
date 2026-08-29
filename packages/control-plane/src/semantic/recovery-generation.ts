/**
 * Bounded out-of-band recovery for one failed centroid source
 * (recover-semantic-centroid-build).
 *
 * The vocabulary is load-bearing, because conflating two of these terms
 * produced a contradiction that survived two drafts:
 *
 *  - **slot** — a scheduled opportunity at a fixed offset from the failure.
 *    Three of them. A slot CLOSES when its time comes, whether or not it ran.
 *  - **execution** — a rebuild that actually started. A slot that could not
 *    start, or that abandoned, closes as NO failed execution.
 *  - **generation** — the whole recovery for one source, LATCHED: success, a
 *    terminal fault, the final slot settling, or shutdown ends it for good.
 *
 * Why slots rather than an attempt counter: "a deferral consumes no attempt"
 * and "the third attempt still runs" cannot both hold with one counter — if a
 * deferral does not advance it, the third is unreachable. Wall-clock slots
 * advance regardless, so the final one is always reached.
 *
 * The first two slots are quiet-gated (they must not stutter live traffic on a
 * runtime whose inference blocks the event loop); the LAST runs regardless,
 * which is what converts "may never recover" into "recovers at a bounded
 * cost". A final slot is never closed by contention — it stays PENDING behind
 * any active execution, its own source's or its sibling's, because deadlines
 * coalesce (a clock jump, a suspended host, a long event-loop block) and
 * losing the last chance is the one outcome the design exists to prevent.
 */

/** How a slot ended. All four are distinguishable in the log on purpose. */
export type SlotOutcome = 'closed-unrun' | 'ran-abandoned' | 'ran-failed' | 'succeeded';

/** Why a generation ended. */
export type GenerationEnd = 'succeeded' | 'terminal' | 'exhausted' | 'shutdown';

export interface RecoveryDeps {
  /** May a quiet-gated slot start now? (the final slot does not ask) */
  readonly isQuiet: () => boolean;
  /** Acquire the cross-source rebuild lease, or null when held. */
  readonly acquireLease: () => (() => void) | null;
  /**
   * Run one rebuild. Resolves on success; rejects with a classified fault.
   * `final` tells the caller whether this is the unconditional slot: only a
   * GATED slot abandons when traffic resumes — abandoning the final one
   * would restore the liveness defect it exists to remove.
   */
  readonly execute: (ctx: { readonly final: boolean }) => Promise<void>;
  /** Classify a rejection from `execute`. */
  readonly classify: (err: unknown) => 'retryable' | 'terminal' | 'abandoned';
  readonly onSlot: (index: number, outcome: SlotOutcome, err?: unknown) => void;
  readonly onEnd: (end: GenerationEnd) => void;
  /** Injectable for tests; defaults to real timers. */
  readonly setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  readonly clearTimer?: (t: NodeJS.Timeout) => void;
}

/** ABSOLUTE offsets from the failure — not chained delays. Read as cumulative
 * the same numbers give a 21-minute horizon; an earlier draft used both. */
export const SLOT_OFFSETS_MS: readonly number[] = [60_000, 300_000, 900_000];

export class RecoveryGeneration {
  private timers: NodeJS.Timeout[] = [];
  private closed = false;
  /** A final slot that came due while something was executing. */
  private finalPending = false;
  private executing = false;

  constructor(
    private readonly source: string,
    private readonly deps: RecoveryDeps,
  ) {}

  /** Schedule every slot at its absolute offset. Idempotent per generation. */
  arm(): void {
    if (this.closed || this.timers.length > 0) return;
    const set = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    SLOT_OFFSETS_MS.forEach((offset, index) => {
      const t = set(() => {
        void this.fire(index);
      }, offset);
      t.unref?.();
      this.timers.push(t);
    });
  }

  /** End the generation now; no slot may start afterwards. */
  close(end: GenerationEnd): void {
    if (this.closed) return;
    this.closed = true;
    this.finalPending = false;
    const clear = this.deps.clearTimer ?? ((t: NodeJS.Timeout) => clearTimeout(t));
    for (const t of this.timers) clear(t);
    this.timers = [];
    this.deps.onEnd(end);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private get isFinal(): (index: number) => boolean {
    return (index) => index === SLOT_OFFSETS_MS.length - 1;
  }

  private async fire(index: number): Promise<void> {
    if (this.closed) return;
    const final = this.isFinal(index);

    // A non-final slot needs quiet AND the lease; a final slot needs only the
    // lease, and WAITS for it rather than giving up its one unconditional run.
    if (!final && !this.deps.isQuiet()) {
      this.deps.onSlot(index, 'closed-unrun');
      this.closeIfLast(index);
      return;
    }
    if (this.executing) {
      if (final) {
        this.finalPending = true; // retained; runs when the current one settles
        return;
      }
      this.deps.onSlot(index, 'closed-unrun');
      this.closeIfLast(index);
      return;
    }
    const release = this.deps.acquireLease();
    if (release === null) {
      if (final) {
        this.finalPending = true;
        return;
      }
      this.deps.onSlot(index, 'closed-unrun');
      this.closeIfLast(index);
      return;
    }

    this.executing = true;
    try {
      await this.deps.execute({ final });
      this.deps.onSlot(index, 'succeeded');
      this.close('succeeded');
    } catch (err) {
      const cls = this.deps.classify(err);
      if (cls === 'terminal') {
        this.deps.onSlot(index, 'ran-failed', err);
        this.close('terminal');
        return;
      }
      this.deps.onSlot(index, cls === 'abandoned' ? 'ran-abandoned' : 'ran-failed', err);
      this.closeIfLast(index);
    } finally {
      this.executing = false;
      release();
      // A final slot that came due while this one ran takes its turn now.
      if (!this.closed && this.finalPending) {
        this.finalPending = false;
        void this.fire(SLOT_OFFSETS_MS.length - 1);
      }
    }
  }

  /** The last slot settling ends the generation; earlier ones leave it open. */
  private closeIfLast(index: number): void {
    if (this.isFinal(index) && !this.finalPending) this.close('exhausted');
  }

  /** For diagnostics/logging only. */
  get sourceName(): string {
    return this.source;
  }
}

/** One rebuild at a time across BOTH sources: they share an admission gate and
 * an event loop, so concurrent chains would contend with each other. */
export class RebuildLease {
  private held = false;

  acquire(): (() => void) | null {
    if (this.held) return null;
    this.held = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held = false;
    };
  }
}
