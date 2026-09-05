// add-batch-inference task 2.4: every batch key is boot-validated, and a failure
// names the variable — never its value (the registry's contract for secret-safe
// config errors applies to these too).
import { ConfigRegistry, ConfigValidationError } from '@polyrouter/shared';
import { batchConfigSchema } from './batch.config';

const registry = (): ConfigRegistry => {
  const r = new ConfigRegistry();
  r.register('batch', batchConfigSchema);
  return r;
};

describe('batchConfigSchema', () => {
  it('applies the defaults when nothing is set', () => {
    expect(batchConfigSchema.parse({})).toEqual({
      BATCH_ENABLED: true,
      BATCH_MAX_ITEMS: 50_000,
      BATCH_MAX_BODY_BYTES: 64 * 1024 * 1024,
      BATCH_POLL_INTERVAL_MS: 15_000,
      BATCH_WINDOW_MARGIN_MS: 3_600_000,
    });
  });

  it('coerces string env values and reads the off switch', () => {
    expect(
      batchConfigSchema.parse({
        BATCH_ENABLED: 'false',
        BATCH_MAX_ITEMS: '100',
        BATCH_MAX_BODY_BYTES: '2048',
        BATCH_POLL_INTERVAL_MS: '5000',
        BATCH_WINDOW_MARGIN_MS: '0',
      }),
    ).toEqual({
      BATCH_ENABLED: false,
      BATCH_MAX_ITEMS: 100,
      BATCH_MAX_BODY_BYTES: 2_048,
      BATCH_POLL_INTERVAL_MS: 5_000,
      BATCH_WINDOW_MARGIN_MS: 0,
    });
    // Anything but the literal 'false' keeps batches on — an unset or odd value
    // never silently disables the surface.
    expect(batchConfigSchema.parse({ BATCH_ENABLED: 'no' }).BATCH_ENABLED).toBe(true);
  });

  const failFast: Array<[string, string]> = [
    ['BATCH_MAX_ITEMS', '0'],
    ['BATCH_MAX_ITEMS', '-424242'],
    ['BATCH_MAX_ITEMS', '1000001'],
    ['BATCH_MAX_BODY_BYTES', '512'],
    ['BATCH_MAX_BODY_BYTES', 'lots'],
    ['BATCH_POLL_INTERVAL_MS', '999'],
    ['BATCH_POLL_INTERVAL_MS', '3600001'],
    ['BATCH_WINDOW_MARGIN_MS', '-1'],
    ['BATCH_WINDOW_MARGIN_MS', '999999999999'],
  ];

  it.each(failFast)(
    'boot fails fast on %s=%s, naming the variable and never the value',
    (key, value) => {
      const load = (): unknown => registry().load({ [key]: value });
      expect(load).toThrow(ConfigValidationError);
      let message = '';
      try {
        load();
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain(key);
      // The supplied value must not be echoed (secret-safe errors). Digits that also
      // appear in a bound ("below minimum (1)") are not the value itself.
      if (!/^\d$/.test(value)) expect(message).not.toContain(value);
    },
  );
});
