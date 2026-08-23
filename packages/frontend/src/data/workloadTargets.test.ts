import { describe, expect, it } from 'vitest';
import type { Model } from '../types';
import type { AutoPerformance, RuleDto } from './api';
import {
  WORKLOAD_ROW_ORDER,
  isReservedWorkload,
  unsetCopy,
  workloadVms,
  type WorkloadTargetsInput,
} from './workloadTargets';
import { DEFAULT_AUTO_PERF } from '../test/fakeClient';

const T0 = '2026-07-01T00:00:00.000Z';
const T1 = '2026-07-02T00:00:00.000Z';
const RANGE = '7d' as const;

function rule(over: Partial<RuleDto>): RuleDto {
  return {
    id: 'r1',
    matchType: 'auto_workload',
    workloadClass: 'code',
    headerName: 'x-polyrouter-tier',
    headerValue: null,
    target: 'tier:coding',
    priority: 0,
    createdAt: T0,
    ...over,
  };
}

function model(id: string, over: Partial<Model> = {}): Model {
  return {
    id,
    providerId: 'p1',
    externalModelId: `ext-${id}`,
    displayName: null,
    contextWindow: null,
    supportsTools: false,
    supportsVision: false,
    supportsReasoning: false,
    isFree: false,
    inputPricePer1m: 1,
    outputPricePer1m: 2,
    effectivePrice: {
      inputPricePer1m: 1,
      outputPricePer1m: 2,
      isFree: false,
      source: 'model',
      estimated: false,
    },
    listedPrice: null,
    lastSyncedAt: null,
    ...over,
  };
}

function input(over: Partial<WorkloadTargetsInput> = {}): WorkloadTargetsInput {
  return {
    rules: [],
    tiers: [
      { id: 't-coding', key: 'coding', displayName: null, description: null, createdAt: T0 },
      { id: 't-empty', key: 'empty', displayName: null, description: null, createdAt: T0 },
      { id: 't-default', key: 'default', displayName: null, description: null, createdAt: T0 },
    ],
    tierEntries: {
      't-coding': [
        { id: 'e1', tierId: 't-coding', modelId: 'm1', position: 0, model: null },
        { id: 'e2', tierId: 't-coding', modelId: 'm2', position: 1, model: null },
      ],
      't-empty': [],
      't-default': [{ id: 'e3', tierId: 't-default', modelId: 'm2', position: 0, model: null }],
    },
    models: [model('m1', { displayName: 'Coder' }), model('m2')],
    providers: [{ id: 'p1', name: 'OpenAI' } as never],
    autoPerf: { data: null, range: RANGE },
    ...over,
  };
}

function perf(classes: AutoPerformance['workloadMix']['classes']): AutoPerformance {
  return { ...DEFAULT_AUTO_PERF, workloadMix: { ...DEFAULT_AUTO_PERF.workloadMix, classes } };
}

const cls = (c: string, requests: number, routed: number) => ({
  class: c,
  requests,
  unpricedRequests: 0,
  unpricedAttempts: 0,
  spendUsd: 0,
  routed,
});

