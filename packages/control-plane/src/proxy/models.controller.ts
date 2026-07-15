import { Controller, Get, UseGuards } from '@nestjs/common';
import type { Principal } from '@polyrouter/shared/server';
import { AgentApiKeyGuard } from '../auth/agent-key.guard';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { ProxyService } from './proxy.service';

/** `GET /v1/models` — the caller's routable model ids, tier keys, and `auto`. */
@Controller('v1')
@UseGuards(AgentApiKeyGuard)
export class ModelsController {
  constructor(private readonly svc: ProxyService) {}

  @Get('models')
  list(@CurrentPrincipal() principal: Principal): Promise<unknown> {
    return this.svc.listModels(principal);
  }
}
