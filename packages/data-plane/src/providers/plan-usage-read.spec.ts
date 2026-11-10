// add-subscription-quota-display (task 3.5) — the attended usage read and its four parsers.
//
// FIXTURES. Each fixture stores only the JSON SHAPE the research names, with invented values
// (the sources' own values are personal). Sources and read dates (2026-11-06):
//  - minimax_remains: MiniMax-AI/cli `test/fixtures/quota-response.json` + `types/api.ts:352-368`
//    @38aba5f (model_remains[] row, `current_*_remaining_percent`, `current_*_status` 1/2/3).
//  - kimi_usages: MoonshotAI/kimi-code `packages/oauth/src/managed-usage.ts` @bb0c66a and CodexBar
//    `KimiModels.swift` @b3b4d56 (`usage`, `limits[].window/detail`, `usages.*.used_ratio`).
//  - zai_quota_limit: CodexBar `zai.js` and oh-my-pi `zai.ts` (`{code,success,data:{limits[]}}`).
//  - opencode_go_usage: anomalyco/opencode `packages/core/src/usage-limits.ts:156-188` @e42f6d1.
//  - claude_oauth_usage (add-subscription-usage-history): the Claude Code 2.1.319 zod schema and
//    Claude-Code-Usage-Monitor#202 (`five_hour`, `seven_day`, `seven_day_sonnet`,
//    `seven_day_opus`, `extra_usage`); `utilization` 0-100, ISO `resets_at` with microseconds.
//  - chatgpt_wham_usage (add-subscription-usage-history): openai/codex `backend-client/src/
//    types.rs` and the generated OpenAPI models (`rate_limit.{primary,secondary}_window`, plus the
//    `email` / `user_id` / `account_id` fields that must never be kept).
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { POLYROUTER_USER_AGENT } from '@polyrouter/shared/server';
import type { ProviderConfig } from './adapter';
import { ProviderError } from './errors';
import type { HttpClient, HttpResponse } from './http';
import {
  PLAN_USAGE_ANTHROPIC_BETA,
  PLAN_USAGE_PARSER_IDS,
  USAGE_MESSAGES,
  parsePlanUsageBody,
  readPlanUsage,
  type PlanUsageParserId,
  type PlanUsageProbe,
  type PlanUsageReadResult,
} from './plan-usage-read';
import type { PlanUsageObservation, PlanUsageWindow } from './plan-usage';
import { errorResponse, jsonResponse, recordingClient, streamFromChunks } from './testkit.testkit';

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SECRET = 'sk-usage-secret-0123456789';
const iso = (ms: number): string => new Date(ms).toISOString();

const config = (extra: Partial<ProviderConfig> = {}): ProviderConfig => ({
  protocol: 'openai_compatible',
  baseUrl: 'https://api.example.test/v1',
  credential: SECRET,
  kind: 'subscription',
  mode: 'cloud',
  ...extra,
});
const probe = (parser: PlanUsageParserId, extra: Partial<PlanUsageProbe> = {}): PlanUsageProbe => ({
  url: 'https://api.example.test/usage',
  auth: 'bearer',
  parser,
  enabled: true,
  ...extra,
});
const read = (
  parser: PlanUsageParserId,
  client: HttpClient,
  extra: Partial<PlanUsageProbe> = {},
  cfg: ProviderConfig = config(),
): Promise<PlanUsageReadResult> =>
  readPlanUsage(cfg, probe(parser, extra), { httpClient: client, now: () => NOW });
const ok = (r: PlanUsageReadResult): PlanUsageObservation => {
  if (!r.ok) throw new Error(`expected ok, got ${r.kind}: ${r.message}`);
  return r.observation;
};
const win = (o: PlanUsageObservation, key: string): PlanUsageWindow | undefined =>
  o.windows.find((w) => w.key === key);
const body = (parser: PlanUsageParserId, json: unknown): PlanUsageReadResult =>
  parsePlanUsageBody(parser, json, NOW);

// ---- fixtures ----
const minimaxRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  model_name: 'MiniMax-M*',
  start_time: NOW - 2 * HOUR,
  end_time: NOW + 3 * HOUR,
  remains_time: 3 * HOUR,
  current_interval_total_count: 1500,
  current_interval_usage_count: 900,
  current_weekly_total_count: 15000,
  current_weekly_usage_count: 9000,
  weekly_start_time: NOW - DAY,
  weekly_end_time: NOW + 3 * DAY,
  weekly_remains_time: 3 * DAY,
  current_interval_remaining_percent: 40,
  current_weekly_remaining_percent: 70,
  current_interval_status: 1,
  current_weekly_status: 1,
  ...over,
});
const minimaxBody = (rows: unknown[] = [minimaxRow()], code = 0): unknown => ({
  base_resp: { status_code: code, status_msg: 'success' },
  model_remains: rows,
});
const kimiBody = (): unknown => ({
  usage: { limit: '100', used: '30', remaining: '70', resetTime: iso(NOW + 3 * DAY) },
  limits: [
    {
      window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
      detail: { limit: '100', remaining: '25', resetTime: iso(NOW + 2 * HOUR) },
    },
  ],
  usages: { limit_5h: { used_ratio: 0, reset_time: iso(NOW + 2 * HOUR) } },
  user: { membership: { level: 'LEVEL_INTERMEDIATE' } },
});
const zaiBody = (limits?: unknown[]): unknown => ({
  code: 200,
  success: true,
  msg: 'ok',
  data: {
    level: 'pro',
    limits: limits ?? [
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 42, nextResetTime: NOW + 2 * HOUR },
      { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 15, nextResetTime: NOW + 3 * DAY },
      { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 3, nextResetTime: NOW + 20 * DAY },
    ],
  },
});
const opencodeBody = (): unknown => ({
  usage: {
    rolling: { status: 'ok', percent: 12, resetsAt: iso(NOW + 2 * HOUR) },
    weekly: { status: 'ok', percent: 34, resetsAt: iso(NOW + 3 * DAY) },
    monthly: { status: 'ok', percent: 56, resetsAt: iso(NOW + 20 * DAY) },
  },
});

