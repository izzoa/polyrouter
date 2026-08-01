import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE, hashForPage, PAGES, pageFromHash } from './route';

/** add-dashboard-hash-routing task 1.1/1.5: the grammar is deliberately strict —
 * an unrecognized shape is UNKNOWN, never guessed, because a wrong guess routes
 * the operator somewhere they did not ask for. */
describe('pageFromHash', () => {
  it('accepts every page in the union, exactly', () => {
    for (const p of PAGES) expect(pageFromHash(`#/${p}`)).toBe(p);
  });

  it('rejects a case mismatch (case-sensitive by contract)', () => {
    expect(pageFromHash('#/Costs')).toBeNull();
    expect(pageFromHash('#/COSTS')).toBeNull();
  });

  it('rejects a suffix or nested path', () => {
    expect(pageFromHash('#/costs/detail')).toBeNull();
    expect(pageFromHash('#/costsx')).toBeNull();
  });

  it('rejects a query- or param-bearing fragment', () => {
    expect(pageFromHash('#/costs?range=24h')).toBeNull();
    expect(pageFromHash('#/costs&x=1')).toBeNull();
  });

  it('does NOT percent-decode — an encoded alias is unknown, not a match', () => {
    expect(pageFromHash('#/%63osts')).toBeNull();
  });

  it('rejects malformed, empty, and non-page fragments', () => {
    for (const h of ['', '#', '#/', '#costs', '/costs', '#//costs', '#/nope']) {
      expect(pageFromHash(h)).toBeNull();
    }
  });

  it('round-trips with hashForPage', () => {
    for (const p of PAGES) expect(pageFromHash(hashForPage(p))).toBe(p);
    expect(hashForPage(DEFAULT_PAGE)).toBe('#/overview');
  });
});
