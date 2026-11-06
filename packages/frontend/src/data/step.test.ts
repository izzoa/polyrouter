/** `stepTarget` and `stepKey` (add-docked-inspector task 4.1, design D8; dashboard-analytics
 * "Docked stepping moves the selection without leaving the list"). */
import { describe, expect, it } from 'vitest';
import { buildRequestRows } from '../test/fakeClient';
import { stepKey, stepTarget, type StepDirection } from './step';

const ORDER = ['req-000', 'req-001', 'req-002', 'req-003'] as const;

describe('stepTarget', () => {
  it('steps to the adjacent openable id in either direction', () => {
    expect(stepTarget(ORDER, 'req-001', 'next')).toBe('req-002');
    expect(stepTarget(ORDER, 'req-001', 'previous')).toBe('req-000');
    expect(stepTarget(ORDER, 'req-002', 'next')).toBe('req-003');
  });

  it('is null at either end, so a step never wraps', () => {
    expect(stepTarget(ORDER, 'req-003', 'next'), 'Next on the last row wrapped').toBeNull();
    expect(
      stepTarget(ORDER, 'req-000', 'previous'),
      'Previous on the first row wrapped',
    ).toBeNull();
    expect(stepTarget(['only'], 'only', 'next')).toBeNull();
    expect(stepTarget(['only'], 'only', 'previous')).toBeNull();
  });

  it('is null for an id that is not loaded, and for no id at all', () => {
    for (const dir of ['previous', 'next'] as const) {
      expect(stepTarget(ORDER, 'req-999', dir), 'a request that left the list').toBeNull();
      expect(stepTarget(ORDER, null, dir)).toBeNull();
      expect(stepTarget([], 'req-000', dir)).toBeNull();
    }
  });

  it('walks exactly the ids it is given, each way, in order, and stops at the ends', () => {
    // `stepTarget` can only return a neighbour in the order it is handed, so that a live,
    // finishing, batch-job or boundary entry is unreachable is a property of the STORE's order
    // (`stepOrder` holds the loaded request list's ids and nothing else), not of this function:
    // it is asserted against the store in `dockedInspector.view.test.tsx`, "passes over the
    // agent boundaries between rows, never steps onto a live or batch-job row".
    const completed = buildRequestRows(30).map((r) => r.id);
    const walk = (from: string, dir: StepDirection): string[] => {
      const seen: string[] = [];
      for (
        let id = stepTarget(completed, from, dir);
        id !== null;
        id = stepTarget(completed, id, dir)
      )
        seen.push(id);
      return seen;
    };
    expect(walk(completed[0]!, 'next')).toEqual(completed.slice(1));
    expect(walk(completed[completed.length - 1]!, 'previous')).toEqual(
      completed.slice(0, -1).reverse(),
    );
    // An id outside the order (a live row's, a batch job's, a boundary's) is a step from nowhere.
    for (const id of ['live-1', 'finishing-1', 'job-1', 'boundary:agent-0']) {
      expect(stepTarget(completed, id, 'next'), `a step from ${id}`).toBeNull();
      expect(stepTarget(completed, id, 'previous'), `a step from ${id}`).toBeNull();
    }
  });
});

describe('stepKey', () => {
  const key = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent('keydown', init);

  it('maps ArrowUp to previous and ArrowDown to next, and every other key to nothing', () => {
    expect(stepKey(key({ key: 'ArrowUp' }))).toBe('previous');
    expect(stepKey(key({ key: 'ArrowDown' }))).toBe('next');
    for (const k of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageDown', 'Enter', ' ', 'j']) {
      expect(stepKey(key({ key: k })), k).toBeNull();
    }
  });

  it('stays out of the way while composing or with any modifier held', () => {
    for (const k of ['ArrowUp', 'ArrowDown']) {
      expect(stepKey(key({ key: k, isComposing: true })), `${k} composing`).toBeNull();
      for (const mod of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const) {
        expect(stepKey(key({ key: k, [mod]: true })), `${k} + ${mod}`).toBeNull();
      }
    }
  });
});
