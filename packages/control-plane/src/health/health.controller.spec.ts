import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports ok', () => {
    expect(new HealthController().getHealth()).toEqual({ status: 'ok' });
  });
});
