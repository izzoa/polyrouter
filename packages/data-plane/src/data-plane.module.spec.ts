import 'reflect-metadata';
import { APP_NAME } from '@polyrouter/shared';
import { DataPlaneModule } from './data-plane.module';

describe('DataPlaneModule', () => {
  it('exports a Nest module', () => {
    expect(DataPlaneModule).toBeDefined();
    expect(typeof DataPlaneModule).toBe('function');
  });

  it('resolves the shared package through its CJS entrypoint (interop smoke)', () => {
    expect(APP_NAME).toBe('polyrouter');
  });
});
