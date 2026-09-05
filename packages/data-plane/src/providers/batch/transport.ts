import type { UpstreamProtocolAdapter } from '../../proxy/translate';
import type { ProviderProtocol } from '../adapter';
import type { HttpClient } from '../http';
import type { BatchAdapter } from '../batch';

/**
 * What a batch implementation borrows from the HTTP provider adapter it is
 * attached to (add-batch-inference D4): the SAME guarded client, the SAME
 * headers (auth, attribution, extra), the SAME translate seam and bounds — so a
 * batch call can never authenticate, address, or serialize differently from the
 * synchronous call next to it. Built inside `createHttpProviderAdapter`; never
 * constructed by hand.
 */
export interface BatchTransport {
  readonly baseUrl: string;
  readonly protocol: ProviderProtocol;
  readonly translate: UpstreamProtocolAdapter;
  readonly httpClient: HttpClient;
  /** Auth + attribution + extra headers; `json` adds the JSON content type. */
  headers(json: boolean): Record<string, string>;
  /** The outbound credential, for error-message scrubbing only. */
  readonly credential: string;
  readonly firstByteTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly maxResponseBytes: number;
}

/** A batch implementation for one upstream family, chosen by the factory. */
export type BatchFactory = (transport: BatchTransport) => BatchAdapter;
