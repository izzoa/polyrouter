import { Test } from '@nestjs/testing';
import { REDIS_CLIENT } from '@polyrouter/shared/server';
import type { Redis } from 'ioredis';
import { RedisModule } from '../src/redis/redis.module';

/** redis-wiring DoD: the injected client works against the dev compose and
 * the connection is quit cleanly on shutdown (no dangling handles). */
describe('redis wiring', () => {
  it('PINGs through the injected client and quits on close', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [RedisModule] }).compile();
    const app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await app.init();
    const client = app.get<Redis>(REDIS_CLIENT);
    try {
      const pong = await client.ping();
      expect(pong).toBe('PONG');
    } catch (error) {
      throw new Error(
        `Dev redis unreachable — start it with: docker compose -f docker-compose.dev.yml up -d\n(${(error as Error).message})`,
      );
    }
    await app.close();
    // quit() resolves on the command reply; the socket reaches 'end' a tick later
    await new Promise<void>((resolve) => {
      if (client.status === 'end') resolve();
      else client.once('end', () => resolve());
    });
    expect(client.status).toBe('end');
  }, 30_000);
});
