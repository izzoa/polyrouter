// add-subscription-quota-display task 6.5: a completed OAuth (re)connect discards the row's plan
// usage snapshot and raises its generation; nothing else in the OAuth layer ever does.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import {
  InMemoryPlanUsageStore,
  PlanUsageRecorder,
  type PlanUsageObservation,
  type PlanUsageStore,
} from '@polyrouter/data-plane';
import type { Principal, ProviderRow } from '@polyrouter/shared/server';
import type { Request } from 'express';
import type { Redis } from 'ioredis';
import { planUsageHook, recorderSink } from '../plan-usage/plan-usage-hook';
import { CHATGPT_PRESET, CLAUDE_PRESET, OAUTH_PRESETS, type OauthPreset } from './presets';
import { SubscriptionOauthController } from './subscription-oauth.controller';
import { SubscriptionOauthService } from './subscription-oauth.service';

const principal = { kind: 'user', userId: 'u1' } as unknown as Principal;
const req = { headers: {} } as Request;
const redis = { eval: () => Promise.resolve([1, 60]) } as unknown as Redis;

const real = Object.create(SubscriptionOauthService.prototype) as SubscriptionOauthService;
(real as unknown as { presets: unknown }).presets = {
  find: (id: string): OauthPreset | undefined => OAUTH_PRESETS.find((p) => p.id === id),
  list: (): readonly OauthPreset[] => OAUTH_PRESETS,
};

function oauthRow(preset: OauthPreset, over: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id: 'row-1',
    name: preset.id,
    kind: 'subscription',
    protocol: preset.protocol,
    baseUrl: preset.baseUrl,
    oauthPreset: preset.id,
    keyPreset: null,
    encryptedCredentials: 'x',
    imitateClientIdentity: false,
    createdAt: new Date(),
    ...over,
  } as ProviderRow;
}

const OBS: PlanUsageObservation = { windows: [], billing: 'extra_usage' };
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

function make(row: ProviderRow, store?: PlanUsageStore, recorder?: PlanUsageRecorder) {
  const svc = {
    complete: jest.fn(() => Promise.resolve(row)),
    availableClientIdentity: () => null,
    identityBindingFor: (r: ProviderRow) => real.identityBindingFor(r),
  } as unknown as SubscriptionOauthService;
  return new SubscriptionOauthController(svc, redis, store, recorder);
}

describe('SubscriptionOauthController.complete clears plan usage (task 6.5)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('a reconnect discards the snapshot and raises the generation, keeping the response shape', async () => {
    const store = new InMemoryPlanUsageStore();
    const recorder = new PlanUsageRecorder(store);
    await store.merge('row-1', OBS, 0, 'traffic');
    const out = await make(oauthRow(CLAUDE_PRESET), store, recorder).complete(principal, req, {
      sessionId: 's',
      pasted: 'p',
    });
    expect((await store.readMany(['row-1'])).get('row-1')!.snapshot).toBeNull();
    expect(store.generation('row-1')).toBe(1);
    expect(recorder.generationOf('row-1')).toBe(1);
    // The reply keeps toSafe's nulls: the page reloads its list after a reconnect.
    expect(out.planUsage).toBeNull();
    expect(out.planUsageRefresh).toBeNull();
  });

  it('a buffered Claude call that began before the reconnect records nothing when it completes after', async () => {
    const store = new InMemoryPlanUsageStore();
    const recorder = new PlanUsageRecorder(store);
    const hook = planUsageHook(recorderSink(recorder), 'row-1', recorder.generationOf('row-1'));
    await make(oauthRow(CLAUDE_PRESET), store, recorder).complete(principal, req, {
      sessionId: 's',
      pasted: 'p',
    });
    hook(OBS); // the old call's headers arrive after the reconnect
    await tick();
    expect((await store.readMany(['row-1'])).get('row-1')!.snapshot).toBeNull();
  });

  it('a ChatGPT reconnect clears too', async () => {
    const store = new InMemoryPlanUsageStore();
    await store.merge('row-1', OBS, 0, 'traffic');
    await make(oauthRow(CHATGPT_PRESET), store).complete(principal, req, {
      sessionId: 's',
      pasted: 'p',
    });
    expect((await store.readMany(['row-1'])).get('row-1')!.snapshot).toBeNull();
  });

  it('a clear failure is logged and never fails the reconnect', async () => {
    const store: PlanUsageStore = {
      ...new InMemoryPlanUsageStore(),
      clear: () => Promise.reject(new Error('redis down')),
    } as unknown as PlanUsageStore;
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const out = await make(oauthRow(CLAUDE_PRESET), store).complete(principal, req, {
      sessionId: 's',
      pasted: 'p',
    });
    expect(out.id).toBe('row-1');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('plan usage: clearing'));
  });

  it('a row with no usage source is never cleared, and a missing store is tolerated', async () => {
    const store = new InMemoryPlanUsageStore();
    const clear = jest.spyOn(store, 'clear');
    const drifted = oauthRow(CLAUDE_PRESET, { baseUrl: 'https://proxy.example.test/' });
    await make(drifted, store).complete(principal, req, { sessionId: 's', pasted: 'p' });
    expect(clear).not.toHaveBeenCalled();
    await expect(
      make(oauthRow(CLAUDE_PRESET)).complete(principal, req, { sessionId: 's', pasted: 'p' }),
    ).resolves.toBeDefined();
  });

  it('starting or reauthorizing a connect never clears; only complete does', async () => {
    const store = new InMemoryPlanUsageStore();
    const clear = jest.spyOn(store, 'clear');
    const svc = {
      start: jest.fn(() => Promise.resolve({})),
      startReauthorize: jest.fn(() => Promise.resolve({})),
    } as unknown as SubscriptionOauthService;
    const ctl = new SubscriptionOauthController(svc, redis, store);
    await ctl.start(principal, req, { preset: 'claude' } as never);
    await ctl.reauthorize(principal, req, 'row-1');
    expect(clear).not.toHaveBeenCalled();
  });
});

describe('a token refresh never clears plan usage (structural guard, task 6.5)', () => {
  it('only the controller (the complete path) references the plan-usage store in the OAuth layer', () => {
    const dir = __dirname;
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
      .filter((f) => f !== 'subscription-oauth.controller.ts')
      .filter((f) =>
        /PLAN_USAGE_STORE|PLAN_USAGE_RECORDER|clearPlanUsageSnapshot/.test(
          readFileSync(join(dir, f), 'utf8'),
        ),
      );
    expect(offenders).toEqual([]);
  });
});