/** Claude's reset form: ISO 8601 with microseconds and a `+00:00` offset. */
const CLAUDE_RESET = '2026-11-06T14:19:59.826592+00:00';
const claudeBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  five_hour: { utilization: 33.0, resets_at: CLAUDE_RESET },
  seven_day: { utilization: 13.0, resets_at: iso(NOW + 3 * DAY) },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 1.0, resets_at: iso(NOW + 3 * DAY) },
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
  ...over,
});
const PERSONAL = {
  email: 'person-7c1@example.test',
  user_id: 'user-9f3a2b7c',
  account_id: 'acct-4e5d6f70',
};
const chatgptWin = (usedPercent: unknown, seconds: unknown, resetAtSec: unknown) => ({
  used_percent: usedPercent,
  limit_window_seconds: seconds,
  reset_after_seconds: 3_600,
  reset_at: resetAtSec,
});
const chatgptBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  plan_type: 'pro',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: chatgptWin(12, 18_000, Math.round((NOW + 2 * HOUR) / 1000)),
    secondary_window: chatgptWin(34, 604_800, Math.round((NOW + 3 * DAY) / 1000)),
  },
  credits: { has_credits: true, unlimited: false, balance: '12.50' },
  rate_limit_reset_credits: { available_count: 2 },
  ...PERSONAL,
  ...over,
});

const FIXTURE: Record<PlanUsageParserId, () => unknown> = {
  minimax_remains: () => minimaxBody(),
  kimi_usages: kimiBody,
  zai_quota_limit: () => zaiBody(),
  opencode_go_usage: opencodeBody,
  claude_oauth_usage: () => claudeBody(),
  chatgpt_wham_usage: () => chatgptBody(),
};

