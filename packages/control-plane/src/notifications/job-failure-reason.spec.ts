import { jobFailureReason } from './notify.queue';

/** A scheduler's `failed` handler is often the ONLY record of why a background
 * job died. These pin the property that made a daily budget-eval failure
 * undiagnosable: the reason must survive being wrapped. */
describe('jobFailureReason', () => {
  it('reports the wrapper AND the buried cause a Drizzle query error hides', () => {
    // The shape node-postgres + Drizzle actually produce: the SQL is the
    // message, the reason (`ENOTFOUND`, a reset socket, 22P02) is the cause.
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND postgres'), { code: 'ENOTFOUND' });
    const err = new Error('Failed query: select "id" from "budget" where "enabled" = $1', {
      cause,
    });

    const reason = jobFailureReason(err);
    expect(reason).toContain('Failed query: select "id" from "budget"');
    expect(reason).toContain('getaddrinfo ENOTFOUND postgres');
  });

  it('walks a nested chain once, skipping empty and repeated links', () => {
    const root = new Error('invalid input syntax for type integer: "1.4"');
    const mid = new Error('invalid input syntax for type integer: "1.4"', { cause: root });
    const top = new Error('', { cause: mid });
    expect(jobFailureReason(top)).toBe('invalid input syntax for type integer: "1.4"');
  });

  it('clips each link and flattens newlines so one warn stays one line', () => {
    const err = new Error(`${'x'.repeat(500)}\nparams: 1,2,3`, { cause: new Error('boom') });
    const reason = jobFailureReason(err);
    expect(reason).not.toContain('\n');
    expect(reason).toContain('…');
    expect(reason.endsWith('caused by: boom')).toBe(true);
    expect(reason.length).toBeLessThan(300);
  });

  it('never returns an empty string, whatever it was handed', () => {
    expect(jobFailureReason(undefined)).toBe('error');
    expect(jobFailureReason(new Error(''))).toBe('error');
    expect(jobFailureReason('plain string failure')).toBe('plain string failure');
  });

  it('terminates on a self-referential cause chain', () => {
    const err: Error & { cause?: unknown } = new Error('loop');
    err.cause = err;
    expect(jobFailureReason(err)).toBe('loop');
  });
});
