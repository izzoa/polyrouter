import type { Redis } from 'ioredis';
import {
  ADD_PENDING_LUA,
  packVector,
  pendingBucketKey,
  type LearningLabel,
} from '../learning-format';

/**
 * Seed a real Redis pending bucket exactly as the hot-path accumulator's flush
 * does (the shared {@link ADD_PENDING_LUA}). Test-only — production pending writes
 * belong to `EvidenceAccumulator`; this lets the store's real-Redis parity spec
 * populate accumulator-shaped evidence for `rotate` to read.
 */
export async function seedPendingBucket(
  redis: Redis,
  hmac: string,
  epoch: number,
  label: LearningLabel,
  revision: string,
  day: string,
  sum: Float32Array,
  count: number,
  ttlSeconds: number,
): Promise<void> {
  await redis.eval(
    ADD_PENDING_LUA,
    1,
    pendingBucketKey(hmac, epoch, label, revision, day),
    String(count),
    packVector(sum),
    String(sum.length),
    String(ttlSeconds),
  );
}