describe('the request: exact headers, GET only, nothing else', () => {
  it.each([
    ['bearer', `Bearer ${SECRET}`],
    ['raw', SECRET],
  ] as const)(
    'sends Authorization (%s), Accept and exactly one polyrouter User-Agent',
    async (auth, header) => {
      const { client, calls } = recordingClient(() => jsonResponse(minimaxBody()));
      ok(await read('minimax_remains', client, { auth }));
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe('https://api.example.test/usage');
      expect(calls[0]!.init.method).toBe('GET');
      expect(calls[0]!.init.body).toBeUndefined();
      expect(calls[0]!.init.headers).toEqual({
        Authorization: header,
        Accept: 'application/json',
        'User-Agent': POLYROUTER_USER_AGENT,
      });
    },
  );

  it.each(['User-Agent', 'user-agent', 'USER-AGENT', 'uSeR-aGeNt'])(
    'an extraHeaders identity User-Agent (%s) never replaces it, and no extra header rides along',
    async (name) => {
      const { client, calls } = recordingClient(() => jsonResponse(minimaxBody()));
      await read(
        'minimax_remains',
        client,
        {},
        config({
          extraHeaders: {
            [name]: 'claude-cli/2.1.319 (external, cli)',
            'X-App': 'cli',
            'HTTP-Referer': 'https://example.test',
          },
        }),
      );
      const headers = calls[0]!.init.headers;
      const uas = Object.entries(headers).filter(([k]) => k.toLowerCase() === 'user-agent');
      expect(uas).toEqual([['User-Agent', POLYROUTER_USER_AGENT]]);
      expect(Object.keys(headers).sort()).toEqual(['Accept', 'Authorization', 'User-Agent']);
    },
  );

  it('source guard: no polyrouter/ literal, and the User-Agent comes from the shared constant', () => {
    const src = fs.readFileSync(path.join(__dirname, 'plan-usage-read.ts'), 'utf8');
    // A string literal that STARTS with the product token (an import path like
    // '@polyrouter/shared/server' starts with '@' and is fine).
    expect(src).not.toMatch(/['"`]polyrouter\//);
    expect(src).toMatch(
      /import\s*{[^}]*POLYROUTER_USER_AGENT[^}]*}\s*from\s*'@polyrouter\/shared\/server'/,
    );
    // Egress only through the guarded transport module.
    expect(src).not.toMatch(/from\s*'undici'|from\s*'node:https?'|\bfetch\(/);
  });
});

describe('bounds and typed failures', () => {
  it('a redirect is refused, never followed (real guarded client, local server)', async () => {
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits += 1;
      if (req.url === '/final') {
        res.end('{}');
        return;
      }
      res.statusCode = 302;
      res.setHeader('location', '/final');
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const r = await readPlanUsage(
        config({ mode: 'selfhosted', kind: 'local' }),
        probe('kimi_usages', { url: `http://127.0.0.1:${String(port)}/usage` }),
        { now: () => NOW },
      );
      expect(r).toMatchObject({
        ok: false,
        kind: 'unavailable',
        message: USAGE_MESSAGES.redirected,
      });
      expect(hits).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });

  it('sends exactly the declared headers on the real wire, even with an identity in extraHeaders', async () => {
    let seen: http.IncomingHttpHeaders = {};
    let method = '';
    const server = http.createServer((req, res) => {
      seen = req.headers;
      method = req.method ?? '';
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(minimaxBody()));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const r = await readPlanUsage(
        config({
          mode: 'selfhosted',
          kind: 'local',
          extraHeaders: { 'user-agent': 'claude-cli/2.1.319', 'x-identity': 'yes' },
        }),
        probe('minimax_remains', { url: `http://127.0.0.1:${String(port)}/usage`, auth: 'raw' }),
        { now: () => NOW },
      );
      ok(r);
      expect(method).toBe('GET');
      expect(seen['authorization']).toBe(SECRET);
      expect(seen['accept']).toBe('application/json');
      expect(seen['user-agent']).toBe(POLYROUTER_USER_AGENT);
      expect(seen['x-identity']).toBeUndefined();
      expect(seen['content-length']).toBeUndefined();
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });

  it('a redirect from the transport maps to a fixed message', async () => {
    const client: HttpClient = () =>
      Promise.reject(
        new ProviderError('unavailable', 'provider redirected (302)', { status: 302 }),
      );
    expect(await read('kimi_usages', client)).toMatchObject({
      ok: false,
      message: USAGE_MESSAGES.redirected,
    });
  });

  it('a body over 64 KiB gives oversized_response and nothing is parsed', async () => {
    const big = 'x'.repeat(70 * 1024);
    const client: HttpClient = () =>
      Promise.resolve({
        ...jsonResponse({}),
        body: streamFromChunks([new TextEncoder().encode(big)]),
      } as HttpResponse);
    expect(await read('zai_quota_limit', client)).toMatchObject({
      ok: false,
      kind: 'oversized_response',
    });
  });

  it('a first-byte stall past the deadline gives unavailable', async () => {
    const client: HttpClient = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const r = await readPlanUsage(config(), probe('kimi_usages'), {
      httpClient: client,
      now: () => NOW,
      timeoutMs: 40,
    });
    expect(r).toMatchObject({ ok: false, kind: 'unavailable', message: USAGE_MESSAGES.timedOut });
  });

  it('a body that stalls after headers gives unavailable', async () => {
    const stalled: HttpClient = () =>
      Promise.resolve({
        ...jsonResponse({}),
        body: new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) }),
      } as HttpResponse);
    const r = await readPlanUsage(config(), probe('kimi_usages'), {
      httpClient: stalled,
      now: () => NOW,
      timeoutMs: 40,
    });
    expect(r).toMatchObject({ ok: false, kind: 'unavailable' });
  });

  it.each([
    [401, 'auth'],
    [403, 'permission'],
    [404, 'unavailable'],
    [429, 'rate_limit'],
    [500, 'unavailable'],
    [503, 'unavailable'],
    [418, 'unavailable'],
  ] as const)('HTTP %i is a typed failure with a fixed message', async (status, kind) => {
    const { client } = recordingClient(() => errorResponse(status, `echo ${SECRET}`));
    const r = await read('zai_quota_limit', client);
    expect(r).toMatchObject({ ok: false, kind });
    if (!r.ok) expect(Object.values(USAGE_MESSAGES)).toContain(r.message);
  });

  it('an unparseable 200 is unavailable', async () => {
    const { client } = recordingClient(() => errorResponse(200, '<html>not json</html>'));
    expect(await read('minimax_remains', client)).toMatchObject({
      ok: false,
      kind: 'unavailable',
      message: USAGE_MESSAGES.unreadable,
    });
  });

  it('a 429 keeps Retry-After relative, from seconds or from an HTTP date', async () => {
    const seconds = recordingClient(() => errorResponse(429, '', { 'retry-after': '900' }));
    expect(await read('zai_quota_limit', seconds.client)).toMatchObject({
      ok: false,
      kind: 'rate_limit',
      retryAfterMs: 900_000,
    });
    const date = new Date(NOW + 600_000).toUTCString();
    const dated = recordingClient(() => errorResponse(429, '', { 'retry-after': date }));
    expect(await read('zai_quota_limit', dated.client)).toMatchObject({
      retryAfterMs: 600_000,
    });
    const none = recordingClient(() => errorResponse(429, ''));
    const r = await read('zai_quota_limit', none.client);
    expect(r).toMatchObject({ ok: false, kind: 'rate_limit' });
    expect(r).not.toHaveProperty('retryAfterMs');
  });

  it('the credential appears in no result, in either auth form', async () => {
    const hostile = {
      base_resp: { status_code: 1004, status_msg: `bad key ${SECRET}` },
      msg: SECRET,
      usage: { echo: SECRET },
    };
    const responders: (() => HttpResponse)[] = [
      () => errorResponse(401, SECRET),
      () => errorResponse(403, SECRET),
      () => errorResponse(429, SECRET, { 'retry-after': SECRET }),
      () => errorResponse(500, SECRET),
      () => errorResponse(200, SECRET),
      () => jsonResponse(hostile),
      () => jsonResponse(minimaxBody()),
    ];
    for (const auth of ['bearer', 'raw'] as const) {
      for (const parser of PLAN_USAGE_PARSER_IDS) {
        for (const responder of responders) {
          const { client } = recordingClient(responder);
          const r = await read(parser, client, { auth });
          expect(JSON.stringify(r)).not.toContain(SECRET);
        }
      }
    }
  });

  it('an SSRF-rejected address sends nothing (real guarded client, injected resolver)', async () => {
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits += 1;
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      for (const resolved of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '::1']) {
        const r = await readPlanUsage(
          config(),
          probe('kimi_usages', { url: `https://usage.example.test:${String(port)}/usage` }),
          { resolve: () => Promise.resolve([resolved]), now: () => NOW },
        );
        expect(r).toMatchObject({
          ok: false,
          kind: 'unavailable',
          message: USAGE_MESSAGES.addressRefused,
        });
      }
      expect(hits).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});

