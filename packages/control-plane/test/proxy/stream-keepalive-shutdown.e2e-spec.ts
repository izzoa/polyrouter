// add-stream-keepalive (review follow-up): shutdown during a pre-commit wait on an
// upstream that IGNORES cancellation. The lifecycle e2e's `oai-hang` stub still honors
// the aborted fetch, so it cannot prove this; here the proxy service's `stream()` never
// settles — even after its signal aborts — and the real controller + pump + drain
// registry must still end the early-committed response and let `app.close()` finish
// within the drain deadline, releasing the socket.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common';
import { userPrincipal } from '@polyrouter/shared/server';
import { AgentApiKeyGuard } from '../../src/auth/agent-key.guard';
import { ChatCompletionsController } from '../../src/proxy/chat-completions.controller';
import { ProxyExceptionFilter } from '../../src/proxy/proxy-exception.filter';
import { PROXY_RUNTIME, type ProxyRuntime } from '../../src/proxy/proxy.config';
import { ProxyService } from '../../src/proxy/proxy.service';
import { StreamDrainRegistry } from '../../src/proxy/stream-drain.registry';

class TestAgentGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    ctx.switchToHttp().getRequest<{ principal?: unknown }>().principal = userPrincipal('u-ka');
    return true;
  }
}

describe('stream keepalive: shutdown with an upstream that ignores abort (e2e)', () => {
  let app: INestApplication;
  let port: number;
  let sawAbort = false;

  beforeAll(async () => {
    const runtime = {
      streamDrainDeadlineMs: 500,
      streamKeepalive: { heartbeatMs: 200, earlyCommitMs: 250 },
    } as unknown as ProxyRuntime;
    const moduleRef = await Test.createTestingModule({
      controllers: [ChatCompletionsController],
      providers: [
        StreamDrainRegistry,
        { provide: PROXY_RUNTIME, useValue: runtime },
        {
          provide: ProxyService,
          useValue: {
            // Never settles — not on its own, and not when its signal aborts.
            stream: (...args: unknown[]) => {
              (args[4] as AbortSignal).addEventListener('abort', () => (sawAbort = true));
              return new Promise<never>(() => undefined);
            },
          },
        },
        { provide: APP_FILTER, useClass: ProxyExceptionFilter },
      ],
    })
      .overrideGuard(AgentApiKeyGuard)
      .useClass(TestAgentGuard)
      .compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  it('ends the early-committed response and closes within the drain deadline', async () => {
    const agent = new http.Agent({ keepAlive: false });
    const payload = JSON.stringify({ model: 'x', stream: true, messages: [] });
    let body = '';
    let status = 0;
    let socketClosed!: () => void;
    const closed = new Promise<void>((r) => (socketClosed = r));
    const firstBytes = new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          agent,
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/v1/chat/completions',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          status = res.statusCode ?? 0;
          res.on('data', (c: Buffer) => {
            body += c.toString();
            resolve();
          });
          res.on('close', () => socketClosed());
          res.on('error', () => socketClosed());
        },
      );
      req.on('error', reject);
      req.end(payload);
    });

    await firstBytes; // the early-commit preamble arrived
    expect(status).toBe(200);
    expect(body).toContain(': keep-alive');

    const started = Date.now();
    await app.close(); // drain deadline 500ms; the service NEVER settles
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(sawAbort).toBe(true); // the pump did abort it — the service just ignored that
    await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('socket not released')), 3_000)),
    ]);
    agent.destroy();
  }, 20_000);
});
