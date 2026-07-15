import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

async function createAppFor(nodeEnv: 'development' | 'production'): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = configureApp(moduleRef.createNestApplication(), { NODE_ENV: nodeEnv });
  await app.init();
  return app;
}

describe('CORS is development-only (app-bootstrap)', () => {
  it('emits CORS headers in development (Vite on :3000 is cross-origin)', async () => {
    const app = await createAppFor('development');
    try {
      const res = await request(app.getHttpServer() as App)
        .get('/api/health')
        .set('Origin', 'http://localhost:3000')
        .expect(200);
      expect(res.headers['access-control-allow-origin']).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it('emits no Access-Control-Allow-Origin header in production', async () => {
    const app = await createAppFor('production');
    try {
      const res = await request(app.getHttpServer() as App)
        .get('/api/health')
        .set('Origin', 'http://evil.example')
        .expect(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
