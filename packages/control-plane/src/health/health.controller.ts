import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/principal.decorator';

/** Unauthenticated health endpoint; packaging (spec §13) wires it to
 * orchestration. `@Public()` exempts it from the session guard. */
@Controller('api/health')
export class HealthController {
  @Get()
  @Public()
  getHealth(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
