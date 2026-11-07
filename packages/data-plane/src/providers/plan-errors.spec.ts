import {
  KIMI_MESSAGES,
  MINIMAX_CODES,
  ZAI_CODES,
  classifyPlanError,
  parseRetryAfter,
  parseZaiResetTime,
} from './plan-errors';

// Fixtures quote the providers' public error references (read 2026-11-06):
//  Z.ai    https://docs.z.ai/api-reference/api-code
//  MiniMax https://platform.minimax.io/docs/api-reference/errorcode
//  Kimi    https://www.kimi.com/code/docs/en/kimi-code/error-reference.html
// No fixture comes from a call made with a key.

const zai = (code: string, message = 'x'): unknown => ({ error: { code, message } });
const RESET = '2026-11-06T18:00:00+08:00';
const RESET_MS = Date.parse(RESET);

describe('Z.ai dialect', () => {
  const quota: readonly [string, string, 'short' | 'long'][] = [
    ['1308', `Usage limit reached for 5 hours. Your limit will reset at ${RESET}`, 'short'],
    ['1310', `Weekly/Monthly Limit Exhausted. Your limit will reset at ${RESET}`, 'long'],
    [
      '1316',
      `Usage limit reached for the past 5 hours. Insufficient balance for extra usage. Resets at ${RESET}.`,
      'short',
    ],
    [
      '1317',
      `Usage limit reached for the past 7 days. Insufficient balance for extra usage. Resets at ${RESET}.`,
      'long',
    ],
    [
      '1318',
      `Usage limit reached for the past 5 hours. Extra usage is not available due to monthly spend limit. Resets at ${RESET}.`,
      'short',
    ],
    [
      '1319',
      `Usage limit reached for the past 7 days. Extra usage is not available due to monthly spend limit. Resets at ${RESET}.`,
      'long',
    ],
    [
      '1320',
      `Usage limit reached for the past 5 hours. Extra usage is not available due to monthly spend limit. Resets at ${RESET}.`,
      'short',
    ],
    [
      '1321',
      `Usage limit reached for the past 7 days. Extra usage is not available due to monthly spend limit. Resets at ${RESET}.`,
      'long',
    ],
  ];

  it.each(quota)(
    '%s is quota_exhausted with the stated reset and a %s window hint',
    (code, msg, window) => {
      expect(classifyPlanError('zai', 429, zai(code, msg))).toEqual({
        kind: 'quota_exhausted',
        window,
        resetAt: RESET_MS,
      });
    },
  );

  it('1313 is risk_control', () => {
    const msg =
      'Your account’s current usage pattern does not comply with the Fair Usage Policy, and your request frequency has been limited. For details, please refer to the Subscription Service Agreement. To restore access, please submit a request.';
    expect(classifyPlanError('zai', 429, zai('1313', msg))).toEqual({ kind: 'risk_control' });
  });

  it.each([
    ['1309', 'Your GLM Coding Plan package has expired and is temporarily unavailable.'],
    ['1314', 'Your enterprise package has expired. Please contact your enterprise administrator.'],
    ['1315', 'This API Key is limited to enterprise coding package scenarios.'],
    ['1113', 'Insufficient balance or no resource package. Please recharge.'],
  ])('%s is plan_inactive', (code, msg) => {
    expect(classifyPlanError('zai', 429, zai(code, msg))).toEqual({ kind: 'plan_inactive' });
  });

  it('1311 is plan_entitlement', () => {
    expect(
      classifyPlanError(
        'zai',
        429,
        zai('1311', 'Your current subscription plan does not yet include access to glm-5'),
      ),
    ).toEqual({ kind: 'plan_entitlement' });
  });

  it('1302 stays rate_limit and 1305 stays unavailable, so they keep the tripping semantics', () => {
    expect(classifyPlanError('zai', 429, zai('1302', 'Rate limit reached for requests'))).toEqual({
      kind: 'rate_limit',
    });
    expect(
      classifyPlanError(
        'zai',
        429,
        zai('1305', 'The service may be temporarily overloaded, please try again later'),
      ),
    ).toEqual({ kind: 'unavailable' });
  });

  it('reads the code as a string and tolerates a number', () => {
    expect(classifyPlanError('zai', 429, { error: { code: 1309, message: 'x' } })).toEqual({
      kind: 'plan_inactive',
    });
  });

  it('every table entry is covered by a fixture above', () => {
    const covered = new Set([
      ...quota.map((q) => q[0]),
      '1313',
      '1309',
      '1314',
      '1315',
      '1113',
      '1311',
      '1302',
      '1305',
    ]);
    expect([...ZAI_CODES.keys()].sort()).toEqual([...covered].sort());
  });
});

