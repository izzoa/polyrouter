/* eslint-disable @typescript-eslint/require-await -- fake async generators feed the tap */
import {
  MAX_TAP_LINE_BYTES,
  clampPercent,
  parseAnthropicUnified,
  parseCodex,
  parseDecimal,
  parsePlanUsageHeaders,
  readOpencodeBillingFromJson,
  tapUsageFrames,
  type PlanUsageObservation,
  type PlanUsageWindow,
  type UsageHeaders,
} from './plan-usage';

/** A header fake that logs every name read through `get`, and (optionally) iterates names. */
function fakeHeaders(
  entries: Record<string, string>,
  opts: { forEach?: boolean } = {},
): UsageHeaders & { readonly reads: string[]; readonly iterated: string[] } {
  const map = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
  const reads: string[] = [];
  const iterated: string[] = [];
  const get = (name: string): string | null => {
    reads.push(name.toLowerCase());
    return map.get(name.toLowerCase()) ?? null;
  };
  return {
    get,
    ...(opts.forEach === false
      ? {}
      : {
          forEach: (cb: (value: string, name: string) => void) => {
            for (const [k, v] of map) {
              iterated.push(k);
              cb(v, k);
            }
          },
        }),
    reads,
    iterated,
  };
}

const P = 'anthropic-ratelimit-unified-';

/** The claude-code#12829 capture (read 2026-11-06). */
const CAPTURE: Record<string, string> = {
  [`${P}status`]: 'allowed',
  [`${P}5h-status`]: 'allowed',
  [`${P}5h-reset`]: '1764554400',
  [`${P}5h-utilization`]: '0.018416969696969696',
  [`${P}7d-status`]: 'allowed',
  [`${P}7d-reset`]: '1764615600',
  [`${P}7d-utilization`]: '0.7370692663445869',
  [`${P}representative-claim`]: 'five_hour',
  [`${P}fallback-percentage`]: '0.2',
  [`${P}reset`]: '1764554400',
  [`${P}overage-disabled-reason`]: 'org_level_disabled',
};
/** An instant shortly before the capture's resets (2025-12-01T02:00:00Z is 1764554400). */
const NEAR_CAPTURE = 1764550000000;

function win(obs: PlanUsageObservation | null, key: string): PlanUsageWindow {
  const w = obs?.windows.find((x) => x.key === key);
  if (w === undefined) throw new Error(`no window ${key}`);
  return w;
}

describe('common rules', () => {
  it.each(['', ' ', '-0.5', '1e12', '0x10', '+5', 'NaN', 'Infinity', '1,5', '.5', '5.'])(
    'parseDecimal drops %j as absent, never 0',
    (raw) => {
      expect(parseDecimal(raw)).toBeNull();
    },
  );

  it('parseDecimal keeps plain decimals and trims', () => {
    expect(parseDecimal(' 12.5 ')).toBe(12.5);
    expect(parseDecimal('0')).toBe(0);
    expect(parseDecimal(null)).toBeNull();
  });

  it('clamps a percent to at most 100', () => {
    expect(clampPercent(120)).toBe(100);
    expect(clampPercent(12.5)).toBe(13);
  });
});

