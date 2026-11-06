import { createMemo } from 'solid-js';

/** Where a surface's figures are in their load (adopt-figure-states design D5):
 * - `loading`: no figure to show yet, so each slot holds a skeleton. That is the first load,
 *   and a Retry's reload of figures a failure removed;
 * - `failed`: the failure notice stands, and the figures it would have supplied are removed,
 *   with no skeleton left pulsing;
 * - `ready`: the figures are current. A refetch keeps them until its own figures commit. */
export type FigureLoad = 'loading' | 'failed' | 'ready';

/**
 * A surface's figure load, read from its store slice.
 *
 * The store keeps its last figures when a read fails, but a failed read's figures are removed,
 * never shown stale as current. So the figures are withdrawn from the first failed read until a
 * read settles cleanly, and a reload in flight keeps them withdrawn, whether it is a
 * background poll or the Retry's own load. While withdrawn they are `failed` as long as the
 * page's failure notice stands, and `loading` once its Retry has released it.
 *
 * Background quiet (a hidden tab, an idle poll, a stream that is not connected) sets no error,
 * so it never withdraws a figure.
 */
export function createFigureLoad(src: {
  /** The read's error: non-null after a failed read, cleared when the next read starts. */
  error: () => string | null;
  /** A read of this slice is in flight. */
  loading: () => boolean;
  /** The slice holds figures from a read. */
  loaded: () => boolean;
  /** The page's failure notice is shown (held across a reload; released by its Retry). */
  failureShown: () => boolean;
}): () => FigureLoad {
  const withdrawn = createMemo<boolean>((was) => {
    if (src.error() !== null) return true;
    return src.loading() ? was : false;
  }, false);
  return () => {
    if (withdrawn()) return src.failureShown() ? 'failed' : 'loading';
    return src.loaded() ? 'ready' : 'loading';
  };
}
