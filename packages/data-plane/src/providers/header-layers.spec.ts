// allow-preset-client-identity — the case-insensitive header merge (design D5).
import { mergeHeaderLayers } from './header-layers';

describe('mergeHeaderLayers', () => {
  const defaults = { 'HTTP-Referer': 'https://example.test', 'X-OpenRouter-Title': 'app' };
  const protocol = { Authorization: 'Bearer k', 'Content-Type': 'application/json' };

  it('returns exactly {...defaults, ...protocol} for an empty extra', () => {
    expect(mergeHeaderLayers(defaults, {}, protocol)).toEqual({ ...defaults, ...protocol });
    expect(Object.keys(mergeHeaderLayers(defaults, {}, protocol))).toEqual([
      ...Object.keys(defaults),
      ...Object.keys(protocol),
    ]);
  });

  it('lets a defaults/protocol-only call equal the old object spread', () => {
    expect(mergeHeaderLayers({}, {}, {})).toEqual({});
    expect(mergeHeaderLayers(defaults, {}, {})).toEqual(defaults);
  });

  it('an extra user-agent replaces a User-Agent default (one entry, the extra spelling)', () => {
    const out = mergeHeaderLayers({ 'User-Agent': 'polyrouter/1' }, { 'user-agent': 'x/2' }, {});
    expect(out).toEqual({ 'user-agent': 'x/2' });
    expect(Object.keys(out).filter((k) => k.toLowerCase() === 'user-agent')).toHaveLength(1);
  });

  it('an extra header never survives next to the protocol Authorization / Content-Type', () => {
    const out = mergeHeaderLayers(
      defaults,
      { authorization: 'Bearer evil', 'CONTENT-TYPE': 'text/plain', 'X-Fixture': 'ok' },
      protocol,
    );
    expect(out['Authorization']).toBe('Bearer k');
    expect(out['Content-Type']).toBe('application/json');
    expect(out['X-Fixture']).toBe('ok');
    const lower = Object.keys(out).map((k) => k.toLowerCase());
    expect(lower.filter((k) => k === 'authorization')).toHaveLength(1);
    expect(lower.filter((k) => k === 'content-type')).toHaveLength(1);
    expect(Object.keys(out)).not.toContain('authorization');
    expect(Object.keys(out)).not.toContain('CONTENT-TYPE');
  });

  it('keeps protocol spelling exactly and does not mutate its inputs', () => {
    const d = { ...defaults };
    const e = { 'x-extra': '1' };
    const p = { 'x-API-key': 'k' };
    const out = mergeHeaderLayers(d, e, p);
    expect(out['x-API-key']).toBe('k');
    expect(d).toEqual(defaults);
    expect(e).toEqual({ 'x-extra': '1' });
    expect(p).toEqual({ 'x-API-key': 'k' });
  });

  it('a later case-variant inside extra wins, like the spread it replaces', () => {
    expect(mergeHeaderLayers({}, { 'X-A': '1', 'x-a': '2' }, {})).toEqual({ 'x-a': '2' });
  });

  it('an extra replaces a same-name default case-insensitively but keeps other defaults', () => {
    expect(mergeHeaderLayers(defaults, { 'http-referer': 'https://other.test' }, {})).toEqual({
      'X-OpenRouter-Title': 'app',
      'http-referer': 'https://other.test',
    });
  });
});