describe('anthropic_unified', () => {
  it('reads the #12829 capture: 5h at 2%, 7d at 74%, epoch resets, billing plan', () => {
    const obs = parseAnthropicUnified(fakeHeaders(CAPTURE), NEAR_CAPTURE);
    expect(obs).toEqual({
      windows: [
        {
          key: 'account:5h',
          group: 'account',
          span: '5h',
          minutes: 300,
          scope: null,
          usedPercent: 2,
          reset: { atMs: 1764554400000 },
        },
        {
          key: 'account:weekly',
          group: 'account',
          span: 'weekly',
          minutes: 10080,
          scope: null,
          usedPercent: 74,
          reset: { atMs: 1764615600000 },
        },
      ],
      billing: 'plan',
    });
  });

  it('reads 7d_oi as a weekly window scoped Fable', () => {
    const obs = parseAnthropicUnified(
      fakeHeaders({
        [`${P}status`]: 'allowed',
        [`${P}7d_oi-utilization`]: '0.5',
        [`${P}7d_oi-reset`]: '1764615600',
      }),
      NEAR_CAPTURE,
    );
    expect(win(obs, 'account:weekly:Fable')).toMatchObject({
      group: 'account',
      span: 'weekly',
      scope: 'Fable',
      usedPercent: 50,
    });
  });

  it('overage-in-use true is extra_usage; its absence with a status is plan', () => {
    const base = { [`${P}status`]: 'allowed', [`${P}5h-utilization`]: '0.1' };
    expect(
      parseAnthropicUnified(fakeHeaders({ ...base, [`${P}overage-in-use`]: 'true' }), NEAR_CAPTURE)
        ?.billing,
    ).toBe('extra_usage');
    expect(
      parseAnthropicUnified(fakeHeaders({ ...base, [`${P}overage-in-use`]: 'false' }), NEAR_CAPTURE)
        ?.billing,
    ).toBe('plan');
    expect(parseAnthropicUnified(fakeHeaders(base), NEAR_CAPTURE)?.billing).toBe('plan');
  });

  it('a rejected 429 with window headers gives those windows and no other field', () => {
    const obs = parseAnthropicUnified(
      fakeHeaders({ ...CAPTURE, [`${P}status`]: 'rejected', [`${P}5h-utilization`]: '1' }),
      NEAR_CAPTURE,
    );
    expect(obs).not.toBeNull();
    // No limit-reached field exists on the observation (FD10): only these two keys.
    expect(Object.keys(obs ?? {}).sort()).toEqual(['billing', 'windows']);
    expect(win(obs, 'account:5h').usedPercent).toBe(100);
    expect(obs?.windows).toHaveLength(2);
  });

  it('no -status header gives null, never allowed and never 0%', () => {
    const { [`${P}status`]: _status, ...noStatus } = CAPTURE;
    void _status;
    expect(parseAnthropicUnified(fakeHeaders(noStatus), NEAR_CAPTURE)).toBeNull();
    expect(parseAnthropicUnified(fakeHeaders({}), NEAR_CAPTURE)).toBeNull();
    expect(parseAnthropicUnified(fakeHeaders({ [`${P}status`]: '   ' }), NEAR_CAPTURE)).toBeNull();
  });

  it('a status with no window values is an observation with no windows (billing plan)', () => {
    expect(parseAnthropicUnified(fakeHeaders({ [`${P}status`]: 'allowed' }), NEAR_CAPTURE)).toEqual(
      { windows: [], billing: 'plan' },
    );
  });

  describe('common rules, each value dropping alone', () => {
    const util = (v: string) =>
      parseAnthropicUnified(
        fakeHeaders({
          ...CAPTURE,
          [`${P}5h-utilization`]: v,
        }),
        NEAR_CAPTURE,
      );

    it.each(['', ' ', '-0.5', '1e12', '0x10'])('utilization %j is absent, never 0', (v) => {
      const w = win(util(v), 'account:5h');
      expect(w.usedPercent).toBeNull();
      // The reset and the other window survive.
      expect(w.reset).toEqual({ atMs: 1764554400000 });
      expect(win(util(v), 'account:weekly').usedPercent).toBe(74);
    });

    it.each(['', ' ', '-5', '1e12', '0x10'])('reset %j is absent, never 0', (v) => {
      const obs = parseAnthropicUnified(
        fakeHeaders({ ...CAPTURE, [`${P}5h-reset`]: v }),
        NEAR_CAPTURE,
      );
      expect(win(obs, 'account:5h')).toMatchObject({ usedPercent: 2, reset: null });
      expect(win(obs, 'account:weekly').reset).toEqual({ atMs: 1764615600000 });
    });

    it('rounds a fractional reset and keeps it', () => {
      const obs = parseAnthropicUnified(
        fakeHeaders({ ...CAPTURE, [`${P}5h-reset`]: '1764554400.6' }),
        NEAR_CAPTURE,
      );
      expect(win(obs, 'account:5h').reset).toEqual({ atMs: 1764554401000 });
    });

    it('a reset in milliseconds in a seconds field leaves the window with an unknown reset', () => {
      const obs = parseAnthropicUnified(
        fakeHeaders({ ...CAPTURE, [`${P}5h-reset`]: '1764554400000' }),
        NEAR_CAPTURE,
      );
      expect(win(obs, 'account:5h')).toMatchObject({ usedPercent: 2, reset: null });
    });

    it('a reset more than 10 minutes in the past leaves an unknown reset', () => {
      const past = String(Math.floor(NEAR_CAPTURE / 1000) - 11 * 60);
      const obs = parseAnthropicUnified(
        fakeHeaders({ ...CAPTURE, [`${P}5h-reset`]: past }),
        NEAR_CAPTURE,
      );
      expect(win(obs, 'account:5h').reset).toBeNull();
    });

    it('a reset within 10 minutes in the past is kept', () => {
      const recent = String(Math.floor(NEAR_CAPTURE / 1000) - 5 * 60);
      const obs = parseAnthropicUnified(
        fakeHeaders({ ...CAPTURE, [`${P}5h-reset`]: recent }),
        NEAR_CAPTURE,
      );
      expect(win(obs, 'account:5h').reset).toEqual({ atMs: Number(recent) * 1000 });
    });

    it('a reset beyond the window length plus 10 minutes is dropped', () => {
      const far = String(Math.floor(NEAR_CAPTURE / 1000) + 6 * 3600);
      const obs = parseAnthropicUnified(
        fakeHeaders({ ...CAPTURE, [`${P}5h-reset`]: far }),
        NEAR_CAPTURE,
      );
      expect(win(obs, 'account:5h').reset).toBeNull();
    });

    it('clamps utilization above 1 to 100%', () => {
      expect(win(util('1.7'), 'account:5h').usedPercent).toBe(100);
    });
  });

  it('reads exactly the allowlisted names, whatever else the family carries', () => {
    const noisy: Record<string, string> = {
      ...CAPTURE,
      [`${P}7d_oi-utilization`]: '0.2',
      [`${P}7d_oi-reset`]: '1764615600',
      [`${P}overage-in-use`]: 'true',
      [`${P}overage-status`]: 'allowed',
      [`${P}overage-utilization`]: '0.3',
      [`${P}overage-reset`]: '1764615600',
      [`${P}5h-surpassed-threshold`]: '0.75',
      [`${P}7d-surpassed-threshold`]: '0.75',
      [`${P}grace-status`]: 'allowed',
      [`${P}grace-5h-utilization`]: '0.1',
      [`${P}slow-status`]: 'active',
      [`${P}slow-offer`]: 'treatment',
      [`${P}upgrade-paths`]: 'max',
    };
    const h = fakeHeaders(noisy);
    parseAnthropicUnified(h, NEAR_CAPTURE);
    expect([...new Set(h.reads)].sort()).toEqual(
      [
        `${P}status`,
        `${P}5h-utilization`,
        `${P}5h-reset`,
        `${P}7d-utilization`,
        `${P}7d-reset`,
        `${P}7d_oi-utilization`,
        `${P}7d_oi-reset`,
        `${P}overage-in-use`,
      ].sort(),
    );
    expect(h.iterated).toEqual([]);
  });

  it('never throws on hostile values', () => {
    const hostile = fakeHeaders({
      [`${P}status`]: 'allowed',
      [`${P}5h-utilization`]: '9'.repeat(400),
      [`${P}5h-reset`]: '9'.repeat(400),
    });
    expect(() => parseAnthropicUnified(hostile, NEAR_CAPTURE)).not.toThrow();
  });
});

