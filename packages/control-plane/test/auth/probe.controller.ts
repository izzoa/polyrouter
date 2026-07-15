import { Controller, Get, UseGuards } from '@nestjs/common';
import type { Principal } from '@polyrouter/shared/server';
import { AgentApiKeyGuard } from '../../src/auth/agent-key.guard';
import { CurrentPrincipal } from '../../src/auth/principal.decorator';

/** Test-only probe routes: a `/v1` route guarded by the agent-key plane and a
 * `/api` route on the session plane, so plane separation and the agent-key
 * guard are provable ahead of the real proxy (#10). Never shipped. */
@Controller()
export class ProbeController {
  @Get('v1/probe')
  @UseGuards(AgentApiKeyGuard)
  v1Probe(@CurrentPrincipal() principal: Principal): { ok: true; principal: Principal } {
    return { ok: true, principal };
  }

  @Get('api/probe')
  apiProbe(@CurrentPrincipal() principal: Principal): { ok: true; principal: Principal } {
    return { ok: true, principal };
  }
}
