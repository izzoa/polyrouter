import { Body, Controller, Delete, Get, Header, Param, Patch, Post, Query } from '@nestjs/common';
import { BudgetProgressService } from './budget-progress.service';
import { BudgetProgressQueryDto } from './budget-progress.dto';
import type { Principal } from '@polyrouter/shared/server';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { BudgetsCrudService } from './budgets.crud';
import { CreateBudgetDto, UpdateBudgetDto } from './budgets.dto';

/** Session-guarded (the global `SessionGuard` covers `/api`) owner-scoped budget
 * CRUD (#16, spec §5/§10). Every access is tenant-isolated via `db.budgets`. */
@Controller('api/budgets')
export class BudgetsController {
  constructor(
    private readonly svc: BudgetsCrudService,
    private readonly progress: BudgetProgressService,
  ) {}

  @Get()
  list(@CurrentPrincipal() principal: Principal) {
    return this.svc.list(principal);
  }

  @Get('progress')
  @Header('Cache-Control', 'no-store')
  getProgress(@CurrentPrincipal() principal: Principal, @Query() query: BudgetProgressQueryDto) {
    return this.progress.read(principal, query.ids);
  }

  @Get(':id')
  get(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.svc.get(principal, id);
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  create(@CurrentPrincipal() principal: Principal, @Body() dto: CreateBudgetDto) {
    return this.svc.create(principal, dto);
  }

  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() dto: UpdateBudgetDto,
  ) {
    return this.svc.update(principal, id, dto);
  }

  @Delete(':id')
  @Header('Cache-Control', 'no-store')
  remove(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.svc.remove(principal, id);
  }
}
