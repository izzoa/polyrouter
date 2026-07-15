import { Controller, Get } from '@nestjs/common';

/** Unauthenticated health endpoint; packaging (spec §13) wires it to orchestration. */
@Controller('api/health')
export class HealthController {
  @Get()
  getHealth(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
