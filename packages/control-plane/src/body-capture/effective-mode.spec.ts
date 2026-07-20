import { shouldPersistBodies } from './effective-mode';

const d = (
  mode: 'off' | 'errors_only' | 'all',
  override: 'always' | 'never' | null,
  status: 'success' | 'error' | 'fallback' | 'cancelled',
  escalated = false,
) => shouldPersistBodies({ mode, override, status, escalated });

describe('shouldPersistBodies — the master-kill matrix (add-body-capture)', () => {
  it('global off captures NOTHING — overrides are inert (the consent boundary)', () => {
    for (const status of ['success', 'error', 'fallback', 'cancelled'] as const) {
      expect(d('off', null, status)).toBe(false);
      expect(d('off', 'always', status, true)).toBe(false); // off + always → nothing
      expect(d('off', 'never', status)).toBe(false);
    }
  });

  it('agent never suppresses within an armed state', () => {
    expect(d('all', 'never', 'success')).toBe(false);
    expect(d('errors_only', 'never', 'error', true)).toBe(false);
  });

  it('agent always captures every outcome within an armed state', () => {
    for (const status of ['success', 'error', 'fallback', 'cancelled'] as const) {
      expect(d('errors_only', 'always', status)).toBe(true);
      expect(d('all', 'always', status)).toBe(true);
    }
  });

  it('errors_only stores exactly the debugging set', () => {
    expect(d('errors_only', null, 'error')).toBe(true);
    expect(d('errors_only', null, 'success', true)).toBe(true); // escalated
    expect(d('errors_only', null, 'success')).toBe(false);
    expect(d('errors_only', null, 'fallback')).toBe(false); // served = not an error
    expect(d('errors_only', null, 'cancelled')).toBe(false); // client walked away
  });

  it('all captures every outcome (cancelled included, flagged partial upstream)', () => {
    for (const status of ['success', 'error', 'fallback', 'cancelled'] as const) {
      expect(d('all', null, status)).toBe(true);
    }
  });
});
