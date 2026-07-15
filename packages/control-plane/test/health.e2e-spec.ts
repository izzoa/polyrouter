import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

describe('GET /api/health (app-bootstrap)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication(), { NODE_ENV: 'test' });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 {"status":"ok"} without authentication', async () => {
    const res = await request(app.getHttpServer() as App)
      .get('/api/health')
      .expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
