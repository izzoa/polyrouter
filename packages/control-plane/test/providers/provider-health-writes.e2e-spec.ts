/**
 * The provider health writes (add-provider-health-signals, task 1.2): one guarded,
 * revision-bumping UPDATE per observation, against the real database — the
 * guarantees here (row-lock serialization, READ COMMITTED re-check of the WHERE on
 * the committed row version, SET evaluated against the replaced version) are
 * Postgres semantics a fake cannot prove.
 */
import type { PersistencePort, ProviderIncarnation, ProviderRow } from '@polyrouter/shared/server';
import { TenancyHarness, type TestPrincipal } from '../tenancy/harness';

describe('provider health writes (add-provider-health-signals)', () => {
  let h: TenancyHarness;
  let port: PersistencePort;
  let a: TestPrincipal;
  let b: TestPrincipal;

  beforeAll(async () => {
    h = await TenancyHarness.create();
    port = h.port;
    a = await h.createTestPrincipal('health-a');
    b = await h.createTestPrincipal('health-b');
  });

  afterAll(async () => {
    await h.cleanup();
  });

  const makeProvider = async (who: TestPrincipal = a): Promise<ProviderRow> =>
    port.providers.insert(who.principal, {
      name: 'p',
      kind: 'api_key',
      protocol: 'openai_compatible',
      baseUrl: 'https://api.example.test/v1',
      encryptedCredentials: `cipher-${Math.random().toString(36).slice(2)}`,
    });

  const incarnationOf = (row: ProviderRow): ProviderIncarnation => ({
    envelope: row.encryptedCredentials,
    baseUrl: row.baseUrl,
    protocol: row.protocol,
  });

  const reload = async (row: ProviderRow): Promise<ProviderRow> => {
    const fresh = await port.providers.findById(a.principal, row.id);
    if (!fresh) throw new Error('row vanished');
    return fresh;
  };

  it('records a check and stamps its revision from the same bump', async () => {
    const p = await makeProvider();
    const wrote = await port.providers.setHealth(
      a.principal,
      p.id,
      { record: 'check', status: 'error', kind: 'auth', source: 'test' },
      incarnationOf(p),
    );
    expect(wrote).toBe(true);
    const r = await reload(p);
    expect(r).toMatchObject({
      status: 'error',
      lastErrorKind: 'auth',
      statusSource: 'test',
      healthRev: 1,
      statusRev: 1,
    });
    expect(r.statusChangedAt).toBeInstanceOf(Date);
  });

  it.each([
    ['envelope', (g: ProviderIncarnation) => ({ ...g, envelope: 'someone-elses-cipher' })],
    ['base_url', (g: ProviderIncarnation) => ({ ...g, baseUrl: 'https://other.test/v1' })],
    ['protocol', (g: ProviderIncarnation) => ({ ...g, protocol: 'anthropic_compatible' })],
  ])('a changed %s makes the write a no-op', async (_label, mutate) => {
    const p = await makeProvider();
    for (const patch of [
      { record: 'check', status: 'error', kind: 'auth', source: 'test' },
      { record: 'traffic', state: 'failing', kind: 'auth', seq: 10 },
    ] as const) {
      const wrote = await port.providers.setHealth(
        a.principal,
        p.id,
        patch,
        mutate(incarnationOf(p)),
      );
      expect(wrote).toBe(false);
    }
    const r = await reload(p);
    expect(r).toMatchObject({ status: 'unknown', trafficState: null, healthRev: 0 });
  });

  it('matches a null envelope/base_url null-safely (keyless local provider)', async () => {
    const p = await port.providers.insert(a.principal, {
      name: 'local',
      kind: 'local',
      protocol: 'openai_compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
    });
    const wrote = await port.providers.setHealth(
      a.principal,
      p.id,
      { record: 'check', status: 'ok', kind: null, source: 'test' },
      incarnationOf(p),
    );
    expect(wrote).toBe(true);
  });

  it('refuses an equal or older traffic sequence', async () => {
    const p = await makeProvider();
    const g = incarnationOf(p);
    expect(
      await port.providers.setHealth(
        a.principal,
        p.id,
        { record: 'traffic', state: 'failing', kind: 'auth', seq: 100 },
        g,
      ),
    ).toBe(true);
    expect(
      await port.providers.setHealth(
        a.principal,
        p.id,
        { record: 'traffic', state: 'ok', kind: null, seq: 100 },
        g,
      ),
    ).toBe(false);
    expect(
      await port.providers.setHealth(
        a.principal,
        p.id,
        { record: 'traffic', state: 'ok', kind: null, seq: 99 },
        g,
      ),
    ).toBe(false);
    expect(await reload(p)).toMatchObject({ trafficState: 'failing', trafficSeq: 100 });
    expect(
      await port.providers.setHealth(
        a.principal,
        p.id,
        { record: 'traffic', state: 'ok', kind: null, seq: 101 },
        g,
      ),
    ).toBe(true);
    expect(await reload(p)).toMatchObject({ trafficState: 'ok', trafficSeq: 101 });
  });

  it('revisions strictly increase across interleaved check and traffic writes', async () => {
    const p = await makeProvider();
    const g = incarnationOf(p);
    await port.providers.setHealth(
      a.principal,
      p.id,
      { record: 'check', status: 'error', kind: 'auth', source: 'test' },
      g,
    );
    await port.providers.setHealth(
      a.principal,
      p.id,
      { record: 'traffic', state: 'ok', kind: null, seq: 5 },
      g,
    );
    let r = await reload(p);
    expect(r.statusRev).toBe(1);
    expect(r.trafficRev).toBe(2);
    await port.providers.setHealth(
      a.principal,
      p.id,
      { record: 'check', status: 'ok', kind: null, source: 'sync' },
      g,
    );
    r = await reload(p);
    expect(r.statusRev).toBe(3);
    expect(r.trafficRev).toBe(2);
    expect(r.healthRev).toBe(3);
  });

  it('normalizes kinds: error→ok and failing→ok clear them', async () => {
    const p = await makeProvider();
    const g = incarnationOf(p);
    await port.providers.setHealth(
      a.principal,
      p.id,
      { record: 'check', status: 'error', kind: 'auth', source: 'test' },
      g,
    );
    await port.providers.setHealth(
      a.principal,
      p.id,
      { record: 'traffic', state: 'failing', kind: 'rate_limit', seq: 1 },
      g,
    );
    // A kind passed with a non-failing state is normalized away, not stored.
    await port.providers.setHealth(
      a.principal,
      p.id,
      { record: 'check', status: 'ok', kind: 'auth', source: 'test' },
      g,
    );
    await port.providers.setHealth(
      a.principal,
      p.id,
      { record: 'traffic', state: 'ok', kind: 'rate_limit', seq: 2 },
      g,
    );
    expect(await reload(p)).toMatchObject({
      status: 'ok',
      lastErrorKind: null,
      trafficState: 'ok',
      trafficErrorKind: null,
    });
  });

  it('updateResettingHealth changes the incarnation and resets both records in one statement', async () => {
    const p = await makeProvider();
    const g = incarnationOf(p);
    await port.providers.setHealth(
      a.principal,
      p.id,
      { record: 'check', status: 'error', kind: 'auth', source: 'test' },
      g,
    );
    await port.providers.setHealth(
      a.principal,
      p.id,
      { record: 'traffic', state: 'failing', kind: 'auth', seq: 7 },
      g,
    );
    const updated = await port.providers.updateResettingHealth(
      a.principal,
      p.id,
      { encryptedCredentials: 'rotated-cipher' },
      'edit',
    );
    expect(updated).toMatchObject({
      encryptedCredentials: 'rotated-cipher',
      status: 'unknown',
      lastErrorKind: null,
      statusSource: 'edit',
      statusRev: 3,
      trafficState: null,
      trafficErrorKind: null,
      trafficAt: null,
      trafficSeq: null,
      trafficRev: null,
      healthRev: 3,
    });
    // An observation against the OLD credential is discarded, even with a newer seq.
    expect(
      await port.providers.setHealth(
        a.principal,
        p.id,
        { record: 'traffic', state: 'failing', kind: 'auth', seq: 99 },
        g,
      ),
    ).toBe(false);
  });

  it("another tenant's id affects zero rows, for both writes", async () => {
    const p = await makeProvider(b);
    const g = incarnationOf(p);
    expect(
      await port.providers.setHealth(
        a.principal,
        p.id,
        { record: 'check', status: 'error', kind: 'auth', source: 'test' },
        g,
      ),
    ).toBe(false);
    expect(
      await port.providers.updateResettingHealth(a.principal, p.id, { name: 'hijack' }, 'edit'),
    ).toBeNull();
    const untouched = await port.providers.findById(b.principal, p.id);
    expect(untouched).toMatchObject({ name: 'p', status: 'unknown', healthRev: 0 });
  });

  describe('concurrent UPDATEs on one row (two connections)', () => {
    /** Holds the row lock in a separate connection with an uncommitted UPDATE,
     * starts the port's guarded write (which blocks on the lock), then commits —
     * the blocked write must re-check its WHERE against the COMMITTED version. */
    const raceAgainst = async (
      p: ProviderRow,
      competingSql: string,
      params: unknown[],
      write: () => Promise<boolean>,
    ): Promise<boolean> => {
      const client = await h.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(competingSql, params);
        const pending = write();
        // Give the blocked UPDATE time to reach the lock wait.
        await new Promise((r) => setTimeout(r, 150));
        await client.query('COMMIT');
        return await pending;
      } finally {
        client.release();
      }
    };

    it('the incarnation guard is re-checked against the committed credential', async () => {
      const p = await makeProvider();
      const wrote = await raceAgainst(
        p,
        'UPDATE provider SET encrypted_credentials = $1 WHERE id = $2',
        ['replaced-mid-flight', p.id],
        () =>
          port.providers.setHealth(
            a.principal,
            p.id,
            { record: 'check', status: 'error', kind: 'auth', source: 'test' },
            incarnationOf(p),
          ),
      );
      expect(wrote).toBe(false);
      expect(await reload(p)).toMatchObject({ status: 'unknown', healthRev: 0 });
    });

    it('the sequence guard is re-checked against the committed sequence', async () => {
      const p = await makeProvider();
      const wrote = await raceAgainst(
        p,
        'UPDATE provider SET traffic_seq = 500, traffic_state = $1 WHERE id = $2',
        ['ok', p.id],
        () =>
          port.providers.setHealth(
            a.principal,
            p.id,
            { record: 'traffic', state: 'failing', kind: 'auth', seq: 400 },
            incarnationOf(p),
          ),
      );
      expect(wrote).toBe(false);
      expect(await reload(p)).toMatchObject({ trafficState: 'ok', trafficSeq: 500 });
    });

    it('a blocked write that still qualifies stacks its revision on the committed one', async () => {
      const p = await makeProvider();
      const wrote = await raceAgainst(
        p,
        'UPDATE provider SET health_rev = health_rev + 1, status_rev = health_rev + 1 WHERE id = $1',
        [p.id],
        () =>
          port.providers.setHealth(
            a.principal,
            p.id,
            { record: 'traffic', state: 'ok', kind: null, seq: 1 },
            incarnationOf(p),
          ),
      );
      expect(wrote).toBe(true);
      const r = await reload(p);
      expect(r.statusRev).toBe(1);
      expect(r.trafficRev).toBe(2);
      expect(r.healthRev).toBe(2);
    });
  });
});
