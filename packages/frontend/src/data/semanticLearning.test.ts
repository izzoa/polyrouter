import { describe, expect, it } from 'vitest';
import type { SemanticLearningEvent, SemanticLearningStatus } from './api';
import { toLearningHistoryRows, toLearningVm } from './semanticLearning';

function status(over: Partial<SemanticLearningStatus> = {}): SemanticLearningStatus {
  return {
    enabled: true,
    available: true,
    epoch: 0,
    generation: 0,
    source: 'bundled',
    freshHigh: 0,
    freshLow: 0,
    lastAppliedAt: null,
    history: [],
    ...over,
  };
}

function event(over: Partial<SemanticLearningEvent> = {}): SemanticLearningEvent {
  return {
    id: 'e1',
    occurrenceId: 'occ:1',
    trigger: 'apply',
    epoch: 0,
    generation: 1,
    highSamples: 5,
    lowSamples: 12,
    highDrift: 0.05,
    lowDrift: 0.03,
    highSimilarity: 0.95,
    lowSimilarity: 0.97,
    reason: 'promoted',
    createdAt: '2026-07-03T00:00:00.000Z',
    ...over,
  };
}

describe('toLearningVm', () => {
  it('returns null when status is absent', () => {
    expect(toLearningVm(null)).toBeNull();
  });

  it('off + never-applied bundled state hides revert', () => {
    const vm = toLearningVm(status({ enabled: false }));
    expect(vm?.enabled).toBe(false);
    expect(vm?.samplesLine).toBe('learning from 0 low · 0 high');
    expect(vm?.sourceLine).toBe('active: bundled anchors');
    expect(vm?.lastAppliedLine).toBe('never applied');
    expect(vm?.showRevert).toBe(false);
    expect(vm?.staleReason).toBeNull();
  });

  it('applied learned state: counts, source, last-applied, revert', () => {
    const vm = toLearningVm(
      status({
        source: 'learned',
        generation: 2,
        freshHigh: 5,
        freshLow: 12,
        lastAppliedAt: '2026-07-03T00:00:00.000Z',
      }),
    );
    expect(vm?.samplesLine).toBe('learning from 12 low · 5 high');
    expect(vm?.sourceLine).toBe('active: learned centroids');
    expect(vm?.lastAppliedLine).toContain('applied');
    expect(vm?.showRevert).toBe(true);
    expect(vm?.staleReason).toBeNull();
  });

  it('stale learned state degrades to bundled WITH a reason, revert still offered', () => {
    // A centroid was promoted (generation > 0) but the active read returned
    // bundled — the embedder/revision moved under it. Never a silent "learned".
    const vm = toLearningVm(status({ source: 'bundled', generation: 2 }));
    expect(vm?.source).toBe('bundled');
    expect(vm?.sourceLine).toBe('active: bundled anchors');
    expect(vm?.staleReason).not.toBeNull();
    expect(vm?.staleReason).toContain('inactive');
    expect(vm?.showRevert).toBe(true);
  });
});

describe('toLearningHistoryRows', () => {
  it('renders numeric drift/sim evidence and per-label samples', () => {
    const [r] = toLearningHistoryRows([event()]);
    expect(r?.trigger).toBe('apply');
    expect(r?.samples).toBe('12 low · 5 high');
    expect(r?.evidence).toBe('drift 0.03/0.05 · sim 0.97/0.95');
    expect(r?.reason).toBe('promoted');
  });

  it('omits absent numeric evidence without fabricating zeros in the label', () => {
    const [r] = toLearningHistoryRows([
      event({
        trigger: 'discard_revision',
        highDrift: null,
        lowDrift: null,
        highSimilarity: null,
        lowSimilarity: null,
        reason: 'stale revision',
      }),
    ]);
    expect(r?.trigger).toBe('discard_revision');
    expect(r?.evidence).toBe('');
    expect(r?.reason).toBe('stale revision');
  });
});
