import { describe, expect, it } from 'vitest';
import { readReleaseVersion, validateReleaseVersion } from '../build/release-version';

describe('validateReleaseVersion (outbound-user-agent)', () => {
  it('accepts a strict semantic version, with an optional pre-release or build suffix', () => {
    expect(validateReleaseVersion('0.27.1')).toBe('0.27.1');
    expect(validateReleaseVersion('1.0.0-rc.1')).toBe('1.0.0-rc.1');
    expect(validateReleaseVersion('1.2.3+build.5')).toBe('1.2.3+build.5');
    for (const ok of ['1.0.0-0', '1.0.0-rc.1', '1.0.0-alpha-1', '1.0.0-x.7.z.92', '1.0.0+001']) {
      expect(validateReleaseVersion(ok)).toBe(ok);
    }
  });

  it('rejects a missing or malformed value with an error naming the release version', () => {
    for (const bad of [
      '',
      undefined,
      null,
      42,
      'v0.27.1',
      '0.27',
      'latest',
      '01.2.3',
      '1.2.3 ',
      '1.0.0-01',
      '1.0.0-rc.01',
      '1.0.0-',
    ]) {
      expect(() => validateReleaseVersion(bad)).toThrow(/release version/);
    }
  });

  it('reads the real frontend manifest', () => {
    expect(readReleaseVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('throws for a manifest without a version', () => {
    expect(() => readReleaseVersion('/nonexistent/package.json')).toThrow();
  });
});
