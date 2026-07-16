import type { Channel, Limit, Tier } from '../types';

/** Simulated seeds for the still-deferred config pages (#20: routing/limits/
 * notifications). The Observe pages (overview/costs/requests) are now real and no
 * longer read seeds. Pages consume these through the state/data boundary so #20
 * swaps them without touching JSX. */

export const SEED_TIERS: Tier[] = [
  {
    key: 'default',
    desc: 'Serves everything unless told otherwise',
    chain: ['gpt-5.2-mini', 'deepseek-v3.2', 'claude-sonnet-4.5'],
  },
  {
    key: 'heavy',
    desc: 'Hard reasoning & long generations',
    chain: ['claude-sonnet-4.5', 'claude-opus-4.6', 'gpt-5.2'],
  },
  {
    key: 'background',
    desc: 'Bulk / non-urgent — free first',
    chain: ['llama3.3:70b', 'qwen3-coder-30b', 'deepseek-v3.2'],
  },
];

export const SEED_RULES = [
  { id: 1, value: 'heavy', target: 'tier heavy' },
  { id: 2, value: 'background', target: 'tier background' },
];

export const SEED_LIMITS: Limit[] = [
  {
    id: 1,
    scope: 'Global',
    threshold: 10,
    window: 'day',
    action: 'alert',
    current: 4.12,
    note: 'notifies: homelab email, ntfy push',
  },
  {
    id: 2,
    scope: 'Agent · openclaw',
    threshold: 25,
    window: 'week',
    action: 'block',
    current: 9.84,
    note: 'hard stop — requests rejected at limit',
  },
  {
    id: 3,
    scope: 'Global',
    threshold: 80,
    window: 'month',
    action: 'alert',
    current: 61.48,
    note: 'notifies: homelab email',
  },
];

export const SEED_CHANNELS: Channel[] = [
  {
    id: 1,
    name: 'homelab email',
    kind: 'smtp',
    enabled: true,
    detail: 'smtp.fastmail.com · to admin@izzo.one',
    last: 'test ok · 2d ago',
    lastOk: true,
    testing: false,
  },
  {
    id: 2,
    name: 'ntfy push',
    kind: 'apprise',
    enabled: true,
    detail: 'ntfy://homelab/polyrouter',
    last: 'test ok · 5h ago',
    lastOk: true,
    testing: false,
  },
];
