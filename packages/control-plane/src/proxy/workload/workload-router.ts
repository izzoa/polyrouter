import { Injectable } from '@nestjs/common';
import {
  resolveWorkloadTarget,
  type RouteDecision,
  type RoutingSnapshot,
  type WorkloadVerdict,
} from '@polyrouter/data-plane';
import { WORKLOAD_NONE } from '@polyrouter/shared/server';

/**
 * The WORKLOAD stage (add-workload-routing D2/D3): a confident workload class
 * with a resolvable `auto_workload` target CLAIMS the request before band
 * resolution, Layer 2, and the cascade. `claim` returns the target's decision
 * (`decision_layer = 'workload'`, the verdict's numbers-only reason) or null
 * for `none`, no rule, or an unresolved/empty target — "unclaimed", which is
 * degrade-safe by contract (never a client-facing error). Injectable like the
 * other routers so a fault can be injected at the seam in e2e; the caller
 * still wraps the call (invariant 1).
 */
@Injectable()
export class WorkloadRouter {
  claim(snapshot: RoutingSnapshot, workload: WorkloadVerdict): RouteDecision | null {
    if (workload.class === WORKLOAD_NONE) return null;
    return resolveWorkloadTarget(snapshot, workload.class, workload.reason);
  }
}
