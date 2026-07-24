import { userPrincipal } from '@polyrouter/shared/server';
import type { Redis } from 'ioredis';
import { InflightRegistry } from './inflight-registry';

/** A client whose every command REJECTS (Redis down). */
const failingClient = (): Redis =>
  new Proxy(
    { defineCommand: (): void => undefined },
    {
      get: (target: Record<string, unknown>, prop: string) =>
        prop in target ? target[prop] : () => Promise.reject(new Error('redis down')),
    },
  ) as unknown as Redis;

/** A client whose every command NEVER settles (Redis hung). */
const hungClient = (): Redis =>
  new Proxy(
    { defineCommand: (): void => undefined },
    {
      get: (target: Record<string, unknown>, prop: string) =>
        prop in target ? target[prop] : () => new Promise(() => undefined),
    },
  ) as unknown as Redis;

const principal = userPrincipal('u1');
const entry = {
  requestId: 'r1',
  startedAt: Date.now(),
  decisionLayer: 'default',
  tierAssigned: 'default',
  modelLabel: 'gpt-4o',
  providerLabel: 'openai',
  protocol: 'openai',
};

/** add-inflight-requests §2.2: the registry degrades silently — a Redis fault
 * (down OR hung) must never throw into, block, or delay the request path. */
describe('InflightRegistry degradation', () => {
  it('mark/settle never throw and never await when Redis rejects', async () => {
    const reg = new InflightRegistry(failingClient());
    let lease!: ReturnType<InflightRegistry['mark']>;
    expect(() => {
      lease = reg.mark(principal, entry);
    }).not.toThrow();
    expect(() => lease.settle()).not.toThrow();
    await new Promise((r) => setTimeout(r, 20)); // let the rejections land unhandled-free
  });

  it('mark/settle never throw and retain no awaited handle when Redis hangs', () => {
    const reg = new InflightRegistry(hungClient());
    const started = Date.now();
    const lease = reg.mark(principal, entry);
    lease.settle();
    // Both returned synchronously — nothing awaited a never-settling command.
    expect(Date.now() - started).toBeLessThan(50);
  });

  it('list returns an UNAVAILABLE snapshot (not empty-authoritative) when Redis rejects', async () => {
    const reg = new InflightRegistry(failingClient());
    await expect(reg.list(principal)).resolves.toEqual({
      items: [],
      available: false,
      truncated: false,
    });
  });

  it('list returns unavailable WITHOUT blocking when Redis hangs', async () => {
    const reg = new InflightRegistry(hungClient());
    const started = Date.now();
    const snap = await reg.list(principal);
    expect(snap).toEqual({ items: [], available: false, truncated: false });
    // Bounded by the read deadline — never the caller's patience.
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
