import { InMemoryPlanUsageStore, PlanUsageRecorder } from '@polyrouter/data-plane';
import type { PlanUsageObservation } from '@polyrouter/data-plane';
import { planUsageHook, recorderSink, type PlanUsageSink } from './plan-usage-hook';

const OBS: PlanUsageObservation = { windows: [], billing: 'plan' };

describe('planUsageHook (task 6.1)', () => {
  it('forwards the observation with the generation it was built with', () => {
    const calls: Array<[string, PlanUsageObservation, number]> = [];
    const sink: PlanUsageSink = {
      observePlanUsage: (id, obs, gen) => void calls.push([id, obs, gen]),
    };
    planUsageHook(sink, 'p1', 7)(OBS);
    expect(calls).toEqual([['p1', OBS, 7]]);
  });

  it('carries the generation read BEFORE a later change, not the current one', () => {
    // A recorder whose cached generation moves between the read and the (late) callback.
    const recorder = new PlanUsageRecorder(new InMemoryPlanUsageStore());
    const offered: number[] = [];
    const spy = jest.spyOn(recorder, 'offer').mockImplementation((_id, _obs, gen) => {
      offered.push(gen);
    });
    const before = recorder.generationOf('p1'); // read before the row load
    recorder.noteCleared('p1', 5); // a clear lands while the row loads / the call runs
    const hook = planUsageHook(recorderSink(recorder), 'p1', before);
    hook(OBS);
    expect(before).toBe(0);
    expect(recorder.generationOf('p1')).toBe(5);
    expect(offered).toEqual([0]);
    spy.mockRestore();
  });

  it('never throws, even when the sink does', () => {
    const sink: PlanUsageSink = {
      observePlanUsage: () => {
        throw new Error('boom');
      },
    };
    expect(() => planUsageHook(sink, 'p1', 0)(OBS)).not.toThrow();
  });
});