describe('workloadVms (add-workload-routing D6)', () => {
  it('renders one row per taxonomy class, live classes first, reserved flagged', () => {
    const vm = workloadVms(input());
    expect(vm.rows.map((r) => r.cls)).toEqual([...WORKLOAD_ROW_ORDER]);
    expect(vm.rows.map((r) => r.cls)).toEqual([
      'code',
      'vision',
      'structured',
      'research',
      'writing',
    ]);
    expect(vm.rows.map((r) => r.reserved)).toEqual([false, false, false, true, true]);
    expect(isReservedWorkload('research')).toBe(true);
    expect(isReservedWorkload('code')).toBe(false);
    for (const r of vm.rows) {
      expect(r.effective).toBeNull();
      expect(r.target).toEqual({ kind: 'unset' });
      expect(r.usable).toBe(false);
      expect(r.routed).toBeNull(); // auto data not loaded yet
    }
    expect(vm.anyUsable).toBe(false);
    expect(vm.routedTotal).toBe(0);
  });

  it('picks the effective rule per class by the proxy order and lists the rest as shadowed; other classes/types ignored', () => {
    const vm = workloadVms(
      input({
        rules: [
          rule({ id: 'old', priority: 0, createdAt: T0 }),
          rule({ id: 'prio', priority: 5, createdAt: T1, target: `model:m1` }),
          rule({ id: 'newer', priority: 0, createdAt: T1 }),
          rule({ id: 'vis', workloadClass: 'vision', target: 'tier:empty' }),
          rule({ id: 'band', matchType: 'auto_high', workloadClass: null, target: 'tier:coding' }),
        ],
      }),
    );
    const code = vm.rows.find((r) => r.cls === 'code')!;
    expect(code.effective?.id).toBe('prio');
    expect(code.shadowed.map((r) => r.id)).toEqual(['old', 'newer']);
    expect(code.target).toMatchObject({ kind: 'model', label: 'Coder', provider: 'OpenAI' });
    expect(code.usable).toBe(true);
    const vision = vm.rows.find((r) => r.cls === 'vision')!;
    expect(vision.effective?.id).toBe('vis');
    expect(vision.target).toMatchObject({ kind: 'tier', key: 'empty', empty: true, primary: null });
    expect(vision.usable).toBe(false); // an empty tier steers nothing
    expect(vm.rows.find((r) => r.cls === 'structured')!.effective).toBeNull();
    expect(vm.anyUsable).toBe(true);
  });

  it('resolves tier targets with primary + fallbacks, and flags unresolved tier/model/malformed literals', () => {
    const vm = workloadVms(
      input({
        rules: [
          rule({ id: 'c', workloadClass: 'code', target: 'tier:coding' }),
          rule({ id: 'v', workloadClass: 'vision', target: 'tier:ghost' }),
          rule({ id: 's', workloadClass: 'structured', target: 'model:nope' }),
          rule({ id: 'r', workloadClass: 'research', target: 'garbage' }),
        ],
      }),
    );
    const by = (c: string) => vm.rows.find((r) => r.cls === c)!;
    expect(by('code').target).toEqual({
      kind: 'tier',
      key: 'coding',
      isDefault: false,
      primary: 'Coder',
      fallbacks: 1,
      empty: false,
    });
    expect(by('code').usable).toBe(true);
    expect(by('vision').target).toEqual({
      kind: 'unresolved',
      literal: 'tier:ghost',
      parsed: 'tier',
    });
    expect(by('structured').target).toEqual({
      kind: 'unresolved',
      literal: 'model:nope',
      parsed: 'model',
    });
    expect(by('research').target).toEqual({
      kind: 'unresolved',
      literal: 'garbage',
      parsed: 'malformed',
    });
    // A reserved class with an (API-created) rule is still shown — but never counts as live steering.
    expect(by('research').reserved).toBe(true);
    expect(by('research').usable).toBe(false);
  });

  it('a usable target on a RESERVED class does not make the card "steering" (anyUsable is live-only)', () => {
    const vm = workloadVms(
      input({ rules: [rule({ id: 'r', workloadClass: 'writing', target: 'tier:coding' })] }),
    );
    const writing = vm.rows.find((r) => r.cls === 'writing')!;
    expect(writing.usable).toBe(true);
    expect(vm.anyUsable).toBe(false);
  });

  it('routed/requests come from the Auto-performance workload mix, range-scoped; absent classes read 0', () => {
    const vm = workloadVms(
      input({
        autoPerf: {
          data: perf([cls('code', 12, 7), cls('none', 30, 0), cls('vision', 2, 2)]),
          range: RANGE,
        },
      }),
    );
    const by = (c: string) => vm.rows.find((r) => r.cls === c)!;
    expect(by('code').routed).toEqual({ count: 7, requests: 12, range: RANGE });
    expect(by('vision').routed).toEqual({ count: 2, requests: 2, range: RANGE });
    expect(by('structured').routed).toEqual({ count: 0, requests: 0, range: RANGE });
    expect(by('research').routed).toEqual({ count: 0, requests: 0, range: RANGE });
    expect(vm.routedTotal).toBe(9);
  });

  it('unset copy names the class and its signal, and says what happens to those requests today', () => {
    expect(unsetCopy('code')).toContain('Code requests');
    expect(unsetCopy('code')).toContain('fenced code');
    expect(unsetCopy('code')).toContain('configured code thresholds'); // never a hardcoded default (clink r5 L1)
    expect(unsetCopy('code')).toContain(
      'band targets, then L2 and the cascade where enabled, then default',
    );
    expect(unsetCopy('research')).toContain('not detected yet');
    expect(unsetCopy('research')).toContain('semantic source only');
  });
});
