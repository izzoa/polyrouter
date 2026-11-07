// add-subscription-quota-display task 6.1: `buildBundle` gives `onPlanUsage` only to a member whose
// row yields a usage dialect, and the callback carries the generation read BEFORE the row load.
// ProxyService is built bare (its constructor is not widened; the inference-proxy e2e hand-wires
// it), with only the collaborators `buildBundle` reads.
import {
  CircuitBreaker,
  InMemoryPlanUsageStore,
  PlanUsageRecorder,
  type ChainAttempt,
  type PlanUsageObservation,
  type RouteDecision,
} from '@polyrouter/data-plane';
import type { ModelRow, ProviderRow, Principal } from '@polyrouter/shared/server';
import {
  CHATGPT_PRESET,
  CLAUDE_PRESET,
  OAUTH_PRESETS,
  type OauthPreset,
} from '../subscription-oauth/presets';
import { SubscriptionOauthService } from '../subscription-oauth/subscription-oauth.service';
import { KIMI_CODE_PRESET, OPENCODE_GO_PRESET } from '../subscription-presets/key-presets';
import { ProxyService } from './proxy.service';

const principal = {} as Principal;

const oauth = Object.create(SubscriptionOauthService.prototype) as SubscriptionOauthService;
(oauth as unknown as { presets: unknown }).presets = {
  find: (id: string): OauthPreset | undefined => OAUTH_PRESETS.find((p) => p.id === id),
  list: (): readonly OauthPreset[] => OAUTH_PRESETS,
};

function row(id: string, over: Partial<ProviderRow>): ProviderRow {
  return {
    id,
    name: id,
    kind: 'api_key',
    protocol: 'openai_compatible',
    baseUrl: 'https://api.example.test/v1',
    oauthPreset: null,
    keyPreset: null,
    firstByteTimeoutMs: null,
    idleTimeoutMs: null,
    ...over,
  } as ProviderRow;
}

const claudeRow = row('claude', {
  kind: 'subscription',
  baseUrl: CLAUDE_PRESET.baseUrl,
  protocol: CLAUDE_PRESET.protocol,
  oauthPreset: CLAUDE_PRESET.id,
});
const chatgptRow = row('chatgpt', {
  kind: 'subscription',
  baseUrl: CHATGPT_PRESET.baseUrl,
  protocol: CHATGPT_PRESET.protocol,
  oauthPreset: CHATGPT_PRESET.id,
});
const goRegion = OPENCODE_GO_PRESET.regions[0]!;
const goRow = row('go', {
  kind: 'subscription',
  baseUrl: goRegion.baseUrl,
  protocol: goRegion.protocol,
  keyPreset: OPENCODE_GO_PRESET.id,
});
const kimiRegion = KIMI_CODE_PRESET.regions[0]!;
// Kimi declares a usage ENDPOINT but no passive dialect: never a callback.
const kimiRow = row('kimi', {
  kind: 'subscription',
  baseUrl: kimiRegion.baseUrl,
  protocol: kimiRegion.protocol,
  keyPreset: KIMI_CODE_PRESET.id,
});
const plainRow = row('plain', {});
const driftedClaude = row('drifted', {
  kind: 'subscription',
  baseUrl: 'https://proxy.example.test/',
  protocol: CLAUDE_PRESET.protocol,
  oauthPreset: CLAUDE_PRESET.id,
});

const ROWS = [claudeRow, chatgptRow, goRow, kimiRow, plainRow, driftedClaude];

function decisionOf(ids: readonly string[]): RouteDecision {
  const chain = ids.map((providerId) => ({
    providerId,
    modelId: `m-${providerId}`,
    externalModelId: `ext-${providerId}`,
  }));
  return {
    providerId: chain[0]!.providerId,
    modelId: chain[0]!.modelId,
    externalModelId: chain[0]!.externalModelId,
    tierKey: null,
    decisionLayer: 'explicit',
    routingReason: 'test',
    matchedHeader: null,
    chain,
  } as unknown as RouteDecision;
}

const modelsOf = (ids: readonly string[]): ModelRow[] =>
  ids.map((id) => ({
    id: `m-${id}`,
    externalModelId: `ext-${id}`,
    inputPricePer1m: null,
    outputPricePer1m: null,
    isFree: false,
    listedInputPricePer1m: null,
    listedOutputPricePer1m: null,
    listedIsFree: null,
  })) as unknown as ModelRow[];

type BuildBundle = (
  principal: Principal,
  decision: RouteDecision,
  models: ModelRow[],
  signal: AbortSignal,
  capsRef: { current: ReadonlyMap<string, unknown> },
) => Promise<{ attempts: ChainAttempt[] }>;

function makeProxy(
  breaker: CircuitBreaker,
  findById: (p: Principal, id: string) => Promise<ProviderRow | null>,
): BuildBundle {
  const svc = Object.create(ProxyService.prototype) as ProxyService;
  Object.assign(svc, {
    db: { providers: { findById } },
    breaker,
    oauth,
    rt: { firstByteTimeoutMs: 1000, idleTimeoutMs: 1000, firstEventTimeoutMs: 2000 },
  });
  return (svc as unknown as { buildBundle: BuildBundle }).buildBundle.bind(svc);
}

const OBS: PlanUsageObservation = { windows: [], billing: 'plan' };

describe('ProxyService.buildBundle plan-usage callback (task 6.1)', () => {
  it('gives onPlanUsage only to rows whose gate yields a dialect', async () => {
    const breaker = new CircuitBreaker({} as never);
    const build = makeProxy(breaker, (_p, id) =>
      Promise.resolve(ROWS.find((r) => r.id === id) ?? null),
    );
    const ids = ROWS.map((r) => r.id);
    const { attempts } = await build(
      principal,
      decisionOf(ids),
      modelsOf(ids),
      new AbortController().signal,
      { current: new Map() },
    );
    const has = (id: string): boolean =>
      attempts.find((a) => a.providerId === id)?.onPlanUsage !== undefined;
    expect(has('claude')).toBe(true);
    expect(has('chatgpt')).toBe(true);
    expect(has('go')).toBe(true);
    expect(has('kimi')).toBe(false);
    expect(has('plain')).toBe(false);
    expect(has('drifted')).toBe(false);
  });

  it('carries the generation read before the row load, not one that changed during it', async () => {
    const recorder = new PlanUsageRecorder(new InMemoryPlanUsageStore());
    const breaker = new CircuitBreaker({} as never, { planUsage: recorder });
    const offered: number[] = [];
    jest.spyOn(recorder, 'offer').mockImplementation((_id, _obs, gen) => {
      offered.push(gen);
    });
    recorder.noteCleared('claude', 3);
    // A clear lands while the row is loading: the generation moves 3 -> 9 between the read and
    // the load. The attempt must keep the EARLIER value.
    const build = makeProxy(breaker, (_p, id) => {
      recorder.noteCleared('claude', 9);
      return Promise.resolve(ROWS.find((r) => r.id === id) ?? null);
    });
    const { attempts } = await build(
      principal,
      decisionOf(['claude']),
      modelsOf(['claude']),
      new AbortController().signal,
      { current: new Map() },
    );
    attempts[0]!.onPlanUsage!(OBS);
    expect(recorder.generationOf('claude')).toBe(9);
    expect(offered).toEqual([3]);
  });
});
