import { Inject, Injectable, type BeforeApplicationShutdown } from '@nestjs/common';
import { PROXY_RUNTIME, type ProxyRuntime } from './proxy.config';

/**
 * Graceful drain of in-flight streams (invariant 12, spec §3.2.5). Runs in
 * `beforeApplicationShutdown` — BEFORE Nest disposes the HTTP server (whose
 * `server.close()` itself waits on open connections) — so it can let active
 * streams finish, then abort any stragglers at the deadline so disposal can't
 * hang. New inference is refused (`isDraining`) once shutdown begins.
 */
@Injectable()
export class StreamDrainRegistry implements BeforeApplicationShutdown {
  private readonly active = new Set<AbortController>();
  private draining = false;
  private readonly deadlineMs: number;

  constructor(@Inject(PROXY_RUNTIME) runtime: ProxyRuntime) {
    this.deadlineMs = runtime.streamDrainDeadlineMs;
  }

  isDraining(): boolean {
    return this.draining;
  }

  register(controller: AbortController): void {
    this.active.add(controller);
  }

  deregister(controller: AbortController): void {
    this.active.delete(controller);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.draining = true;
    const start = Date.now();
    while (this.active.size > 0 && Date.now() - start < this.deadlineMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Abort any stream still open at the deadline so HTTP disposal can proceed.
    for (const controller of this.active) controller.abort();
  }
}