describe('codex', () => {
  const NOW = 1704068000000; // shortly before the Codex test fixture's reset 1704069000
  const X = 'x-codex-';

  it('labels 300 minutes 5h and 10080 weekly, from used-percent and reset-at', () => {
    const obs = parseCodex(
      fakeHeaders({
        [`${X}primary-used-percent`]: '12.5',
        [`${X}primary-window-minutes`]: '300',
        [`${X}primary-reset-at`]: '1704069000',
        [`${X}secondary-used-percent`]: '40',
        [`${X}secondary-window-minutes`]: '10080',
        [`${X}secondary-reset-at`]: '1704400000',
      }),
      200,
      NOW,
    );
    expect(win(obs, 'account:5h')).toMatchObject({
      span: '5h',
      minutes: 300,
      usedPercent: 13,
      reset: { atMs: 1704069000000 },
    });
    expect(win(obs, 'account:weekly')).toMatchObject({
      span: 'weekly',
      usedPercent: 40,
      reset: { atMs: 1704400000000 },
    });
  });

  it('a lone weekly window in the primary slot is weekly, never 5h', () => {
    const obs = parseCodex(
      fakeHeaders({
        [`${X}primary-used-percent`]: '20',
        [`${X}primary-window-minutes`]: '10080',
        [`${X}primary-reset-at`]: '1704400000',
      }),
      200,
      NOW,
    );
    expect(obs?.windows.map((w) => w.span)).toEqual(['weekly']);
  });

  it('matches a length within 5% and leaves other lengths unnamed with minutes kept', () => {
    const near = parseCodex(
      fakeHeaders({
        [`${X}primary-used-percent`]: '10',
        [`${X}primary-window-minutes`]: '310',
        [`${X}primary-reset-at`]: '1704069000',
      }),
      200,
      NOW,
    );
    expect(near?.windows[0]?.span).toBe('5h');
    const sixty = parseCodex(
      fakeHeaders({
        [`${X}primary-used-percent`]: '12.5',
        [`${X}primary-window-minutes`]: '60',
        [`${X}primary-reset-at`]: '1704069000',
      }),
      200,
      NOW,
    );
    expect(sixty?.windows[0]).toMatchObject({ span: null, minutes: 60, usedPercent: 13 });
  });

  it('reset-at gives { atMs }; the legacy reset-after-seconds gives { inMs }', () => {
    const at = parseCodex(
      fakeHeaders({
        [`${X}primary-used-percent`]: '5',
        [`${X}primary-window-minutes`]: '300',
        [`${X}primary-reset-at`]: '1704069000',
      }),
      200,
      NOW,
    );
    expect(at?.windows[0]?.reset).toEqual({ atMs: 1704069000000 });
    const legacy = parseCodex(
      fakeHeaders({
        [`${X}primary-used-percent`]: '5',
        [`${X}primary-window-minutes`]: '300',
        [`${X}primary-reset-after-seconds`]: '600',
      }),
      200,
      NOW,
    );
    expect(legacy?.windows[0]?.reset).toEqual({ inMs: 600_000 });
    // reset-at wins over the legacy form when both are present.
    const both = parseCodex(
      fakeHeaders({
        [`${X}primary-used-percent`]: '5',
        [`${X}primary-window-minutes`]: '300',
        [`${X}primary-reset-at`]: '1704069000',
        [`${X}primary-reset-after-seconds`]: '600',
      }),
      200,
      NOW,
    );
    expect(both?.windows[0]?.reset).toEqual({ atMs: 1704069000000 });
  });

  it('drops an implausible reset (ms in seconds, a legacy value beyond the window)', () => {
    const ms = parseCodex(
      fakeHeaders({
        [`${X}primary-used-percent`]: '5',
        [`${X}primary-window-minutes`]: '300',
        [`${X}primary-reset-at`]: '1704069000000',
      }),
      200,
      NOW,
    );
    expect(ms?.windows[0]).toMatchObject({ usedPercent: 5, reset: null });
    const longLegacy = parseCodex(
      fakeHeaders({
        [`${X}primary-used-percent`]: '5',
        [`${X}primary-window-minutes`]: '300',
        [`${X}primary-reset-after-seconds`]: String(24 * 3600),
      }),
      200,
      NOW,
    );
    expect(longLegacy?.windows[0]?.reset).toBeNull();
  });

  describe('model buckets', () => {
    const bucketHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
      [`${X}primary-used-percent`]: '10',
      [`${X}primary-window-minutes`]: '300',
      [`${X}primary-reset-at`]: '1704069000',
      'x-codex-bengalfox-primary-used-percent': '80',
      'x-codex-bengalfox-primary-window-minutes': '300',
      'x-codex-bengalfox-primary-reset-at': '1704069000',
      'x-codex-bengalfox-limit-name': 'gpt-5.2-codex-sonic',
      ...extra,
    });

    it('a bengalfox family becomes a bucket scoped by an allowlisted limit-name', () => {
      const obs = parseCodex(fakeHeaders(bucketHeaders()), 200, NOW);
      expect(win(obs, 'model:codex_bengalfox')).toMatchObject({
        group: 'model',
        scope: 'gpt-5.2-codex-sonic',
        usedPercent: 80,
      });
      // The account window is separate from the bucket.
      expect(win(obs, 'account:5h').group).toBe('account');
    });

    it('a hostile limit-name falls back to the derived id', () => {
      for (const hostile of ['<script>alert(1)</script>', 'a'.repeat(60), '../etc', '']) {
        const obs = parseCodex(
          fakeHeaders(bucketHeaders({ 'x-codex-bengalfox-limit-name': hostile })),
          200,
          NOW,
        );
        expect(win(obs, 'model:codex_bengalfox').scope).toBe('codex_bengalfox');
      }
    });

    it('keeps at most eight buckets', () => {
      const many: Record<string, string> = bucketHeaders();
      for (let i = 0; i < 9; i++) {
        many[`x-fam${String(i)}-primary-used-percent`] = '5';
        many[`x-fam${String(i)}-primary-reset-at`] = '1704069000';
      }
      const obs = parseCodex(fakeHeaders(many), 200, NOW);
      expect(obs?.windows.filter((w) => w.group === 'model')).toHaveLength(8);
    });

    it('the name trap: x-codex-secondary-primary-used-percent is bucket codex_secondary', () => {
      const obs = parseCodex(
        fakeHeaders({
          [`${X}primary-used-percent`]: '10',
          [`${X}primary-window-minutes`]: '300',
          [`${X}secondary-used-percent`]: '20',
          [`${X}secondary-window-minutes`]: '10080',
          'x-codex-secondary-primary-used-percent': '70',
          'x-codex-secondary-primary-reset-at': '1704069000',
        }),
        200,
        NOW,
      );
      expect(win(obs, 'model:codex_secondary').usedPercent).toBe(70);
      // The real secondary window is untouched by the trap.
      expect(win(obs, 'account:weekly').usedPercent).toBe(20);
    });

    it('finds no buckets without header iteration', () => {
      const obs = parseCodex(fakeHeaders(bucketHeaders(), { forEach: false }), 200, NOW);
      expect(obs?.windows.map((w) => w.group)).toEqual(['account']);
    });

    it('works on real undici Headers (lower-cased names, forEach present)', () => {
      const real = new Headers({
        'X-Codex-Primary-Used-Percent': '10',
        'X-Codex-Primary-Window-Minutes': '300',
        'X-Codex-Bengalfox-Primary-Used-Percent': '80',
        'X-Codex-Bengalfox-Primary-Reset-At': '1704069000',
      });
      const obs = parseCodex(real, 200, NOW);
      expect(win(obs, 'model:codex_bengalfox').usedPercent).toBe(80);
    });
  });

  describe('credits and billing', () => {
    const full: Record<string, string> = {
      [`${X}primary-used-percent`]: '100',
      [`${X}primary-window-minutes`]: '300',
      [`${X}primary-reset-at`]: '1704069000',
    };

    it('the credit flags need both headers, and the balance is never read', () => {
      const onlyOne = fakeHeaders({ ...full, [`${X}credits-has-credits`]: 'true' });
      expect(parseCodex(onlyOne, 200, NOW)?.billing).toBeNull();
      const both = fakeHeaders({
        ...full,
        [`${X}credits-has-credits`]: 'true',
        [`${X}credits-unlimited`]: 'false',
        [`${X}credits-balance`]: '9.99',
      });
      expect(parseCodex(both, 200, NOW)?.billing).toBe('extra_usage_possible');
      expect(both.reads).not.toContain(`${X}credits-balance`);
    });

    it('accepts 1/0 and an unlimited flag', () => {
      const h = fakeHeaders({
        ...full,
        [`${X}credits-has-credits`]: '0',
        [`${X}credits-unlimited`]: '1',
      });
      expect(parseCodex(h, 200, NOW)?.billing).toBe('extra_usage_possible');
    });

    it('full with credits flags false is null; full with no flags is null', () => {
      expect(
        parseCodex(
          fakeHeaders({
            ...full,
            [`${X}credits-has-credits`]: 'false',
            [`${X}credits-unlimited`]: 'false',
          }),
          200,
          NOW,
        )?.billing,
      ).toBeNull();
      expect(parseCodex(fakeHeaders(full), 200, NOW)?.billing).toBeNull();
    });

    it('plan on a 2xx whose account windows are all below 100', () => {
      const h = fakeHeaders({ ...full, [`${X}primary-used-percent`]: '99' });
      expect(parseCodex(h, 200, NOW)?.billing).toBe('plan');
    });

    it('null billing on a non-2xx, windows still reported', () => {
      const h = fakeHeaders({
        ...full,
        [`${X}credits-has-credits`]: 'true',
        [`${X}credits-unlimited`]: 'true',
      });
      const obs = parseCodex(h, 429, NOW);
      expect(obs?.billing).toBeNull();
      expect(obs?.windows).toHaveLength(1);
      expect(
        parseCodex(fakeHeaders({ ...full, [`${X}primary-used-percent`]: '3' }), 500, NOW)?.billing,
      ).toBeNull();
    });

    it('a window count needs an account window for billing (bucket only: null)', () => {
      const obs = parseCodex(
        fakeHeaders({
          'x-codex-bengalfox-primary-used-percent': '100',
          'x-codex-bengalfox-primary-reset-at': '1704069000',
          [`${X}credits-has-credits`]: 'true',
          [`${X}credits-unlimited`]: 'true',
        }),
        200,
        NOW,
      );
      expect(obs?.windows).toHaveLength(1);
      expect(obs?.billing).toBeNull();
    });
  });

  describe("Codex's counting rule", () => {
    it('used=0 minutes=0 and no reset-at gives no window (default family)', () => {
      expect(
        parseCodex(
          fakeHeaders({
            [`${X}primary-used-percent`]: '0',
            [`${X}primary-window-minutes`]: '0',
            [`${X}secondary-used-percent`]: '0',
            [`${X}secondary-window-minutes`]: '0',
          }),
          200,
          NOW,
        ),
      ).toBeNull();
    });

    it('used=0 minutes=0 and no reset-at gives no window (bucket)', () => {
      expect(
        parseCodex(
          fakeHeaders({
            'x-codex-bengalfox-primary-used-percent': '0',
            'x-codex-bengalfox-primary-window-minutes': '0',
          }),
          200,
          NOW,
        ),
      ).toBeNull();
    });

    it('used=0 with a reset-at is a 0% window', () => {
      const obs = parseCodex(
        fakeHeaders({
          [`${X}primary-used-percent`]: '0',
          [`${X}primary-window-minutes`]: '0',
          [`${X}primary-reset-at`]: '1704069000',
        }),
        200,
        NOW,
      );
      expect(obs?.windows).toHaveLength(1);
      expect(obs?.windows[0]).toMatchObject({ usedPercent: 0, reset: { atMs: 1704069000000 } });
    });

    it('an unparseable reset-at is no reset-at: used=0 gives no window, and the legacy reset is used', () => {
      expect(
        parseCodex(
          fakeHeaders({
            [`${X}primary-used-percent`]: '0',
            [`${X}primary-window-minutes`]: '0',
            [`${X}primary-reset-at`]: 'abc',
          }),
          200,
          NOW,
        ),
      ).toBeNull();
      const obs = parseCodex(
        fakeHeaders({
          [`${X}primary-used-percent`]: '5',
          [`${X}primary-reset-at`]: 'abc',
          [`${X}primary-reset-after-seconds`]: '600',
        }),
        200,
        NOW,
      );
      expect(obs?.windows).toHaveLength(1);
      expect(obs?.windows[0]?.reset).toEqual({ inMs: 600_000 });
    });

    it('used=0 with non-zero minutes counts', () => {
      const obs = parseCodex(
        fakeHeaders({
          [`${X}primary-used-percent`]: '0',
          [`${X}primary-window-minutes`]: '300',
        }),
        200,
        NOW,
      );
      expect(obs?.windows[0]).toMatchObject({ usedPercent: 0, span: '5h', reset: null });
    });

    it('an unparseable percent is no window even with a reset', () => {
      expect(
        parseCodex(
          fakeHeaders({
            [`${X}primary-used-percent`]: '1e3',
            [`${X}primary-reset-at`]: '1704069000',
          }),
          200,
          NOW,
        ),
      ).toBeNull();
    });
  });

  it('never reads x-codex-rate-limit-reached-type, and no header value in the iteration', () => {
    const h = fakeHeaders({
      [`${X}primary-used-percent`]: '100',
      [`${X}primary-window-minutes`]: '300',
      [`${X}rate-limit-reached-type`]: 'workspace_owner_credits_depleted',
      [`${X}active-limit`]: 'codex',
      [`${X}promo-message`]: 'upgrade now',
    });
    parseCodex(h, 429, NOW);
    expect(h.reads).not.toContain(`${X}rate-limit-reached-type`);
    expect(h.reads).not.toContain(`${X}active-limit`);
    expect(h.reads).not.toContain(`${X}promo-message`);
  });

  it('no window header gives null, never a default 0% window', () => {
    expect(parseCodex(fakeHeaders({}), 200, NOW)).toBeNull();
    expect(parseCodex(fakeHeaders({ [`${X}credits-has-credits`]: 'true' }), 200, NOW)).toBeNull();
  });

  it('clamps used 120 to 100', () => {
    const obs = parseCodex(
      fakeHeaders({
        [`${X}primary-used-percent`]: '120',
        [`${X}primary-window-minutes`]: '300',
      }),
      200,
      NOW,
    );
    expect(obs?.windows[0]?.usedPercent).toBe(100);
  });

  it('the dispatcher routes by dialect, and opencode_go is body-borne', () => {
    const codexHeaders = fakeHeaders({
      [`${X}primary-used-percent`]: '12',
      [`${X}primary-window-minutes`]: '300',
    });
    expect(
      parsePlanUsageHeaders('codex', { status: 200, headers: codexHeaders }, NOW),
    ).not.toBeNull();
    expect(
      parsePlanUsageHeaders('anthropic_unified', { status: 200, headers: fakeHeaders({}) }, NOW),
    ).toBeNull();
    expect(
      parsePlanUsageHeaders('opencode_go', { status: 200, headers: codexHeaders }, NOW),
    ).toBeNull();
  });
});

