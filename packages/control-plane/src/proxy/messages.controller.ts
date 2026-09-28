import { Body, Controller, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Principal } from '@polyrouter/shared/server';
import { AgentApiKeyGuard } from '../auth/agent-key.guard';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { handleInference } from './proxy-http';
import { PROXY_RUNTIME, type ProxyRuntime } from './proxy.config';
import { ProxyService } from './proxy.service';
import { StreamDrainRegistry } from './stream-drain.registry';

/** Anthropic-compatible messages (`POST /v1/messages`). */
@Controller('v1')
@UseGuards(AgentApiKeyGuard)
export class MessagesController {
  constructor(
    private readonly svc: ProxyService,
    private readonly registry: StreamDrainRegistry,
    @Inject(PROXY_RUNTIME) private readonly rt: ProxyRuntime,
  ) {}

  @Post('messages')
  messages(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    return handleInference(
      { svc: this.svc, registry: this.registry, keepalive: this.rt.streamKeepalive },
      'anthropic',
      principal,
      body,
      req,
      res,
    );
  }
}
