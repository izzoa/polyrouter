import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { connectionSnippet, type HarnessType } from '@polyrouter/shared';
import {
  PERSISTENCE_PORT,
  type AgentRow,
  type PersistencePort,
  type Principal,
} from '@polyrouter/shared/server';
import { loadAuthConfig, resolveAuthSecrets } from '../auth/auth.config';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { mintAgentKey } from './agent-keys';
import { CreateAgentDto } from './agents.dto';

interface SafeAgent {
  id: string;
  name: string;
  harness: string;
  prefix: string;
  lastUsedAt: Date | null;
  createdAt: Date;
}

function toSafe(a: AgentRow): SafeAgent {
  return {
    id: a.id,
    name: a.name,
    harness: a.harnessType,
    prefix: a.apiKeyPrefix,
    lastUsedAt: a.lastUsedAt,
    createdAt: a.createdAt,
  };
}

/** `/api/agents` — session-guarded (bound in the module), tenant-scoped via
 * the persistence port. Full keys appear once (create/rotate) with no-store. */
@Controller('api/agents')
export class AgentsController {
  private readonly baseUrl: string;
  private readonly hmacSecret: string;

  constructor(@Inject(PERSISTENCE_PORT) private readonly db: PersistencePort) {
    const { auth, base } = loadAuthConfig();
    this.baseUrl = `${auth.BETTER_AUTH_URL.replace(/\/$/, '')}/v1`;
    this.hmacSecret = resolveAuthSecrets(auth, base).apiKeyHmacSecret;
  }

  @Get()
  async list(@CurrentPrincipal() principal: Principal): Promise<SafeAgent[]> {
    const agents = await this.db.agents.list(principal);
    return agents.map(toSafe);
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateAgentDto,
  ): Promise<SafeAgent & { key: string; snippet: string }> {
    const minted = mintAgentKey(this.hmacSecret);
    const agent = await this.db.agents.insert(principal, {
      name: dto.name,
      harnessType: dto.harness,
      apiKeyHash: minted.hash,
      apiKeyPrefix: minted.prefix,
    });
    return {
      ...toSafe(agent),
      key: minted.key,
      snippet: connectionSnippet(dto.harness, this.baseUrl, minted.key),
    };
  }

  @Post(':id/rotate-key')
  @Header('Cache-Control', 'no-store')
  async rotate(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<SafeAgent & { key: string; snippet: string }> {
    const minted = mintAgentKey(this.hmacSecret);
    const agent = await this.db.agents.update(principal, id, {
      apiKeyHash: minted.hash,
      apiKeyPrefix: minted.prefix,
    });
    if (!agent) throw new NotFoundException();
    return {
      ...toSafe(agent),
      key: minted.key,
      snippet: connectionSnippet(agent.harnessType as HarnessType, this.baseUrl, minted.key),
    };
  }

  @Delete(':id')
  async remove(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<{ deleted: boolean }> {
    const deleted = await this.db.agents.remove(principal, id);
    if (!deleted) throw new NotFoundException();
    return { deleted };
  }
}