describe('opencode_go', () => {
  // The opencode.ai docs example for the response usage extension (read 2026-11-06).
  const DOCS_FRAME = {
    id: 'chatcmpl-123',
    object: 'chat.completion.chunk',
    choices: [],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 34,
      total_tokens: 46,
      opencode: { billing_source: 'go', allowance: 0.0012 },
    },
  };
  const frameOf = (billing: unknown): unknown => ({
    usage: { opencode: { billing_source: billing, allowance: 0.5 } },
  });

  describe('readOpencodeBillingFromJson', () => {
    it('go and go-plus give plan, balance gives extra_usage', () => {
      expect(readOpencodeBillingFromJson(DOCS_FRAME)).toEqual({ windows: [], billing: 'plan' });
      expect(readOpencodeBillingFromJson(frameOf('go-plus'))?.billing).toBe('plan');
      expect(readOpencodeBillingFromJson(frameOf('balance'))).toEqual({
        windows: [],
        billing: 'extra_usage',
      });
    });

    it('free, byok, absent and unknown values give nothing', () => {
      for (const v of ['free', 'byok', 'GO', '', 'zen', 7, null, undefined, {}]) {
        expect(readOpencodeBillingFromJson(frameOf(v))).toBeNull();
      }
      expect(readOpencodeBillingFromJson({ usage: { opencode: {} } })).toBeNull();
      expect(readOpencodeBillingFromJson({ usage: {} })).toBeNull();
      expect(readOpencodeBillingFromJson({})).toBeNull();
      expect(readOpencodeBillingFromJson(null)).toBeNull();
      expect(readOpencodeBillingFromJson('x')).toBeNull();
      expect(readOpencodeBillingFromJson([DOCS_FRAME])).toBeNull();
    });

    it('never reads allowance (a getter on the frame would record the read)', () => {
      const reads: string[] = [];
      const opencode = new Proxy(
        { billing_source: 'balance' },
        {
          get(target, prop, receiver) {
            reads.push(String(prop));
            return Reflect.get(target, prop, receiver) as unknown;
          },
        },
      );
      const frame = Object.freeze({ usage: Object.freeze({ opencode }) });
      readOpencodeBillingFromJson(frame);
      expect(reads).toEqual(['billing_source']);
    });
  });

  describe('tapUsageFrames', () => {
    async function* gen(chunks: readonly string[]): AsyncGenerator<string> {
      for (const c of chunks) yield c;
    }
    async function drain(
      source: AsyncIterable<string>,
      onFrame: (o: PlanUsageObservation) => void = () => undefined,
    ): Promise<string[]> {
      const out: string[] = [];
      for await (const c of tapUsageFrames(source, onFrame)) out.push(c);
      return out;
    }
    const line = (billing: string): string =>
      `data: ${JSON.stringify({ usage: { opencode: { billing_source: billing } } })}\n\n`;

    it('yields every chunk unchanged and in order', async () => {
      const chunks = ['data: {"a":1}\n\n', ': keepalive\n\n', line('go'), 'data: [DONE]\n\n'];
      expect(await drain(gen(chunks))).toEqual(chunks);
    });

    it('reads a usage frame split across three chunks once it is complete', async () => {
      const full = line('balance');
      const a = full.slice(0, 10);
      const b = full.slice(10, 40);
      const c = full.slice(40);
      const seen: PlanUsageObservation[] = [];
      expect(await drain(gen([a, b, c]), (o) => seen.push(o))).toEqual([a, b, c]);
      expect(seen).toEqual([{ windows: [], billing: 'extra_usage' }]);
    });

    it('reports once, at the end, and the last frame wins', async () => {
      const seen: PlanUsageObservation[] = [];
      await drain(gen([line('go'), line('balance'), line('go')]), (o) => seen.push(o));
      expect(seen).toEqual([{ windows: [], billing: 'plan' }]);
      const seen2: PlanUsageObservation[] = [];
      await drain(gen([line('go'), line('balance')]), (o) => seen2.push(o));
      expect(seen2).toEqual([{ windows: [], billing: 'extra_usage' }]);
    });

    it('reports nothing when no frame maps, and ignores unknown sources', async () => {
      const seen: PlanUsageObservation[] = [];
      await drain(gen([line('free'), line('byok'), 'data: {"x":1}\n\n']), (o) => seen.push(o));
      expect(seen).toEqual([]);
    });

    it('reads a final frame with no trailing newline and CRLF endings', async () => {
      const seen: PlanUsageObservation[] = [];
      const payload = JSON.stringify({ usage: { opencode: { billing_source: 'balance' } } });
      await drain(gen([`data: ${payload}`]), (o) => seen.push(o));
      expect(seen).toHaveLength(1);
      const crlf: PlanUsageObservation[] = [];
      await drain(gen([`data: ${payload}\r\n\r\n`]), (o) => crlf.push(o));
      expect(crlf).toHaveLength(1);
    });

    it('a line over 64 KiB disables the tap without an error, still yielding every chunk', async () => {
      const huge = `data: ${'x'.repeat(MAX_TAP_LINE_BYTES + 10)}`;
      const chunks = [huge.slice(0, 40_000), huge.slice(40_000), '\n\n', line('balance')];
      const seen: PlanUsageObservation[] = [];
      expect(await drain(gen(chunks), (o) => seen.push(o))).toEqual(chunks);
      expect(seen).toEqual([]);
    });

    it('a single over-cap complete line also disables the tap', async () => {
      const chunks = [`data: ${'y'.repeat(MAX_TAP_LINE_BYTES + 1)}\n\n`, line('balance')];
      const seen: PlanUsageObservation[] = [];
      expect(await drain(gen(chunks), (o) => seen.push(o))).toEqual(chunks);
      expect(seen).toEqual([]);
    });

    it('a multibyte line under 64K characters but over 64 KiB in bytes disables the tap', async () => {
      const wide = `data: ${'\u00e9'.repeat(MAX_TAP_LINE_BYTES / 2 + 10)}`;
      expect(wide.length).toBeLessThan(MAX_TAP_LINE_BYTES);
      const chunks = [wide, '\n\n', line('balance')];
      const seen: PlanUsageObservation[] = [];
      expect(await drain(gen(chunks), (o) => seen.push(o))).toEqual(chunks);
      expect(seen).toEqual([]);
    });

    it('contains malformed JSON', async () => {
      const chunks = ['data: {"billing_source": oops}\n\n', line('balance')];
      const seen: PlanUsageObservation[] = [];
      expect(await drain(gen(chunks), (o) => seen.push(o))).toEqual(chunks);
      expect(seen).toEqual([{ windows: [], billing: 'extra_usage' }]);
    });

    it('a throwing onFrame never fails the stream', async () => {
      const chunks = [line('balance')];
      expect(
        await drain(gen(chunks), () => {
          throw new Error('boom');
        }),
      ).toEqual(chunks);
    });

    it('reports when the stream is abandoned by the consumer', async () => {
      const seen: PlanUsageObservation[] = [];
      const it = tapUsageFrames(gen([line('balance'), 'data: more\n\n']), (o) => seen.push(o));
      await it.next();
      await it.next();
      await it.return(undefined);
      expect(seen).toEqual([{ windows: [], billing: 'extra_usage' }]);
    });

    it('reports when the upstream errors, and rethrows the error', async () => {
      async function* failing(): AsyncGenerator<string> {
        yield line('balance');
        throw new Error('upstream died');
      }
      const seen: PlanUsageObservation[] = [];
      await expect(drain(failing(), (o) => seen.push(o))).rejects.toThrow('upstream died');
      expect(seen).toHaveLength(1);
    });
  });
});
