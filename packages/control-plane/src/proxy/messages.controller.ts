import { Body, Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Principal } from '@polyrouter/shared/server';
import { AgentApiKeyGuard } from '../auth/agent-key.guard';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { handleInference } from './proxy-http';
import { ProxyService } from './proxy.service';
import { StreamDrainRegistry } from './stream-drain.registry';

/** Anthropic-compatible messages (`POST /v1/messages`). */
@Controller('v1')
@UseGuards(AgentApiKeyGuard)
export class MessagesController {
  constructor(
    private readonly svc: ProxyService,
    private readonly registry: StreamDrainRegistry,
  ) {}

  @Post('messages')
  messages(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    return handleInference(
      { svc: this.svc, registry: this.registry },
      'anthropic',
      principal,
      body,
      req,
      res,
    );
  }
}