describe('minimax_remains', () => {
  it('reads remaining percents as used = 100 - remaining, with resets from end_time', async () => {
    const { client } = recordingClient(() => jsonResponse(minimaxBody()));
    const o = ok(await read('minimax_remains', client));
    expect(o.billing).toBeNull();
    expect(win(o, 'account:5h')).toMatchObject({
      span: '5h',
      minutes: 300,
      usedPercent: 60,
      reset: { atMs: NOW + 3 * HOUR },
    });
    expect(win(o, 'account:weekly')).toMatchObject({
      span: 'weekly',
      usedPercent: 30,
      reset: { atMs: NOW + 3 * DAY },
    });
  });

  it('a non-zero base_resp fails even with HTTP 200; 2062 is plan_inactive', () => {
    expect(body('minimax_remains', minimaxBody([], 1004))).toMatchObject({
      ok: false,
      kind: 'unavailable',
    });
    expect(body('minimax_remains', minimaxBody([minimaxRow()], 2062))).toMatchObject({
      ok: false,
      kind: 'plan_inactive',
    });
    expect(body('minimax_remains', { model_remains: [minimaxRow()] })).toMatchObject({ ok: false });
  });

  it('a remaining value over 100 reads an unknown percent, never used 0 (the spec example)', () => {
    const o = ok(
      body(
        'minimax_remains',
        minimaxBody([
          minimaxRow({
            current_interval_remaining_percent: 40,
            current_weekly_remaining_percent: 150,
            weekly_end_time: undefined,
            weekly_boost_permille: 500,
          }),
        ]),
      ),
    );
    expect(win(o, 'account:5h')!.usedPercent).toBe(60);
    const weekly = win(o, 'account:weekly');
    expect(weekly).toBeDefined();
    expect(weekly!.usedPercent).toBeNull();
    expect(weekly!.usedPercent).not.toBe(0);
  });

  it('never derives a percent from the ambiguous usage counts', () => {
    const o = ok(
      body(
        'minimax_remains',
        minimaxBody([
          minimaxRow({
            current_interval_remaining_percent: undefined,
            current_weekly_remaining_percent: undefined,
          }),
        ]),
      ),
    );
    expect(o.windows.every((w) => w.usedPercent === null)).toBe(true);
  });

  it('skips status-3 rows and prefers the text model row', () => {
    const outside = minimaxRow({
      model_name: 'speech-hd',
      current_interval_total_count: 0,
      current_weekly_total_count: 0,
      current_interval_status: 3,
      current_weekly_status: 3,
      current_interval_remaining_percent: 100,
      current_weekly_remaining_percent: 100,
    });
    const other = minimaxRow({
      model_name: 'image-01',
      current_interval_remaining_percent: 10,
      current_weekly_remaining_percent: 10,
    });
    const text = minimaxRow();
    expect(
      win(ok(body('minimax_remains', minimaxBody([outside, other, text]))), 'account:5h')!
        .usedPercent,
    ).toBe(60);
    // No text row: the first row that is not status 3.
    expect(
      win(ok(body('minimax_remains', minimaxBody([outside, other]))), 'account:5h')!.usedPercent,
    ).toBe(90);
    // Only status-3 rows: no plan usage.
    expect(body('minimax_remains', minimaxBody([outside]))).toMatchObject({
      ok: false,
      kind: 'plan_inactive',
      message: USAGE_MESSAGES.noPlanUsage,
    });
  });

  it('a window whose own status is 3 (unlimited) is omitted', () => {
    const o = ok(body('minimax_remains', minimaxBody([minimaxRow({ current_weekly_status: 3 })])));
    expect(win(o, 'account:weekly')).toBeUndefined();
    expect(win(o, 'account:5h')).toBeDefined();
  });
});

