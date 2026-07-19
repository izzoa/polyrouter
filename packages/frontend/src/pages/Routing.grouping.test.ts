import { describe, expect, it } from 'vitest';
import { groupModelsByProvider } from './Routing';
import type { Model } from '../types';

const model = (id: string, providerId: string, externalModelId: string): Model => ({
  id,
  providerId,
  externalModelId,
  displayName: null,
  contextWindow: null,
  supportsTools: false,
  supportsVision: false,
  supportsReasoning: false,
  isFree: false,
  inputPricePer1m: null,
  outputPricePer1m: null,
  effectivePrice: null,
  lastSyncedAt: null,
});

const providers = [
  { id: 'p-or', name: 'Openrouter' },
  { id: 'p-gpt', name: 'ChatGPT Plus / Pro' },
  { id: 'p-cl', name: 'Claude Pro / Max' },
];

describe('groupModelsByProvider — the add-model dropdown optgroups', () => {
  it('groups by provider (labelled by name), models alphabetical within, groups alphabetical', () => {
    const groups = groupModelsByProvider(
      [
        model('m1', 'p-or', 'x-ai/grok-4.5'),
        model('m2', 'p-gpt', 'gpt-5.4-mini'),
        model('m3', 'p-or', 'anthropic/claude-sonnet-5'),
        model('m4', 'p-cl', 'claude-sonnet-5'),
        model('m5', 'p-gpt', 'gpt-5.6-sol'),
      ],
      providers,
    );
    expect(groups.map((g) => g.label)).toEqual([
      'ChatGPT Plus / Pro',
      'Claude Pro / Max',
      'Openrouter',
    ]);
    expect(groups[2]!.models.map((m) => m.externalModelId)).toEqual([
      'anthropic/claude-sonnet-5',
      'x-ai/grok-4.5',
    ]);
    expect(groups[0]!.models.map((m) => m.externalModelId)).toEqual(['gpt-5.4-mini', 'gpt-5.6-sol']);
  });

  it('a model whose provider is unknown lands in an "Other" group, never dropped', () => {
    const groups = groupModelsByProvider([model('m1', 'p-gone', 'orphan-model')], providers);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe('Other');
    expect(groups[0]!.models[0]!.externalModelId).toBe('orphan-model');
  });

  it('empty input yields no groups (the dropdown shows only the placeholder)', () => {
    expect(groupModelsByProvider([], providers)).toEqual([]);
  });
});
