/** The locale guard (fix-nonstandard-locale-boot-crash).
 *
 * The browser suite proves the guard fixes the real boot crash against the real entry point.
 * This covers the two branches a browser cannot reach: the no-op path must genuinely not
 * touch a healthy host, and the substitution must fail SOFT — a guard that throws while
 * handling a broken host has replaced one crash with another.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyLocaleGuard } from './localeGuard';

/** Makes `navigator.language` report `tag`, as a non-conforming host would. */
function report(tag: string): void {
  Object.defineProperty(Navigator.prototype, 'language', {
    get: () => tag,
    configurable: true,
  });
}

const ORIGINAL = Object.getOwnPropertyDescriptor(Navigator.prototype, 'language');

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL) Object.defineProperty(Navigator.prototype, 'language', ORIGINAL);
});

describe('a host reporting a usable tag is left alone', () => {
  it('does not substitute, and does not change the reported locale', () => {
    report('en-GB');
    expect(applyLocaleGuard(), 'substituted a locale that was already fine').toBeNull();
    expect(navigator.language).toBe('en-GB');
  });

  it.each(['POSIX', 'posix', 'en-US-POSIX'])(
    'leaves %s alone — the runtime accepts it',
    (tag) => {
      // Measured, and the reason the guard tests by construction rather than by matching
      // strings: these LOOK malformed and are perfectly valid. A blocklist would have
      // rewritten them, changing formatting for hosts that never had a problem.
      report(tag);
      expect(applyLocaleGuard()).toBeNull();
      expect(navigator.language).toBe(tag);
    },
  );
});

describe('a host reporting a tag the runtime rejects', () => {
  it.each(['en-US@posix', 'C', 'en_US', ''])('substitutes for %s', (tag) => {
    report(tag);
    const applied = applyLocaleGuard();
    expect(applied, `did not substitute for the rejected tag ${tag}`).not.toBeNull();
    expect(navigator.language).toBe(applied);
    // The whole point: the result must be usable by the thing that was crashing.
    expect(() => new Intl.NumberFormat(navigator.language)).not.toThrow();
  });

  it('substitutes the locale the RUNTIME resolved, not a hardcoded default', () => {
    report('en-US@posix');
    expect(applyLocaleGuard()).toBe(Intl.DateTimeFormat().resolvedOptions().locale);
  });

  it('keeps languages consistent with language', () => {
    report('en-US@posix');
    const applied = applyLocaleGuard();
    expect(navigator.languages).toEqual([applied]);
  });
});

describe('it fails soft', () => {
  it('returns null instead of throwing when the property cannot be redefined', () => {
    report('en-US@posix');
    // Stubbed by hand rather than with `vi.spyOn`: vitest's own mock restore calls
    // `Object.defineProperty`, so spying on it breaks the teardown of every other test in
    // the file. Restored in `finally` so a failed expectation cannot leak it either.
    const real = Object.defineProperty;
    let threw: unknown = null;
    let result: string | null = null;
    Object.defineProperty = ((): never => {
      throw new TypeError('cannot redefine property');
    }) as typeof Object.defineProperty;
    try {
      result = applyLocaleGuard();
    } catch (e) {
      threw = e;
    } finally {
      Object.defineProperty = real;
    }
    // Asserted AFTER restoring: vitest's matchers use `Object.defineProperty` themselves, so
    // expecting while the stub is live fails inside the assertion rather than the subject.
    // Throwing here would replace the crash being fixed with an identical one, in the code
    // written to prevent it.
    expect(threw, 'the guard threw while handling a host it could not patch').toBeNull();
    expect(result).toBeNull();
  });

  it('returns null when the runtime cannot resolve its own default locale', () => {
    report('en-US@posix');
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
      throw new RangeError('no default locale');
    });
    expect(applyLocaleGuard()).toBeNull();
  });
});
