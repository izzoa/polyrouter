import { describe, expect, it } from 'vitest';
import {
  ConfigRegistry,
  ConfigValidationError,
  loadConfig,
  z,
  type BaseConfig,
} from '../src/index';

describe('config registry (app-config)', () => {
  it('applies self-host-safe defaults when nothing is set', () => {
    const config = loadConfig<BaseConfig>({});
    expect(config.PORT).toBe(3001);
    expect(config.BIND_ADDRESS).toBe('127.0.0.1');
    expect(config.NODE_ENV).toBe('development');
    expect(config.MODE).toBe('selfhosted');
  });

  it('exposes MODE as the validated enum downstream gates consult', () => {
    const config = loadConfig<BaseConfig>({ MODE: 'cloud' });
    expect(config.MODE).toBe('cloud');
  });

  it('throws naming a missing required variable, before any value is used', () => {
    const registry = new ConfigRegistry();
    registry.register('test-fragment', z.object({ TEST_REQUIRED_TOKEN: z.string() }));
    try {
      registry.load({});
      expect.unreachable('load() should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).message).toContain('TEST_REQUIRED_TOKEN');
    }
  });

  it('reports an invalid MODE without echoing the supplied value', () => {
    const suppliedValue = 'staging-zebra';
    try {
      loadConfig({ MODE: suppliedValue });
      expect.unreachable('loadConfig() should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const message = (error as ConfigValidationError).message;
      expect(message).toContain('MODE');
      expect(message).toContain('selfhosted');
      expect(message).not.toContain(suppliedValue);
    }
  });

  it('reports an invalid PORT without echoing the supplied value', () => {
    const suppliedValue = 'not-a-port-9x7';
    try {
      loadConfig({ PORT: suppliedValue });
      expect.unreachable('loadConfig() should have thrown');
    } catch (error) {
      const message = (error as ConfigValidationError).message;
      expect(message).toContain('PORT');
      expect(message).not.toContain(suppliedValue);
    }
  });

  it('validates fragments registered later in the same boot pass', () => {
    const registry = new ConfigRegistry();
    registry.register('core-like', z.object({ SOME_VAR: z.string().default('x') }));
    registry.register('later-capability', z.object({ DATABASE_URL_LIKE: z.string() }));

    expect(() => registry.load({})).toThrow(/DATABASE_URL_LIKE/);

    const config = registry.load({ DATABASE_URL_LIKE: 'postgres://ok' });
    expect(config['SOME_VAR']).toBe('x');
    expect(config['DATABASE_URL_LIKE']).toBe('postgres://ok');
  });

  it('rejects duplicate namespaces and doubly-owned variables', () => {
    const registry = new ConfigRegistry();
    registry.register('a', z.object({ VAR_ONE: z.string().default('1') }));
    expect(() => registry.register('a', z.object({ OTHER: z.string() }))).toThrow(
      /already registered/,
    );
    expect(() => registry.register('b', z.object({ VAR_ONE: z.string() }))).toThrow(
      /already registered by namespace "a"/,
    );
  });
});
