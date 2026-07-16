// E1.1: mountBodyParsing against a bare Express app (no Nest, no auth) exercises
// the exact production body-parse chain — the /v1 large limit, the /v1-scoped
// protocol-shaped 413/400 rendering, and that /api keeps the default parser.
import express from 'express';
import request from 'supertest';
import { mountBodyParsing } from './mount';

const LIMIT = 1024; // 1 KiB test limit

function app(): express.Express {
  const a = express();
  mountBodyParsing(a, LIMIT);
  a.post('/v1/chat/completions', (req, res) => res.status(200).json({ ok: true, echo: req.body }));
  a.post('/v1/messages', (req, res) => res.status(200).json({ ok: true }));
  a.post('/api/echo', (req, res) => res.status(200).json({ ok: true, echo: req.body }));
  return a;
}

describe('mountBodyParsing', () => {
  it('accepts a /v1 body under the limit', async () => {
    const res = await request(app())
      .post('/v1/chat/completions')
      .set('content-type', 'application/json')
      .send({ hi: 'there' });
    expect(res.status).toBe(200);
    expect(res.body.echo).toEqual({ hi: 'there' });
  });

  it('renders an over-limit /v1/chat/completions body as an OpenAI-shaped 413 (no HTML)', async () => {
    const res = await request(app())
      .post('/v1/chat/completions')
      .set('content-type', 'application/json')
      .send({ big: 'x'.repeat(LIMIT * 2) });
    expect(res.status).toBe(413);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error).toMatchObject({ type: 'invalid_request_error', code: 'request_too_large' });
    expect(res.text).not.toMatch(/<!DOCTYPE|<html|Error:/i);
  });

  it('renders an over-limit /v1/messages body as an Anthropic-shaped 413', async () => {
    const res = await request(app())
      .post('/v1/messages')
      .set('content-type', 'application/json')
      .send({ big: 'x'.repeat(LIMIT * 2) });
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } });
  });

  it('renders malformed JSON as a protocol-shaped 400 on both /v1 routes', async () => {
    for (const [path, check] of [
      ['/v1/chat/completions', (b: { error?: { type?: string } }) => b.error?.type === 'invalid_request_error'],
      ['/v1/messages', (b: { type?: string }) => b.type === 'error'],
    ] as const) {
      const res = await request(app())
        .post(path)
        .set('content-type', 'application/json')
        .send('{"broken": '); // truncated JSON
      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(check(res.body)).toBe(true);
    }
  });

  it('treats a look-alike path like /v10 as non-/v1 (segment-safe): default parser, no /v1 renderer', async () => {
    const a = express();
    mountBodyParsing(a, LIMIT);
    a.post('/v10', (req, res) => res.status(200).json({ ok: true }));
    const res = await request(a)
      .post('/v10')
      .set('content-type', 'application/json')
      .send({ big: 'x'.repeat(LIMIT * 4) }); // over the /v1 limit but /v10 is not /v1
    expect(res.status).toBe(200); // default parser (100kb) accepts it, not the 1KiB /v1 limit
  });

  it('leaves /api on the default parser: an over-1KiB but under-100kb body still parses', async () => {
    // Over the /v1 test limit (1 KiB) but under body-parser's 100kb default →
    // proves /api is NOT governed by maxBodyBytes and NOT rendered by the /v1 handler.
    const res = await request(app())
      .post('/api/echo')
      .set('content-type', 'application/json')
      .send({ big: 'x'.repeat(LIMIT * 4) });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
