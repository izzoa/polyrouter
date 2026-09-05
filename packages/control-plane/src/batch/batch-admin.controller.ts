import { Body, Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { IsBooleanString, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { isBatchJobTerminal, type BatchJobStatus } from '@polyrouter/shared';
import {
  PERSISTENCE_PORT,
  type BatchJobRow,
  type PersistencePort,
  type Principal,
} from '@polyrouter/shared/server';
import { Inject } from '@nestjs/common';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { ProxyError } from '../proxy/proxy-errors';
import { BatchService } from './batch.service';

const toInt = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && value.trim() !== '' ? Number(value) : value;

export class BatchesQueryDto {
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  cursor?: string;

  /** `1` returns only non-terminal jobs — the live-row band's read. */
  @IsOptional()
  @IsBooleanString()
  active?: string;
}

/**
 * A batch job as the DASHBOARD sees it (add-batch-inference task 4.9): metadata
 * only, with owner-scoped labels and an id fallback when a provider or model row
 * has since been deleted. It never carries a prompt, a response, a `custom_id`,
 * or a credential — the job row has no column that could hold one.
 */
export interface SafeBatchJob {
  id: string;
  upstreamBatchId: string | null;
  status: string;
  terminal: boolean;
  endpoint: string;
  agentId: string | null;
  providerId: string;
  providerLabel: string | null;
  modelId: string;
  modelLabel: string | null;
  tierAssigned: string | null;
  counts: { total: number; completed: number; failed: number };
  submittedAt: string;
  updatedAt: string;
  terminalAt: string | null;
  /** µ$ reserved while the job is live; null once it is terminal (a reservation
   * is never rendered as spend — D13). */
  reservedCeilingMicros: number | null;
  /** µ$ actually settled, once terminal. */
  settledCostMicros: number | null;
  /** When the UPSTREAM stops serving results. Null = the provider states none,
   * which the dashboard shows as "retention unknown" rather than inventing one. */
  resultsExpireAt: string | null;
  errorKind: string | null;
}

/**
 * The dashboard's owner-scoped batch surface. Session-guarded by the global
 * guard (it early-returns for non-`/api` paths), and every read and mutation goes
 * through the central persistence seam — another tenant's job is a 404.
 */
@Controller('api/batches')
export class BatchAdminController {
  constructor(
    private readonly svc: BatchService,
    @Inject(PERSISTENCE_PORT) private readonly db: PersistencePort,
  ) {}

  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query() q: BatchesQueryDto,
  ): Promise<{ rows: SafeBatchJob[]; nextCursor: string | null }> {
    const page = await this.svc.listForOwner(principal, {
      limit: q.limit ?? 25,
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(q.active === 'true' || q.active === '1' ? { active: true } : {}),
    });
    return { rows: await this.toSafe(principal, page.rows), nextCursor: page.nextCursor };
  }

  @Get(':id')
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<SafeBatchJob> {
    const row = await this.svc.getForOwner(principal, id);
    if (row === null) throw new NotFoundException('batch not found');
    return (await this.toSafe(principal, [row]))[0]!;
  }

  @Post(':id/cancel')
  async cancel(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() _body: unknown,
  ): Promise<SafeBatchJob> {
    void _body;
    try {
      const { row } = await this.svc.cancelForOwner(principal, id);
      return (await this.toSafe(principal, [row]))[0]!;
    } catch (err) {
      // The agent plane renders the proxy envelope; `/api` speaks Nest's.
      if (err instanceof ProxyError && err.status === 404) {
        throw new NotFoundException('batch not found');
      }
      throw err;
    }
  }

  /** Owner-scoped label resolution with an id fallback (a deleted provider or
   * model must not hide the job that used it). */
  private async toSafe(
    principal: Principal,
    rows: readonly BatchJobRow[],
  ): Promise<SafeBatchJob[]> {
    if (rows.length === 0) return [];
    const [providers, models] = await Promise.all([
      this.db.providers.list(principal),
      this.db.models.listForPrincipal(principal),
    ]);
    const providerNames = new Map(providers.map((p) => [p.id, p.name]));
    const modelNames = new Map(models.map((m) => [m.id, m.externalModelId]));
    return rows.map((r) => {
      const terminal = isBatchJobTerminal(r.status as BatchJobStatus);
      return {
        id: r.id,
        upstreamBatchId: r.upstreamBatchId,
        status: r.status,
        terminal,
        endpoint: r.endpoint,
        agentId: r.agentId,
        providerId: r.providerId,
        providerLabel: providerNames.get(r.providerId) ?? null,
        modelId: r.modelId,
        modelLabel: modelNames.get(r.modelId) ?? null,
        tierAssigned: r.tierAssigned,
        counts: { total: r.itemCount, completed: r.completedCount, failed: r.failedCount },
        submittedAt: r.submittedAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        terminalAt: r.terminalAt?.toISOString() ?? null,
        reservedCeilingMicros: terminal ? null : r.reservedCeilingMicros,
        settledCostMicros: terminal ? r.settledCostMicros : null,
        resultsExpireAt: r.resultsExpireAt?.toISOString() ?? null,
        errorKind: r.errorKind,
      };
    });
  }
}
