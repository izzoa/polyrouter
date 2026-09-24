import { Logger } from '@nestjs/common';
import type { PersistencePort, Principal } from '@polyrouter/shared/server';
import {
  displayedProviderHealth,
  isDisplayedOk,
  reauthorizeRequiredCheck,
  recordProviderHealth,
  type HealthRow,
} from './provider-health';

const T1 = new Date('2026-09-24T10:00:00Z');
const T2 = new Date('2026-09-24T11:00:00Z');

const row = (over: Partial<HealthRow> = {}): HealthRow => ({
  status: 'unknown',
  lastErrorKind: null,
  statusSource: null,
  statusChangedAt: null,
  statusRev: null,
  trafficState: null,
  trafficErrorKind: null,
  trafficAt: null,
  trafficRev: null,
  credentialError: null,
  ...over,
});

describe('displayedProviderHealth', () => {
  it('reauthorize_required outranks both records', () => {
    const h = displayedProviderHealth(
      row({
        credentialError: 'reauthorize_required',
        status: 'error',
        lastErrorKind: 'credential',
        statusSource: 'refresh',
        statusChangedAt: T1,
        statusRev: 1,
        trafficState: 'ok',
        trafficRev: 9,
        trafficAt: T2,
      }),
    );
    expect(h).toEqual({
      state: 'reauthorize_required',
      kind: 'credential',
      source: 'refresh',
      at: T1,
    });
  });

  it('shows the traffic record when it was recorded after the check', () => {
    const h = displayedProviderHealth(
      row({
        status: 'error',
        lastErrorKind: 'auth',
        statusSource: 'test',
        statusChangedAt: T2, // a LATER timestamp does not matter — revisions decide
        statusRev: 1,
        trafficState: 'ok',
        trafficAt: T1,
        trafficRev: 2,
      }),
    );
    expect(h).toEqual({ state: 'ok', kind: null, source: 'traffic', at: T1 });
    expect(
      isDisplayedOk(row({ status: 'error', statusRev: 1, trafficState: 'ok', trafficRev: 2 })),
    ).toBe(true);
  });

  it('shows the check record when it was recorded after the traffic record', () => {
    const h = displayedProviderHealth(
      row({
        status: 'error',
        lastErrorKind: 'auth',
        statusSource: 'test',
        statusChangedAt: T1,
        statusRev: 3,
        trafficState: 'ok',
        trafficAt: T2, // a LATER timestamp does not matter — revisions decide
        trafficRev: 2,
      }),
    );
    expect(h).toEqual({ state: 'error', kind: 'auth', source: 'test', at: T1 });
    expect(
      isDisplayedOk(row({ status: 'error', statusRev: 3, trafficState: 'ok', trafficRev: 2 })),
    ).toBe(false);
  });

  it('a failing traffic record carries its kind (untyped → unavailable)', () => {
    expect(
      displayedProviderHealth(
        row({
          trafficState: 'failing',
          trafficErrorKind: 'rate_limit',
          trafficRev: 1,
          trafficAt: T1,
        }),
      ),
    ).toEqual({ state: 'failing', kind: 'rate_limit', source: 'traffic', at: T1 });
    expect(displayedProviderHealth(row({ trafficState: 'failing', trafficRev: 1 })).kind).toBe(
      'unavailable',
    );
  });

  it('a legacy status (no revision, no source) renders without an invented reason', () => {
    expect(displayedProviderHealth(row({ status: 'error' }))).toEqual({
      state: 'error',
      kind: null,
      source: null,
      at: null,
    });
    expect(displayedProviderHealth(row({ status: 'ok' })).state).toBe('ok');
    expect(displayedProviderHealth(row({ status: 'something-else' })).state).toBe('unknown');
  });

  it('a traffic-only row shows traffic; a legacy status loses to any traffic record', () => {
    expect(displayedProviderHealth(row({ trafficState: 'ok', trafficRev: 1 })).source).toBe(
      'traffic',
    );
    expect(
      displayedProviderHealth(row({ status: 'error', trafficState: 'ok', trafficRev: 1 })).state,
    ).toBe('ok');
  });

  it('a check kind is only reported for an error', () => {
    expect(
      displayedProviderHealth(row({ status: 'ok', lastErrorKind: 'auth', statusRev: 1 })).kind,
    ).toBeNull();
  });
});

describe('reauthorizeRequiredCheck', () => {
  it('is the credential/refresh check record', () => {
    expect(reauthorizeRequiredCheck()).toEqual({
      record: 'check',
      status: 'error',
      kind: 'credential',
      source: 'refresh',
    });
  });
});

describe('recordProviderHealth', () => {
  const principal: Principal = { kind: 'user', userId: 'u1' };
  const guard = { envelope: 'c', baseUrl: 'https://x.test', protocol: 'openai_compatible' };

  it('passes through the repository result', async () => {
    const setHealth = jest.fn().mockResolvedValue(true);
    const db = { providers: { setHealth } } as unknown as Pick<PersistencePort, 'providers'>;
    await expect(
      recordProviderHealth(db, principal, 'p1', reauthorizeRequiredCheck(), guard),
    ).resolves.toBe(true);
    expect(setHealth).toHaveBeenCalledWith(principal, 'p1', reauthorizeRequiredCheck(), guard);
  });

  it('never rejects: a failed write is dropped with a fixed message', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const db = {
      providers: {
        setHealth: jest
          .fn()
          .mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432 secret')),
      },
    } as unknown as Pick<PersistencePort, 'providers'>;
    await expect(
      recordProviderHealth(db, principal, 'p1', reauthorizeRequiredCheck(), guard),
    ).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith('provider health write dropped');
    warn.mockRestore();
  });
});
