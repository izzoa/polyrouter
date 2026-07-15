import { describe, expect, it } from 'vitest';
import * as root from '../src/index';
import * as server from '../src/server';

describe('server entrypoint separation (monorepo-workspace)', () => {
  it('the root entrypoint re-exports no server-only symbols', () => {
    for (const symbol of [
      'encryptSecret',
      'decryptSecret',
      'ownershipPredicate',
      'userPrincipal',
      'PERSISTENCE_PORT',
      'users',
      'agents',
      'providers',
      'tiers',
    ]) {
      expect(root).not.toHaveProperty(symbol);
    }
  });

  it('the server entrypoint carries the schema, tenancy, and encryption surface', () => {
    for (const symbol of [
      'encryptSecret',
      'decryptSecret',
      'ownershipPredicate',
      'assertUserPrincipal',
      'userPrincipal',
      'PERSISTENCE_PORT',
      'PERSISTENCE_FACILITIES',
      'REDIS_CLIENT',
      'users',
      'agents',
      'providers',
      'models',
      'tiers',
      'routingEntries',
      'routingRules',
    ]) {
      expect(server).toHaveProperty(symbol);
    }
  });
});