describe('MiniMax dialect', () => {
  const rows: readonly [number, string][] = [
    [2056, 'quota_exhausted'],
    [2067, 'quota_exhausted'],
    [2057, 'plan_inactive'],
    [2061, 'plan_entitlement'],
    [2068, 'plan_entitlement'],
    [2062, 'rate_limit'],
    [2064, 'unavailable'],
    [2066, 'unavailable'],
    [2069, 'unknown_model'],
  ];

  it.each(rows)(
    '%s maps to %s under both envelope shapes, as a number and a string',
    (code, kind) => {
      const shapes: unknown[] = [
        { error: { code, message: 'usage limit exceeded' } },
        { error: { code: String(code), message: 'usage limit exceeded' } },
        { base_resp: { status_code: code, status_msg: 'usage limit exceeded' } },
        { base_resp: { status_code: String(code), status_msg: 'usage limit exceeded' } },
      ];
      for (const body of shapes) {
        expect(classifyPlanError('minimax', 429, body)?.kind).toBe(kind);
      }
    },
  );

  it('takes error.code before base_resp.status_code', () => {
    expect(
      classifyPlanError('minimax', 429, {
        error: { code: 2057 },
        base_resp: { status_code: 2056 },
      })?.kind,
    ).toBe('plan_inactive');
  });

  it('falls through to base_resp when error.code is not a code', () => {
    expect(
      classifyPlanError('minimax', 429, {
        error: { code: 'rate_limit_exceeded' },
        base_resp: { status_code: 2056 },
      })?.kind,
    ).toBe('quota_exhausted');
  });

  it('carries the short window hint for 2056 and 2067', () => {
    expect(classifyPlanError('minimax', 429, { error: { code: 2056 } })).toEqual({
      kind: 'quota_exhausted',
      window: 'short',
    });
    expect(classifyPlanError('minimax', 429, { error: { code: 2067 } })?.window).toBe('short');
  });

  it('covers every table entry', () => {
    expect([...MINIMAX_CODES.keys()].sort()).toEqual(rows.map((r) => r[0]).sort());
  });
});

