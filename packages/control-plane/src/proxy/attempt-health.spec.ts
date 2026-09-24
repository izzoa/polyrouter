import type { BreakerSettleInfo, ChainAttempt } from '@polyrouter/data-plane';
import type { PersistencePort, Principal, ProviderRow } from '@polyrouter/shared/server';
import {
  attemptHealthHook,
  type AttemptHealthDeps,
  type AttemptHealthState,
} from './attempt-health';

const principal: Principal = { kind: 'user', userId: 'u1' };

const row = (over: Partial<ProviderRow> = {}): ProviderRow =>
  ({
    id: 'p1',
    ownerUserId: 'u1',
    orgId: null,
    name: 'p',
    kind: 'subscription',
    protocol: 'anthropic_compatible',
    baseUrl: 'https://api.example.test',
    encryptedCredentials: 'loaded-cipher',
    status: 'unknown',
    oauthPreset: 'claude',
    credentialError: null,
    statusRev: null,
    trafficState: null,
    trafficRev: null,
    ...over,
  }) as ProviderRow;

function deps(setHealth: jest.Mock = jest.fn().mockResolvedValue(true)): {
  d: AttemptHealthDeps;
  setHealth: jest.Mock;
  refresh: jest.Mock;
} {
  const refresh = jest.fn().mockResolvedValue('refreshed');
  return {
    d: {
      db: { providers: { setHealth } } as unknown as Pick<PersistencePort, 'providers'>,
      oauth: { requestForcedRefresh: refresh },
    },
    setHealth,
    refresh,
  };
}

const settle = (over: Partial<BreakerSettleInfo>): BreakerSettleInfo => ({
  outcome: 'success',
  kind: null,
  justOpened: false,
  applied: true,
  seq: 42,
  ...over,
});

const used = (envelope: string): AttemptHealthState => ({
  used: { envelope, baseUrl: 'https://api.example.test', protocol: 'anthropic_compatible' },
});

describe('attemptHealthHook (add-provider-health-signals)', () => {
  it('a breaker open records traffic failing with its kind and seq, guarded by what the attempt used', () => {
    const { d, setHealth } = deps();
    attemptHealthHook(
      d,
      principal,
      row(),
      used('used-cipher'),
    )(settle({ outcome: 'trip', kind: 'auth', justOpened: true, seq: 7 }));
    expect(setHealth).toHaveBeenCalledWith(
      principal,
      'p1',
      { record: 'traffic', state: 'failing', kind: 'auth', seq: 7 },
      {
        envelope: 'used-cipher',
        baseUrl: 'https://api.example.test',
        protocol: 'anthropic_compatible',
      },
    );
  });

  it('an applied served success on a provider not displayed ok records traffic ok', () => {
    const { d, setHealth } = deps();
    attemptHealthHook(d, principal, row({ status: 'error', statusRev: 1 }), used('c'))(settle({}));
    expect(setHealth).toHaveBeenCalledWith(
      principal,
      'p1',
      { record: 'traffic', state: 'ok', kind: null, seq: 42 },
      expect.objectContaining({ envelope: 'c' }),
    );
  });

  it('writes nothing for a provider already displayed ok, a stale success, a non-served success, or a sub-threshold trip', () => {
    const { d, setHealth } = deps();
    attemptHealthHook(d, principal, row({ status: 'ok', statusRev: 1 }), used('c'))(settle({}));
    const notOk = row({ status: 'error', statusRev: 1 });
    attemptHealthHook(d, principal, notOk, used('c'))(settle({ applied: false }));
    attemptHealthHook(d, principal, notOk, used('c'))(settle({ kind: 'permission' }));
    attemptHealthHook(
      d,
      principal,
      notOk,
      used('c'),
    )(settle({ outcome: 'trip', kind: 'unavailable' }));
    expect(setHealth).not.toHaveBeenCalled();
  });

  it('two members of the SAME provider record against their own envelopes — also after a clamp copy', () => {
    const { d, setHealth } = deps();
    const provider = row({ status: 'error', statusRev: 1 });
    const first: ChainAttempt = {
      providerId: 'p1',
      externalModelId: 'a',
      buildAdapter: () => Promise.reject(new Error('n/a')),
      onSettle: attemptHealthHook(d, principal, provider, used('first-cipher')),
    };
    const second: ChainAttempt = {
      providerId: 'p1',
      externalModelId: 'b',
      buildAdapter: () => Promise.reject(new Error('n/a')),
      onSettle: attemptHealthHook(d, principal, provider, used('second-cipher')),
    };
    // The deliverability reorder/clamp copies attempts with a spread.
    const clamped = [{ ...second, maxOutputTokens: 5 }, { ...first }];
    clamped[0]!.onSettle!(settle({}));
    clamped[1]!.onSettle!(settle({}));
    expect(setHealth.mock.calls.map((c) => (c[3] as { envelope: string }).envelope)).toEqual([
      'second-cipher',
      'first-cipher',
    ]);
  });

  it('an attempt whose build never resolved is guarded by the row the request loaded', () => {
    const { d, setHealth } = deps();
    attemptHealthHook(
      d,
      principal,
      row(),
      {},
    )(settle({ outcome: 'trip', kind: 'unavailable', justOpened: true }));
    expect(setHealth.mock.calls[0]![3]).toMatchObject({ envelope: 'loaded-cipher' });
  });

  it('is synchronous: a write that never resolves does not hold the caller, and a rejected write surfaces nowhere', async () => {
    const pending = jest.fn(() => new Promise<boolean>(() => undefined));
    const { d } = deps(pending);
    const hook = attemptHealthHook(d, principal, row({ status: 'error', statusRev: 1 }), used('c'));
    expect(hook(settle({}))).toBeUndefined(); // returned immediately
    const rejecting = jest.fn().mockRejectedValue(new Error('db down'));
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    attemptHealthHook(
      deps(rejecting).d,
      principal,
      row({ status: 'error', statusRev: 1 }),
      used('c'),
    )(settle({}));
    await new Promise((r) => setImmediate(r));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('a 401 on an OAuth member triggers one forced refresh keyed on the envelope it used', () => {
    const { d, refresh } = deps();
    attemptHealthHook(
      d,
      principal,
      row(),
      used('used-cipher'),
    )(settle({ outcome: 'trip', kind: 'auth' }));
    expect(refresh).toHaveBeenCalledWith(principal, 'p1', 'used-cipher');
  });

  it('no forced refresh for a non-OAuth 401, another kind, or an attempt that never built', () => {
    const { d, refresh } = deps();
    attemptHealthHook(
      d,
      principal,
      row({ oauthPreset: null }),
      used('c'),
    )(settle({ outcome: 'trip', kind: 'auth' }));
    attemptHealthHook(
      d,
      principal,
      row(),
      used('c'),
    )(settle({ outcome: 'trip', kind: 'rate_limit' }));
    attemptHealthHook(d, principal, row(), {})(settle({ outcome: 'trip', kind: 'auth' }));
    expect(refresh).not.toHaveBeenCalled();
  });
});
