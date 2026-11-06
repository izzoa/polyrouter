import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { POLYROUTER_USER_AGENT, findUserAgent, withUserAgent } from '../src/server';

const FRONTEND_VERSION = (
  JSON.parse(readFileSync(new URL('../../frontend/package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

describe('POLYROUTER_USER_AGENT (outbound-user-agent)', () => {
  it('is polyrouter/ plus the frontend release version, as a bare product token', () => {
    expect(POLYROUTER_USER_AGENT).toBe(`polyrouter/${FRONTEND_VERSION}`);
    expect(POLYROUTER_USER_AGENT).not.toMatch(/[ (]|https?:|undici|node/i);
  });

  it('is not changed by the environment', async () => {
    process.env.POLYROUTER_USER_AGENT = 'evil/9';
    vi.resetModules();
    try {
      const mod = await import('../src/server/outbound-user-agent');
      expect(mod.POLYROUTER_USER_AGENT).toBe(`polyrouter/${FRONTEND_VERSION}`);
    } finally {
      delete process.env.POLYROUTER_USER_AGENT;
    }
  });
});

describe('withUserAgent', () => {
  it('replaces every case variant, keeps other keys, and does not mutate its input', () => {
    for (const key of ['user-agent', 'USER-AGENT', 'User-Agent']) {
      const input = { [key]: 'old', 'x-custom': 'v1' };
      const snapshot = { ...input };
      const out = withUserAgent(input, 'new/1');
      expect(Object.keys(out).filter((k) => k.toLowerCase() === 'user-agent')).toEqual([
        'User-Agent',
      ]);
      expect(out['User-Agent']).toBe('new/1');
      expect(out['x-custom']).toBe('v1');
      expect(input).toEqual(snapshot);
    }
  });

  it('drops several variants at once and accepts Headers, tuples and undefined', () => {
    expect(withUserAgent({ 'user-agent': 'a', 'USER-AGENT': 'b' }, 'v')).toEqual({
      'User-Agent': 'v',
    });
    const h = new Headers({ 'user-agent': 'x', accept: 'a' });
    expect(withUserAgent(h, 'v')).toEqual({ accept: 'a', 'User-Agent': 'v' });
    expect(
      withUserAgent(
        [
          ['USER-AGENT', 'x'],
          ['k', 'v'],
        ],
        'v',
      ),
    ).toEqual({
      k: 'v',
      'User-Agent': 'v',
    });
    expect(withUserAgent(undefined, 'v')).toEqual({ 'User-Agent': 'v' });
  });
});

describe('findUserAgent', () => {
  it('returns undefined when there is none', () => {
    expect(findUserAgent({})).toBeUndefined();
    expect(findUserAgent(undefined)).toBeUndefined();
    expect(findUserAgent({ 'x-custom': 'v' })).toBeUndefined();
  });

  it('returns the last case variant in insertion order', () => {
    expect(findUserAgent({ 'user-agent': 'a', 'USER-AGENT': 'b' })).toBe('b');
    expect(findUserAgent({ 'USER-AGENT': 'b', 'user-agent': 'a' })).toBe('a');
  });
});