describe('Kimi dialect', () => {
  const straight = (m: string): string => m;
  const typographic = (m: string): string => m.replace(/'/g, '’');
  const kimi = (message: string): unknown => ({ error: { message, type: 'x' } });

  const quota: readonly [string, 'short' | 'long'][] = [
    [
      "You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota",
      'short',
    ],
    ["You've reached your weekly (7-day) usage limit. Your quota will reset.", 'long'],
    ["You've reached your monthly usage limit for this billing cycle.", 'long'],
    ['Your credit balance is insufficient. Please top up.', 'long'],
    ["Your organization's Extra Usage balance has run out. Contact your admin.", 'long'],
    ["You've reached the Extra Usage limit set for your account by your organization.", 'long'],
  ];

  describe.each([
    ['straight', straight],
    ['typographic', typographic],
  ])('with a %s apostrophe', (_name, fold) => {
    it.each(quota)('429 %# is quota_exhausted', (msg, window) => {
      expect(classifyPlanError('kimi', 429, kimi(fold(msg)))).toEqual({
        kind: 'quota_exhausted',
        window,
      });
    });

    it('429 concurrent request limit is risk_control', () => {
      expect(
        classifyPlanError(
          'kimi',
          429,
          kimi(
            fold(
              "You've reached your concurrent request limit. This is triggered by risk control.",
            ),
          ),
        ),
      ).toEqual({ kind: 'risk_control' });
    });

    it('429 transient texts keep the tripping kinds', () => {
      expect(
        classifyPlanError('kimi', 429, kimi(fold("We're receiving too many requests right now."))),
      ).toEqual({ kind: 'rate_limit' });
      expect(
        classifyPlanError('kimi', 429, kimi(fold('The engine is currently overloaded.'))),
      ).toEqual({ kind: 'unavailable' });
    });

    it('403 tier texts are plan_entitlement', () => {
      expect(
        classifyPlanError(
          'kimi',
          403,
          kimi(
            fold(
              'Your current subscription does not have access to k3.1-pro. Upgrade to higher-tier Kimi Code plans.',
            ),
          ),
        ),
      ).toEqual({ kind: 'plan_entitlement' });
      expect(
        classifyPlanError(
          'kimi',
          403,
          kimi(
            fold(
              'Your current plan supports only k3 up to 256K context. 1M context is available on higher-tier Kimi Code plans.',
            ),
          ),
        ),
      ).toEqual({ kind: 'plan_entitlement' });
    });
  });

  it('does not recognise a quota text under a 403 or a tier text under a 429', () => {
    expect(
      classifyPlanError('kimi', 403, kimi("You've reached your 5-hour usage limit.")),
    ).toBeNull();
    expect(
      classifyPlanError('kimi', 429, kimi('Your current subscription does not have access to k3.')),
    ).toBeNull();
  });

  it('does not recognise the documented membership 403 (it stays the generic permission)', () => {
    for (const apos of [straight, typographic]) {
      expect(
        classifyPlanError(
          'kimi',
          403,
          kimi(
            apos(
              "We're unable to verify your membership benefits at this time. Please ensure your membership is active.",
            ),
          ),
        ),
      ).toBeNull();
    }
  });

  it('reads the structured message only, never raw text', () => {
    expect(classifyPlanError('kimi', 429, "You've reached your 5-hour usage limit")).toBeNull();
    expect(
      classifyPlanError('kimi', 429, { note: "You've reached your 5-hour usage limit" }),
    ).toBeNull();
  });

  it('is case-sensitive apart from the apostrophe', () => {
    expect(
      classifyPlanError('kimi', 429, kimi("you've reached your 5-hour usage limit")),
    ).toBeNull();
  });

  it('covers the six quota texts, concurrent, two transient and two tier prefixes', () => {
    expect(KIMI_MESSAGES.size).toBe(11);
  });
});

describe('unrecognised input', () => {
  it.each(['zai', 'minimax', 'kimi'] as const)(
    '%s: an unknown code, a non-JSON body and a missing envelope give null',
    (d) => {
      expect(classifyPlanError(d, 429, { error: { code: '9999', message: 'nope' } })).toBeNull();
      expect(classifyPlanError(d, 429, null)).toBeNull();
      expect(classifyPlanError(d, 429, undefined)).toBeNull();
      expect(classifyPlanError(d, 429, 'not json')).toBeNull();
      expect(classifyPlanError(d, 429, [])).toBeNull();
      expect(classifyPlanError(d, 429, {})).toBeNull();
    },
  );

  it('is total on a hostile nesting', () => {
    let deep: unknown = { code: '1308', message: 'x' };
    for (let i = 0; i < 20; i += 1) deep = { error: deep };
    expect(() => classifyPlanError('zai', 429, deep)).not.toThrow();
  });
});

describe('a 401 is never dialect-classified', () => {
  it('MiniMax 2057 and Z.ai 1309 under 401 return null', () => {
    expect(classifyPlanError('minimax', 401, { error: { code: 2057 } })).toBeNull();
    expect(classifyPlanError('minimax', 401, { base_resp: { status_code: 2057 } })).toBeNull();
    expect(classifyPlanError('zai', 401, zai('1309'))).toBeNull();
    expect(
      classifyPlanError('kimi', 401, {
        error: { message: "You've reached your 5-hour usage limit" },
      }),
    ).toBeNull();
  });
});

describe('resets', () => {
  it('a past reset is returned as parsed (clamping is the store job)', () => {
    const r = classifyPlanError(
      'zai',
      429,
      zai('1308', 'Your limit will reset at 2001-01-01T00:00:00Z'),
    );
    expect(r?.resetAt).toBe(Date.parse('2001-01-01T00:00:00Z'));
  });

  it('a reset more than 7 days ahead is returned as parsed', () => {
    const far = '2099-01-01T00:00:00Z';
    expect(
      classifyPlanError('zai', 429, zai('1308', `Your limit will reset at ${far}`))?.resetAt,
    ).toBe(Date.parse(far));
  });

  it('a zone-less Z.ai time gives no reset', () => {
    const r = classifyPlanError(
      'zai',
      429,
      zai('1316', 'Usage limit reached. Resets at 2026-11-06 18:00:00.'),
    );
    expect(r).toEqual({ kind: 'quota_exhausted', window: 'short' });
  });

  it('honours epoch seconds, epoch milliseconds, a space-separated ISO time and a Z suffix', () => {
    expect(parseZaiResetTime('Resets at 1793000000.')).toBe(1_793_000_000_000);
    expect(parseZaiResetTime('Resets at 1793000000123')).toBe(1_793_000_000_123);
    expect(parseZaiResetTime('Your limit will reset at 2026-11-06 10:00:00 +0800')).toBe(
      Date.parse('2026-11-06T10:00:00+08:00'),
    );
    expect(parseZaiResetTime('Resets at 2026-11-06T10:00:00.250Z.')).toBe(
      Date.parse('2026-11-06T10:00:00.250Z'),
    );
  });

  it('a hostile megabyte message is bounded and a normal clause still parses', () => {
    const hostile = 'reset at ' + '.'.repeat(1_000_000) + 'x';
    const started = Date.now();
    expect(parseZaiResetTime(hostile)).toBeUndefined();
    expect(parseZaiResetTime('reset at ' + ' '.repeat(1_000_000) + 'x')).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(500);
    expect(parseZaiResetTime('resets at 2026-11-07T00:00:00Z.')).toBe(
      Date.parse('2026-11-07T00:00:00Z'),
    );
    expect(parseZaiResetTime('x'.repeat(5_000) + ' Resets at 1793000000.')).toBe(1_793_000_000_000);
  });

  it('ignores a malformed or absent clause', () => {
    expect(parseZaiResetTime(undefined)).toBeUndefined();
    expect(parseZaiResetTime('Usage limit reached')).toBeUndefined();
    expect(parseZaiResetTime('Resets at tomorrow')).toBeUndefined();
    expect(parseZaiResetTime('Resets at 12345')).toBeUndefined();
    expect(parseZaiResetTime('Resets at 2026-13-45T99:00:00Z')).toBeUndefined();
  });

  it('a zone-less time is parsed only with an evidence-set fixed offset', () => {
    expect(parseZaiResetTime('Resets at 2026-11-06 18:00:00.', '+08:00')).toBe(
      Date.parse('2026-11-06T18:00:00+08:00'),
    );
    expect(parseZaiResetTime('Resets at 2026-11-06 18:00:00.', null)).toBeUndefined();
  });

  it('Retry-After: 120 gives retryAfterMs = 120000 and no resetAt', () => {
    const r = classifyPlanError('minimax', 429, { error: { code: 2056 } }, { retryAfter: '120' });
    expect(r).toEqual({ kind: 'quota_exhausted', window: 'short', retryAfterMs: 120_000 });
    expect(r).not.toHaveProperty('resetAt');
  });

  it('an HTTP-date Retry-After gives resetAt and no retryAfterMs', () => {
    const date = 'Fri, 06 Nov 2026 12:00:00 GMT';
    const r = classifyPlanError(
      'kimi',
      429,
      { error: { message: "You've reached your concurrent request limit" } },
      { retryAfter: date },
    );
    expect(r).toEqual({ kind: 'risk_control', resetAt: Date.parse(date) });
    expect(r).not.toHaveProperty('retryAfterMs');
  });

  it('the body reset wins over Retry-After', () => {
    const r = classifyPlanError('zai', 429, zai('1308', `reset at ${RESET}`), {
      retryAfter: '120',
    });
    expect(r?.resetAt).toBe(RESET_MS);
    expect(r).not.toHaveProperty('retryAfterMs');
  });

  it('Retry-After is read only for quota_exhausted and risk_control', () => {
    for (const [d, body] of [
      ['zai', zai('1309')],
      ['zai', zai('1311')],
      ['zai', zai('1302')],
      ['minimax', { error: { code: 2057 } }],
    ] as const) {
      const r = classifyPlanError(d, 429, body, { retryAfter: '120' });
      expect(r).not.toBeNull();
      expect(r).not.toHaveProperty('retryAfterMs');
      expect(r).not.toHaveProperty('resetAt');
    }
  });

  it('rejects an unparseable Retry-After rather than guessing', () => {
    for (const v of ['', 'soon', '-5', '1.5', '12:00', '2026-11-06', '9999999999999']) {
      expect(parseRetryAfter(v)).toBeUndefined();
    }
    expect(parseRetryAfter('0')).toEqual({ retryAfterMs: 0 });
  });

  it('is clock-free: the same input gives the same output at any time', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2020-01-01T00:00:00Z'));
      const a = classifyPlanError('minimax', 429, { error: { code: 2056 } }, { retryAfter: '120' });
      jest.setSystemTime(new Date('2030-06-01T00:00:00Z'));
      const b = classifyPlanError('minimax', 429, { error: { code: 2056 } }, { retryAfter: '120' });
      expect(a).toEqual(b);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('window hints (design D3)', () => {
  it('short and long per code', () => {
    const w = (code: string): unknown => classifyPlanError('zai', 429, zai(code))?.window;
    for (const c of ['1308', '1316', '1318', '1320']) expect(w(c)).toBe('short');
    for (const c of ['1310', '1317', '1319', '1321']) expect(w(c)).toBe('long');
    expect(w('1313')).toBeUndefined();
    expect(w('1309')).toBeUndefined();
    expect(classifyPlanError('minimax', 429, { error: { code: 2057 } })?.window).toBeUndefined();
  });
});
