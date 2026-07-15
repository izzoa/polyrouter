import type { ModelTag, RoutedRequest } from '../types';

/** Simulated model catalog with unit prices ($ per 1M tokens). The real
 * catalog arrives with the pricing-catalog change; pages never read this
 * directly — everything flows through the state/data boundary. */
export interface CatalogEntry {
  p: string;
  tag: ModelTag;
  inP: number;
  outP: number;
}

export const CATALOG: Record<string, CatalogEntry> = {
  'gpt-5.2-mini': { p: 'OpenAI', tag: null, inP: 0.35, outP: 1.4 },
  'gpt-5.2': { p: 'OpenAI', tag: null, inP: 1.75, outP: 14 },
  'claude-sonnet-4.5': { p: 'Anthropic', tag: null, inP: 3, outP: 15 },
  'claude-opus-4.6': { p: 'Claude Max', tag: 'sub', inP: 0, outP: 0 },
  'deepseek-v3.2': { p: 'DeepSeek', tag: null, inP: 0.14, outP: 0.28 },
  'kimi-k2': { p: 'Moonshot', tag: null, inP: 0.55, outP: 2.2 },
  'llama3.3:70b': { p: 'Ollama', tag: 'local', inP: 0, outP: 0 },
  'qwen3-coder-30b': { p: 'Ollama', tag: 'local', inP: 0, outP: 0 },
  'gemini-3-flash': { p: 'OpenRouter', tag: null, inP: 0.3, outP: 1.2 },
};

export const AGENTS_POOL = ['openclaw', 'vscode-continue', 'cron-summarizer', 'research-notebook'];

export const BASE_URL = 'http://127.0.0.1:3001/v1';

export function catalogEntry(model: string): CatalogEntry {
  const entry = CATALOG[model];
  if (!entry) throw new Error(`Unknown model in simulated catalog: ${model}`);
  return entry;
}

export function priceOf(model: string): string {
  const c = catalogEntry(model);
  if (c.tag === 'local') return 'free';
  if (c.tag === 'sub') return 'sub quota';
  return `$${String(c.inP)} / $${String(c.outP)} per 1M`;
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n);
}

/** Formats from the request's own snapshot fields — never the mutable catalog,
 * so rows from providers outside the bundled catalog render fine. */
export function fmtCost(r: RoutedRequest): string {
  if (r.tag === 'local') return 'free';
  if (r.tag === 'sub') return '$0.00';
  return `$${r.cost.toFixed(4)}`;
}
