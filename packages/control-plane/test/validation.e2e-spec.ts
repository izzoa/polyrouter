import { Body, Controller, Post, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsString } from 'class-validator';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApp } from '../src/app.setup';

/** Probe DTO/controller local to this suite — proves the GLOBAL pipe, not per-handler wiring. */
class ProbeDto {
  @IsString()
  name!: string;
}

@Controller('probe')
class ProbeController {
  @Post()
  probe(@Body() dto: ProbeDto): ProbeDto {
    return dto;
  }
}

describe('global ValidationPipe (app-bootstrap)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
    }).compile();
    app = configureApp(moduleRef.createNestApplication(), { NODE_ENV: 'test' });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects a non-whitelisted property with 400 before it reaches handler code', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/probe')
      .send({ name: 'ok', sneaky: 'nope' })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain('sneaky');
  });

  it('accepts a body that matches the DTO', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/probe')
      .send({ name: 'ok' })
      .expect(201);
    expect(res.body).toEqual({ name: 'ok' });
  });
});
