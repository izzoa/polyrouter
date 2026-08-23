import { createHash } from 'node:crypto';
import { WORKLOAD_CLASSES } from '@polyrouter/shared';
import { HIGH_ANCHORS, LOW_ANCHORS } from './anchors';
import {
  WORKLOAD_ANCHORS,
  WORKLOAD_ANCHOR_CONTENT_HASH,
  WORKLOAD_ANCHOR_SET_ID,
} from './workload-anchors';

describe('bundled workload anchors (add-semantic-workloads D4)', () => {
  it('covers every taxonomy class with exactly 30 unique anchors each, none shared across classes', () => {
    expect(Object.keys(WORKLOAD_ANCHORS).sort()).toEqual([...WORKLOAD_CLASSES].sort());
    const seen = new Map<string, string>();
    for (const cls of WORKLOAD_CLASSES) {
      const list = WORKLOAD_ANCHORS[cls];
      expect(list).toHaveLength(30);
      expect(new Set(list).size).toBe(30);
      for (const a of list) {
        expect(a.trim().length).toBeGreaterThan(10);
        expect(seen.has(a)).toBe(false); // no anchor belongs to two classes
        seen.set(a, cls);
      }
    }
  });

  it('pins the canonical content hash — an edit must also bump the set id', () => {
    const canonical: Record<string, string[]> = {};
    for (const cls of [...WORKLOAD_CLASSES].sort())
      canonical[cls] = [...WORKLOAD_ANCHORS[cls]].sort();
    const hash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
    expect(hash).toBe(WORKLOAD_ANCHOR_CONTENT_HASH);
    expect(WORKLOAD_ANCHOR_SET_ID).toBe('workload-v1');
  });

  it('does not reuse the Layer-2 band anchors (separate evidence sets)', () => {
    const band = new Set([...HIGH_ANCHORS, ...LOW_ANCHORS]);
    for (const cls of WORKLOAD_CLASSES)
      for (const a of WORKLOAD_ANCHORS[cls]) expect(band.has(a)).toBe(false);
  });
});