describe('kimi_usages', () => {
  it('reads limits[].detail counters and ignores used_ratio (the spec example)', () => {
    const o = ok(body('kimi_usages', kimiBody()));
    expect(win(o, 'account:5h')).toMatchObject({
      span: '5h',
      minutes: 300,
      usedPercent: 75,
      reset: { atMs: NOW + 2 * HOUR },
    });
    // used_ratio (0) never produced a window.
    expect(o.windows.map((w) => w.key).sort()).toEqual(['account:5h', 'account:summary']);
    expect(o.billing).toBeNull();
  });

  it('the usage summary is unlabelled: span null and minutes null', () => {
    const summary = win(ok(body('kimi_usages', kimiBody())), 'account:summary')!;
    expect(summary.span).toBeNull();
    expect(summary.minutes).toBeNull();
    expect(summary.usedPercent).toBe(30);
    expect(summary.reset).toEqual({ atMs: NOW + 3 * DAY });
  });

  it('derives a missing count either way, and accepts numbers and strings', () => {
    const w = (detail: Record<string, unknown>): PlanUsageWindow | undefined =>
      win(
        ok(
          body('kimi_usages', {
            limits: [{ window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' }, detail }],
          }),
        ),
        'account:5h',
      );
    expect(w({ limit: '200', used: '50' })!.usedPercent).toBe(25);
    expect(w({ limit: 200, remaining: 50 })!.usedPercent).toBe(75);
    expect(w({ limit: '100', used: '500' })!.usedPercent).toBe(100);
    // `remaining` of 0 is a real 100% and `remaining == limit` a real 0%.
    expect(w({ limit: 100, remaining: 0 })!.usedPercent).toBe(100);
    expect(w({ limit: 100, remaining: 100 })!.usedPercent).toBe(0);
    // `remaining` above `limit` is unreadable: never a fabricated 0%. With a reset the window
    // keeps only the reset; without one the window is dropped.
    const over = w({ limit: 100, remaining: 150, resetTime: iso(NOW + HOUR) })!;
    expect(over.usedPercent).toBeNull();
    expect(over.reset).not.toBeNull();
    expect(
      body('kimi_usages', {
        limits: [
          {
            window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' },
            detail: { limit: 100, remaining: 150 },
          },
        ],
      }),
    ).toMatchObject({ ok: false, message: USAGE_MESSAGES.unrecognised });
    // No limit: no percent, and with no reset either the window is dropped (nothing readable).
    expect(
      body('kimi_usages', {
        limits: [{ window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' }, detail: { used: '5' } }],
      }),
    ).toMatchObject({ ok: false, message: USAGE_MESSAGES.unrecognised });
  });

  it('an epoch-seconds resetTime is read, and an implausible one is dropped', () => {
    const o = ok(
      body('kimi_usages', {
        usage: { limit: 10, used: 1, resetTime: Math.round((NOW + DAY) / 1000) },
        limits: [
          {
            window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
            detail: { limit: 10, used: 1, resetTime: NOW * 1000 },
          },
        ],
      }),
    );
    expect(win(o, 'account:summary')!.reset).toEqual({
      atMs: Math.round((NOW + DAY) / 1000) * 1000,
    });
    expect(win(o, 'account:5h')!.reset).toBeNull();
  });

  it('{} is "no plan usage", never 0%', () => {
    expect(body('kimi_usages', {})).toMatchObject({
      ok: false,
      kind: 'plan_inactive',
      message: USAGE_MESSAGES.noPlanUsage,
    });
  });

  it('a body with nothing readable is unrecognised, not 0%', () => {
    expect(body('kimi_usages', { usages: { limit_5h: { used_ratio: 0 } } })).toMatchObject({
      ok: false,
      message: USAGE_MESSAGES.unrecognised,
    });
  });

  it('a 403 is stated as ambiguous, never as a rejected key or User-Agent', async () => {
    const { client } = recordingClient(() =>
      errorResponse(403, '{"error":{"message":"forbidden"}}'),
    );
    const r = await read('kimi_usages', client);
    expect(r).toMatchObject({ ok: false, kind: 'permission', message: USAGE_MESSAGES.refusedKimi });
    if (!r.ok) {
      expect(r.message).toMatch(/plan may be used up/);
      expect(r.message).toMatch(/key may lack access/);
      expect(r.message).not.toMatch(/user-agent|rejected|invalid/i);
    }
  });
});

describe('zai_quota_limit', () => {
  it('maps only units 3 (hours) and 6 (weeks)', () => {
    const o = ok(body('zai_quota_limit', zaiBody()));
    expect(o.windows.map((w) => w.key).sort()).toEqual(['account:5h', 'account:weekly']);
    expect(win(o, 'account:5h')).toMatchObject({ usedPercent: 42, minutes: 300 });
    expect(win(o, 'account:weekly')).toMatchObject({ usedPercent: 15, minutes: 10_080 });
    expect(o.billing).toBeNull();
  });

  it('a 5-hour reset more than five hours and one minute ahead is discarded, never re-zoned', () => {
    const at = (offset: number): PlanUsageWindow | undefined =>
      win(
        ok(
          body(
            'zai_quota_limit',
            zaiBody([{ unit: 3, number: 5, percentage: 20, nextResetTime: NOW + offset }]),
          ),
        ),
        'account:5h',
      );
    expect(at(5 * HOUR)!.reset).toEqual({ atMs: NOW + 5 * HOUR });
    expect(at(5 * HOUR + 60_000)!.reset).toEqual({ atMs: NOW + 5 * HOUR + 60_000 });
    const late = at(5 * HOUR + 120_000)!;
    expect(late.reset).toBeNull();
    expect(late.usedPercent).toBe(20);
    // An 8-hour-off zone slip is likewise dropped, not corrected.
    expect(at(13 * HOUR)!.reset).toBeNull();
  });

  it('success:false or a non-200 code fails', () => {
    expect(body('zai_quota_limit', { code: 500, success: false, msg: 'x' })).toMatchObject({
      ok: false,
    });
    expect(
      body('zai_quota_limit', { code: 200, success: false, data: { limits: [] } }),
    ).toMatchObject({
      ok: false,
    });
    expect(
      body('zai_quota_limit', { code: 500, success: true, data: { limits: [] } }),
    ).toMatchObject({
      ok: false,
    });
  });

  it('only unpinned units reads as no plan usage', () => {
    expect(
      body(
        'zai_quota_limit',
        zaiBody([{ unit: 5, number: 1, percentage: 9, nextResetTime: NOW + DAY }]),
      ),
    ).toMatchObject({ ok: false, message: USAGE_MESSAGES.noPlanUsage });
  });
});

describe('opencode_go_usage', () => {
  it('reads the rolling, weekly and monthly windows', () => {
    const o = ok(body('opencode_go_usage', opencodeBody()));
    expect(o.windows.map((w) => [w.span, w.usedPercent])).toEqual([
      ['5h', 12],
      ['weekly', 34],
      ['monthly', 56],
    ]);
    expect(win(o, 'account:5h')!.reset).toEqual({ atMs: NOW + 2 * HOUR });
    expect(o.billing).toBeNull();
  });

  it('a 403 is stated as ambiguous (no Go plan, or no Usage > Read)', async () => {
    const { client } = recordingClient(() => errorResponse(403, ''));
    const r = await read('opencode_go_usage', client);
    expect(r).toMatchObject({
      ok: false,
      kind: 'permission',
      message: USAGE_MESSAGES.refusedOpencodeGo,
    });
    if (!r.ok) {
      expect(r.message).toMatch(/no Go plan/);
      expect(r.message).toMatch(/Usage/);
    }
  });
});

describe('claude_oauth_usage (add-subscription-usage-history)', () => {
  it('utilization 1.0 reads 1%, never 100%, and a null seven_day_opus is dropped (the spec example)', () => {
    const o = ok(
      body('claude_oauth_usage', {
        five_hour: { utilization: 1.0, resets_at: CLAUDE_RESET },
        seven_day_opus: null,
      }),
    );
    expect(o.windows).toEqual([
      {
        key: 'account:5h',
        group: 'account',
        span: '5h',
        minutes: 300,
        scope: null,
        usedPercent: 1,
        reset: { atMs: Date.parse('2026-11-06T14:19:59.826Z') },
      },
    ]);
    expect(win(o, 'account:weekly:Opus')).toBeUndefined();
  });

  it('reads the four windows it knows, with their scopes, and nothing else', () => {
    const o = ok(body('claude_oauth_usage', claudeBody()));
    expect(o.windows.map((w) => [w.key, w.span, w.scope, w.usedPercent])).toEqual([
      ['account:5h', '5h', null, 33],
      ['account:weekly', 'weekly', null, 13],
      ['account:weekly:Sonnet', 'weekly', 'Sonnet', 1],
    ]);
    // The same keys as the passive header parser for the same windows, so they merge.
    expect(win(o, 'account:weekly')!.reset).toEqual({ atMs: NOW + 3 * DAY });
    expect(o.billing).toBeNull();
    // An Opus window, when present, is its own scoped window.
    const opus = ok(
      body(
        'claude_oauth_usage',
        claudeBody({ seven_day_opus: { utilization: 70, resets_at: iso(NOW + DAY) } }),
      ),
    );
    expect(win(opus, 'account:weekly:Opus')).toMatchObject({ scope: 'Opus', usedPercent: 70 });
  });

  it('extra_usage enabled with used credits sets the billing state, and no amount is kept', () => {
    const o = ok(
      body(
        'claude_oauth_usage',
        claudeBody({
          extra_usage: {
            is_enabled: true,
            monthly_limit: 50_017,
            used_credits: 12_345,
            utilization: 24.68,
            currency: 'EUR',
          },
        }),
      ),
    );
    expect(o.billing).toBe('extra_usage');
    const text = JSON.stringify(o);
    for (const amount of ['50017', '12345', '24.68', 'EUR']) expect(text).not.toContain(amount);
    // Disabled, or enabled with no used credits: the body says nothing about billing.
    for (const extra of [
      { is_enabled: false, used_credits: 12_345 },
      { is_enabled: true, used_credits: null },
      { is_enabled: 'true', used_credits: 5 },
      null,
    ]) {
      expect(ok(body('claude_oauth_usage', claudeBody({ extra_usage: extra }))).billing).toBeNull();
    }
  });

  it('an unknown shape reads as unknown, never 0%', () => {
    for (const json of [
      {},
      { five_hour: null, seven_day: null },
      { five_hour: { utilization: null, resets_at: null } },
      { five_hour: { utilization: 'lots', resets_at: 'tomorrow' } },
      { limits: [{ kind: 'session', percent: 40 }] },
    ]) {
      expect(body('claude_oauth_usage', json)).toEqual({
        ok: false,
        kind: 'unavailable',
        message: USAGE_MESSAGES.unrecognised,
      });
    }
    // A window with only a reset keeps an unknown percent.
    const o = ok(
      body('claude_oauth_usage', { five_hour: { utilization: null, resets_at: CLAUDE_RESET } }),
    );
    expect(win(o, 'account:5h')!.usedPercent).toBeNull();
  });
});

describe('chatgpt_wham_usage (add-subscription-usage-history)', () => {
  it('reads windows by length, clamps 112 to 100, and drops the account fields (the spec example)', () => {
    const r = body(
      'chatgpt_wham_usage',
      chatgptBody({
        rate_limit: {
          primary_window: chatgptWin(112, 18_000, Math.round((NOW + 2 * HOUR) / 1000)),
          secondary_window: chatgptWin(40, 604_800, Math.round((NOW + 3 * DAY) / 1000)),
        },
      }),
    );
    const o = ok(r);
    expect(o.windows.map((w) => [w.key, w.span, w.minutes, w.usedPercent, w.reset])).toEqual([
      ['account:5h', '5h', 300, 100, { atMs: NOW + 2 * HOUR }],
      ['account:weekly', 'weekly', 10_080, 40, { atMs: NOW + 3 * DAY }],
    ]);
    const text = JSON.stringify(r);
    for (const value of Object.values(PERSONAL)) expect(text).not.toContain(value);
    expect(text).not.toMatch(/pro|12\.50|available_count/);
    expect(o.billing).toBeNull();
  });

  it('a lone weekly window in the primary slot reads weekly, never 5h', () => {
    const o = ok(
      body(
        'chatgpt_wham_usage',
        chatgptBody({
          rate_limit: {
            primary_window: chatgptWin(7, 604_800, Math.round((NOW + 3 * DAY) / 1000)),
            secondary_window: null,
          },
        }),
      ),
    );
    expect(o.windows.map((w) => w.key)).toEqual(['account:weekly']);
  });

  it('reset_after_seconds is the fallback reset; an unsized window keeps its minutes', () => {
    const o = ok(
      body('chatgpt_wham_usage', {
        rate_limit: {
          primary_window: {
            used_percent: 5,
            limit_window_seconds: 5_400,
            reset_after_seconds: 600,
          },
        },
      }),
    );
    expect(o.windows).toEqual([
      {
        key: 'account:m90',
        group: 'account',
        span: null,
        minutes: 90,
        scope: null,
        usedPercent: 5,
        reset: { inMs: 600_000 },
      },
    ]);
  });

  it('an unknown shape reads as unknown, and no window is "no plan usage", never 0%', () => {
    for (const json of [{}, { rate_limit: null }, { rate_limit: 'x' }, PERSONAL]) {
      expect(body('chatgpt_wham_usage', json)).toMatchObject({
        ok: false,
        message: USAGE_MESSAGES.unrecognised,
      });
    }
    expect(
      body('chatgpt_wham_usage', {
        rate_limit: { primary_window: null, secondary_window: { used_percent: null } },
      }),
    ).toEqual({ ok: false, kind: 'plan_inactive', message: USAGE_MESSAGES.noPlanUsage });
  });
});

describe('extra headers: a closed allowlist, values from constants and the row (add-subscription-usage-history)', () => {
  const CLAUDE_URL = 'https://api.anthropic.com/api/oauth/usage';
  const CHATGPT_URL = 'https://chatgpt.com/backend-api/wham/usage';

  it('a Claude read carries exactly Bearer, Accept, polyrouter UA and the fixed oauth beta, on the plain path', async () => {
    const { client, calls } = recordingClient(() => jsonResponse(claudeBody()));
    ok(
      await read(
        'claude_oauth_usage',
        client,
        { url: CLAUDE_URL, extraHeaders: ['anthropic-beta'] },
        config({
          oauthBeta: 'some-other-beta',
          extraHeaders: { 'User-Agent': 'claude-cli/2.1.319 (external, cli)', 'X-App': 'cli' },
        }),
      ),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(CLAUDE_URL);
    expect(calls[0]!.url).not.toContain('?');
    expect(calls[0]!.init.headers).toEqual({
      Authorization: `Bearer ${SECRET}`,
      Accept: 'application/json',
      'anthropic-beta': PLAN_USAGE_ANTHROPIC_BETA,
      'User-Agent': POLYROUTER_USER_AGENT,
    });
    expect(PLAN_USAGE_ANTHROPIC_BETA).toBe('oauth-2025-04-20');
  });

  it('a ChatGPT read carries exactly Bearer, Accept, polyrouter UA and the row account id', async () => {
    const { client, calls } = recordingClient(() => jsonResponse(chatgptBody()));
    ok(
      await read(
        'chatgpt_wham_usage',
        client,
        { url: CHATGPT_URL, extraHeaders: ['chatgpt-account-id'] },
        config({ oauthAccountId: 'acct-row-1', extraHeaders: { originator: 'codex_cli_rs' } }),
      ),
    );
    expect(calls[0]!.url).toBe(CHATGPT_URL);
    const headers = calls[0]!.init.headers;
    expect(headers).toEqual({
      Authorization: `Bearer ${SECRET}`,
      Accept: 'application/json',
      'chatgpt-account-id': 'acct-row-1',
      'User-Agent': POLYROUTER_USER_AGENT,
    });
    const names = Object.keys(headers).map((k) => k.toLowerCase());
    expect(names).not.toContain('originator');
    expect(names).not.toContain('x-openai-codex-luna-reserve');
    expect(names).not.toContain('openai-beta');
  });

  it('a missing or header-unsafe account id sends nothing', async () => {
    for (const oauthAccountId of [undefined, '', 'acct\r\nX-Evil: 1', 'a'.repeat(129)]) {
      const { client, calls } = recordingClient(() => jsonResponse(chatgptBody()));
      const r = await read(
        'chatgpt_wham_usage',
        client,
        { url: CHATGPT_URL, extraHeaders: ['chatgpt-account-id'] },
        config(oauthAccountId === undefined ? {} : { oauthAccountId }),
      );
      expect(r).toEqual({ ok: false, kind: 'credential', message: USAGE_MESSAGES.noAccountId });
      expect(calls).toHaveLength(0);
    }
  });

  it('a probe that names no extra header sends none, whatever the config carries', async () => {
    const { client, calls } = recordingClient(() => jsonResponse(chatgptBody()));
    ok(
      await read(
        'chatgpt_wham_usage',
        client,
        {},
        config({ oauthAccountId: 'acct-row-1', oauthBeta: 'oauth-2025-04-20' }),
      ),
    );
    expect(Object.keys(calls[0]!.init.headers).sort()).toEqual([
      'Accept',
      'Authorization',
      'User-Agent',
    ]);
  });
});

describe('every parser', () => {
  it('discards an implausible reset and keeps the window with an unknown reset', () => {
    const FAR = NOW + 900 * DAY;
    const cases: Record<PlanUsageParserId, unknown> = {
      minimax_remains: minimaxBody([
        minimaxRow({ end_time: FAR, weekly_end_time: Math.round(NOW / 1000) }),
      ]),
      kimi_usages: {
        usage: { limit: 10, used: 1, resetTime: iso(FAR) },
        limits: [
          {
            window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
            detail: { limit: 10, used: 1, resetTime: iso(NOW + 2 * DAY) },
          },
        ],
      },
      zai_quota_limit: zaiBody([
        { unit: 3, number: 5, percentage: 20, nextResetTime: FAR },
        { unit: 6, number: 1, percentage: 20, nextResetTime: NOW * 1000 },
      ]),
      opencode_go_usage: {
        usage: {
          rolling: { percent: 10, resetsAt: iso(FAR) },
          weekly: { percent: 10, resetsAt: iso(NOW + 30 * DAY) },
          monthly: { percent: 10, resetsAt: iso(NOW - 2 * DAY) },
        },
      },
      claude_oauth_usage: {
        five_hour: { utilization: 10, resets_at: iso(FAR) },
        seven_day: { utilization: 10, resets_at: iso(NOW - 2 * DAY) },
      },
      chatgpt_wham_usage: {
        rate_limit: {
          primary_window: chatgptWin(10, 18_000, Math.round(FAR / 1000)),
          // Milliseconds in a seconds field land far beyond the bound.
          secondary_window: chatgptWin(10, 604_800, NOW),
        },
      },
    };
    for (const parser of PLAN_USAGE_PARSER_IDS) {
      const o = ok(body(parser, cases[parser]));
      expect(o.windows.length).toBeGreaterThan(0);
      for (const w of o.windows) {
        expect(w.reset).toBeNull();
        expect(w.usedPercent).not.toBeNull();
      }
    }
  });

  it('never throws on hostile input and never reads 0% from nothing', () => {
    const hostile: unknown[] = [
      null,
      undefined,
      1,
      'x',
      [],
      {},
      { usage: null },
      { data: { limits: 'x' } },
    ];
    for (const parser of PLAN_USAGE_PARSER_IDS) {
      for (const h of hostile) {
        const r = body(parser, h);
        if (r.ok) expect(r.observation.windows.every((w) => w.usedPercent !== 0)).toBe(true);
      }
    }
  });

  it.each(PLAN_USAGE_PARSER_IDS)('%s parses its fixture through the full read', async (parser) => {
    const { client } = recordingClient(() => jsonResponse(FIXTURE[parser]()));
    const o = ok(await read(parser, client));
    expect(o.windows.length).toBeGreaterThan(0);
    expect(o.billing).toBeNull();
  });
});
