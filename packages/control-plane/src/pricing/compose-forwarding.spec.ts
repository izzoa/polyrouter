import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** r3-High-1 regression: the documented one-line opt-out MUST reach the
 * container — compose forwards both scheduler keys (a doc'd `.env` control
 * that compose drops is a broken promise, not a config). */
describe('docker-compose forwards the pricing-scheduler env keys', () => {
  it('app.environment carries both PRICING_REFRESH_SCHED_* keys', () => {
    const compose = readFileSync(join(__dirname, '../../../../docker-compose.yml'), 'utf8');
    expect(compose).toContain('PRICING_REFRESH_SCHED_ENABLED:');
    expect(compose).toContain('PRICING_REFRESH_SCHED_CRON:');
  });
});
