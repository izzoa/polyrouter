import { describe, expect, it } from 'vitest';
import { validBudgetProgressIds } from '../src/index';
describe('budget progress input boundary', () => {
  it('accepts exactly bounded distinct trimmed opaque ids', () => {
    expect(validBudgetProgressIds(['opaque/id'])).toBe(true);
    expect(validBudgetProgressIds(Array.from({ length: 20 }, (_, i) => String(i)))).toBe(true);
    for (const ids of [
      [],
      ['a', 'a'],
      [''],
      [' a'],
      ['a '],
      ['x'.repeat(129)],
      Array.from({ length: 21 }, (_, i) => String(i)),
    ])
      expect(validBudgetProgressIds(ids)).toBe(false);
  });
});
