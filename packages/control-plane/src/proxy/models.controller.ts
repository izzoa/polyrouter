import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { Principal } from '@polyrouter/shared/server';
import { AgentApiKeyGuard } from '../auth/agent-key.guard';
import { CurrentPrincipal } from '../auth/principal.decorator';
import {
  renderAnthropicEntry,
  renderAnthropicList,
  renderOpenAiEntry,
  renderOpenAiList,
} from './models-catalog';
import { stampClientProtocol, type ClientProtocol } from './proxy-errors';
import { ProxyService } from './proxy.service';

/**
 * `GET /v1/models` and `GET /v1/models/{id}` — the caller's routable model ids,
 * tier keys, and `auto`.
 *
 * This is the one `/v1` path that serves BOTH wires under the same URL, so it
 * cannot take its protocol from its route the way `/v1/chat/completions` and
 * `/v1/messages` do. The `anthropic-version` header decides: the Anthropic SDK
 * always sends it, and its absence keeps the OpenAI shape every existing client
 * already receives. It is NOT read from the credential header — the guard
 * deliberately accepts `Authorization: Bearer` or `x-api-key` for either SDK, so
 * overloading that header would put the drop-in guarantee and the protocol choice
 * in contradiction. The choice is stamped on the request so a failure renders in
 * the same envelope the success would have.
 */
@Controller('v1')
@UseGuards(AgentApiKeyGuard)
export class ModelsController {
  constructor(private readonly svc: ProxyService) {}

  private protocolFor(req: Request): ClientProtocol {
    const protocol: ClientProtocol =
      req.headers['anthropic-version'] !== undefined ? 'anthropic' : 'openai';
    stampClientProtocol(req, protocol);
    return protocol;
  }

  @Get('models')
  async list(@CurrentPrincipal() principal: Principal, @Req() req: Request): Promise<unknown> {
    const protocol = this.protocolFor(req);
    const entries = await this.svc.listModels(principal);
    return protocol === 'anthropic' ? renderAnthropicList(entries) : renderOpenAiList(entries);
  }

  /**
   * Advertised ids span multiple path segments (`openai:openai/gpt-6-astra`), so
   * a single-segment param cannot match them — path-to-regexp v8 hands a wildcard
   * back as a segment ARRAY, rejoined here. Express decodes percent-encoding
   * before routing, so `%2F` and `/` land on the same id.
   */
  @Get('models/*path')
  async retrieve(
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
    @Param('path') path: string | string[],
  ): Promise<unknown> {
    const protocol = this.protocolFor(req);
    const id = Array.isArray(path) ? path.join('/') : path;
    const entry = await this.svc.retrieveModel(principal, id);
    return protocol === 'anthropic' ? renderAnthropicEntry(entry) : renderOpenAiEntry(entry);
  }
}
