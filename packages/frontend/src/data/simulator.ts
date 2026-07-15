import type { DecisionLayer, FeatureRow, RequestStatus, RoutedRequest, TraceStep } from '../types';
import { AGENTS_POOL, catalogEntry } from './catalog';

/** Simulated request generator ported 1:1 from the design prototype. This is
 * demo data — the request-logging change replaces this module's consumers
 * with the real RequestLog API without touching page components. */

let seq = 0;

const R = Math.random;
const pick = <T>(a: readonly T[]): T => {
  const item = a[Math.floor(R() * a.length)];
  if (item === undefined) throw new Error('pick from empty list');
  return item;
};

function featMk(chars: number, code: number, tools: number, depth: number): FeatureRow[] {
  return [
    { k: 'eff. input', v: `${chars.toLocaleString()} chars` },
    { k: 'boilerplate cut', v: `−${(5800 + Math.floor(R() * 900)).toLocaleString()} chars` },
    { k: 'system fp', v: 'a91f…c2 · seen 412×' },
    { k: 'code blocks', v: String(code) },
    { k: 'tool defs', v: String(tools) },
    { k: 'conv. depth', v: String(depth) },
  ];
}

export function generateRequest(ts: number): RoutedRequest {
  const roll = R();
  let m: string;
  let tier: string;
  let layer: DecisionLayer;
  let steps: TraceStep[];
  let feat: FeatureRow[] | null = null;
  let status: RequestStatus = 'ok';
  let escalated = false;
  let reason: string;
  const agent = pick(AGENTS_POOL);

  if (roll < 0.34) {
    m = 'gpt-5.2-mini';
    tier = 'default';
    layer = 'structural';
    feat = featMk(900 + Math.floor(R() * 2200), R() < 0.3 ? 1 : 0, 3, 2 + Math.floor(R() * 6));
    steps = [
      {
        k: 'L0',
        title: 'Explicit — passed through',
        s: 'pass',
        d: 'model = "auto"; no x-polyrouter-tier header.',
      },
      {
        k: 'L1',
        title: 'Structural — decided',
        s: 'hit',
        d: 'Low complexity after baseline subtraction → tier default.',
      },
      {
        k: 'L3',
        title: 'Cascade — skipped',
        s: 'skip',
        d: 'L1 was confident; no cheap-first trial needed.',
      },
      {
        k: '✓',
        title: 'Served by primary',
        s: 'ok',
        d: 'default → gpt-5.2-mini @ OpenAI (healthy, 1st in chain).',
      },
    ];
    reason = 'auto → L1 low complexity → default';
  } else if (roll < 0.52) {
    m = 'claude-sonnet-4.5';
    tier = 'default';
    layer = 'explicit';
    steps = [
      {
        k: 'L0',
        title: 'Explicit — decided',
        s: 'hit',
        d: 'Request named claude-sonnet-4.5. Explicit always wins; smart layers never ran.',
      },
      {
        k: '✓',
        title: 'Served directly',
        s: 'ok',
        d: 'Anthropic healthy → forwarded as-is, streamed back.',
      },
    ];
    reason = 'explicit model id';
  } else if (roll < 0.68) {
    m = pick(['llama3.3:70b', 'qwen3-coder-30b']);
    tier = 'background';
    layer = 'header';
    steps = [
      {
        k: 'L0',
        title: 'Header — decided',
        s: 'hit',
        d: 'x-polyrouter-tier: background → routing rule matched.',
      },
      {
        k: '✓',
        title: 'Served by primary',
        s: 'ok',
        d: `background → ${m} @ Ollama (local, $0).`,
      },
    ];
    reason = 'x-polyrouter-tier: background';
  } else if (roll < 0.82) {
    m = 'deepseek-v3.2';
    tier = 'default';
    layer = 'structural';
    feat = featMk(2400 + Math.floor(R() * 3000), 1, 5, 4 + Math.floor(R() * 8));
    steps = [
      {
        k: 'L0',
        title: 'Explicit — passed through',
        s: 'pass',
        d: 'model = "auto"; no tier header.',
      },
      {
        k: 'L1',
        title: 'Structural — decided',
        s: 'hit',
        d: 'Code present, mid size → default; cheapest healthy pick.',
      },
      {
        k: '✓',
        title: 'Served by fallback #2',
        s: 'ok',
        d: 'Primary skipped (circuit half-open on OpenRouter) → deepseek-v3.2.',
      },
    ];
    reason = 'auto → L1 → default (fallback #2)';
  } else if (roll < 0.92) {
    m = 'claude-opus-4.6';
    tier = 'heavy';
    layer = 'escalated';
    escalated = true;
    feat = featMk(6800 + Math.floor(R() * 4000), 2, 8, 11);
    steps = [
      {
        k: 'L0',
        title: 'Explicit — passed through',
        s: 'pass',
        d: 'model = "auto"; no tier header.',
      },
      {
        k: 'L1',
        title: 'Structural — ambiguous',
        s: 'warn',
        d: 'Mid-band score; cascade eligible (cheap to retry).',
      },
      {
        k: 'L3',
        title: 'Cascade — escalated',
        s: 'warn',
        d: 'Tried kimi-k2 first → output failed JSON-schema check → escalate.',
      },
      {
        k: '✓',
        title: 'Served by heavy tier',
        s: 'ok',
        d: 'heavy → claude-opus-4.6 @ Claude Max (subscription quota OK).',
      },
    ];
    reason = 'auto → L3 cascade escalation';
  } else {
    m = 'gpt-5.2-mini';
    tier = 'default';
    layer = 'structural';
    status = 'fallback';
    feat = featMk(1100 + Math.floor(R() * 1500), 0, 2, 3);
    steps = [
      {
        k: 'L0',
        title: 'Explicit — passed through',
        s: 'pass',
        d: 'model = "auto"; no tier header.',
      },
      {
        k: 'L1',
        title: 'Structural — decided',
        s: 'hit',
        d: 'Low complexity → tier default.',
      },
      {
        k: '✗',
        title: 'Primary failed pre-commit',
        s: 'err',
        d: 'gemini-3-flash @ OpenRouter → 429 before first token. Circuit opened; safe to fall back.',
      },
      {
        k: '✓',
        title: 'Served by fallback #2',
        s: 'ok',
        d: 'gpt-5.2-mini @ OpenAI succeeded. Client saw one clean stream.',
      },
    ];
    reason = 'L1 → default; primary 429 → fallback #2';
  }

  const c = catalogEntry(m);
  const tin = 300 + Math.floor(R() * 9000);
  const tout = 60 + Math.floor(R() * 1800);
  const cost = (tin / 1e6) * c.inP + (tout / 1e6) * c.outP;
  const ms = 700 + Math.floor(R() * (layer === 'escalated' ? 6500 : 3600));
  return {
    id: `poly_req_${(seq++).toString(36).padStart(4, '0')}${Math.floor(R() * 1296).toString(36)}`,
    ts,
    agent,
    model: m,
    provider: c.p,
    tag: c.tag,
    tier,
    layer,
    status,
    escalated,
    reason,
    steps,
    feat,
    tin,
    tout,
    inPrice: c.inP,
    outPrice: c.outP,
    cost,
    ms,
    ttfb: Math.floor(ms * (0.25 + R() * 0.3)),
    routeMs: layer === 'explicit' || layer === 'header' ? 0 : 1,
    estimated: R() < 0.06,
  };
}

export function seedRequests(count: number): RoutedRequest[] {
  const reqs: RoutedRequest[] = [];
  let t = Date.now();
  for (let i = 0; i < count; i++) {
    t -= 2000 + Math.random() * 9000;
    reqs.push(generateRequest(t));
  }
  return reqs;
}

export function mintKey(): string {
  const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let k = 'poly_';
  for (let i = 0; i < 32; i++) k += abc[Math.floor(Math.random() * abc.length)];
  return k;
}
