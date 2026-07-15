import './database.config';
import '../redis/redis.config';
import { loadConfig } from '@polyrouter/shared';

describe('database & redis config (database-schema / redis-wiring)', () => {
  it('applies the dev-compose defaults when unset', () => {
    const config = loadConfig({});
    expect(config['DATABASE_URL']).toBe(
      'postgresql://polyrouter:polyrouter@localhost:5432/polyrouter',
    );
    expect(config['REDIS_URL']).toBe('redis://localhost:6379');
  });

  it('rejects a non-postgres DATABASE_URL, naming the variable without echoing the value', () => {
    const supplied = 'mysql://root:supersecretvalue@example.com/db';
    try {
      loadConfig({ DATABASE_URL: supplied });
      throw new Error('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('postgresql://');
      expect(message).not.toContain('supersecretvalue');
    }
  });

  it('rejects a non-redis REDIS_URL, naming the variable without echoing the value', () => {
    const supplied = 'http://internal-host:6379/topsecretpath';
    try {
      loadConfig({ REDIS_URL: supplied });
      throw new Error('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('REDIS_URL');
      expect(message).not.toContain('topsecretpath');
    }
  });
});
