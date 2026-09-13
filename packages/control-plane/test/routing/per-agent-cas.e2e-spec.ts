// The two-sided CAS protocol (add-per-agent-calibration, design Decision 7).
//
// The Critical this closes: membership was evaluated at SELECTION time while
// the conditional writer compared only `routing_settings`. A sweep in flight
// could then commit a tenant move computed from a now-promoted agent's rows:
//
//   S1 reads tenant evidence   [agent A unpromoted -> A's rows ARE in the pool]
//   S2 promotes A, anchored to the tenant pair T0
//   S1 commits a tenant move   -> T1, which stales A's anchor
//                              -> A's pair is inert, hygiene clears it
//
// A is demoted by a move it was itself counted toward, one sweep after earning
// a pair -- v1's retention failure through a different door. Both directions
// must now lose cleanly to the other.
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@polyrouter/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import { userPrincipal } from '@polyrouter/shared/server';
import { Pool } from 'pg';
import { buildPersistencePort } from '../../src/database/port';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/database/database.config';

const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;

describe('per-agent calibration CAS (add-per-agent-calibration)', () => {
  let pool: Pool;
  let port: ReturnType<typeof buildPersistencePort>;
  let owner: string;
  let agent: string;

  const principal = (): ReturnType<typeof userPrincipal> => userPrincipal(owner);

  const event = {
    trigger: 'calibrator' as const,
    oldHigh: 0.55,
    oldLow: 0.3,
    newHigh: 0.53,
    newLow: 0.3,
    anchorHigh: 0.55,
    anchorLow: 0.3,
    reason: 'test',
  };

  beforeEach(async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO "user" (id, name, email, email_verified)
       VALUES (gen_random_uuid(), 'cas', $1, true) RETURNING id`,
      [`cas-${Date.now()}-${randomUUID()}@cal.test`],
    );
    owner = rows[0]!.id;
    await pool.query(
      `INSERT INTO routing_settings
         (id, owner_user_id, structural_enabled, cascade_enabled, calibration_enabled,
          calibrated_high, calibrated_low, calibrated_anchor_high, calibrated_anchor_low,
          calibration_epoch)
       VALUES (gen_random_uuid(), $1, true, true, true, 0.55, 0.30, 0.6, 0.25, 1)`,
      [owner],
    );
    agent = randomUUID();
    await pool.query(
      `INSERT INTO agent (id, owner_user_id, name, api_key_hash, api_key_prefix, harness_type)
       VALUES ($1,$2,'a','h',$3,'generic')`,
      [agent, owner, `poly_${randomUUID().slice(0, 8)}`],
    );
  });

  afterEach(async () => {
    await pool?.query(`DELETE FROM "user" WHERE id=$1`, [owner]).catch(() => undefined);
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 6 });
    try {
      await pool.query('SELECT 1');
    } catch (e) {
      throw new Error(`${COMPOSE_HINT}\n${String(e)}`);
    }
    port = buildPersistencePort(drizzle(pool));
  });

  afterAll(async () => {
    await pool?.end();
  });

  const emptyExpected = {
    high: null,
    low: null,
    anchorHigh: null,
    anchorLow: null,
    epoch: 0,
  };
  const promotionQuad = { high: 0.53, low: 0.32, anchorHigh: 0.55, anchorLow: 0.3 };
  const pinAt = (generation: number): { high: number; low: number; epoch: number; membershipGeneration: number } => ({
    high: 0.55,
    low: 0.3,
    epoch: 1,
    membershipGeneration: generation,
  });

  const generation = async (): Promise<number> => {
    const { rows } = await pool.query<{ membership_generation: number }>(
      `SELECT membership_generation FROM routing_settings WHERE owner_user_id=$1`,
      [owner],
    );
    return rows[0]!.membership_generation;
  };

  describe('promotion', () => {
    it('succeeds against the pinned parent and bumps the generation', async () => {
      expect(await generation()).toBe(0);
      const ok = await port.agentCalibration.setCalibrated(
        principal(),
        agent,
        promotionQuad,
        emptyExpected,
        pinAt(0),
        event,
      );
      expect(ok).toBe(true);
      expect(await generation()).toBe(1);
    });

    it('FAILS when the tenant pair moved first', async () => {
      // The tenant write landed between this sweep's evidence read and its
      // write. The promotion would otherwise produce a pair stale on arrival.
      await pool.query(
        `UPDATE routing_settings SET calibrated_high=0.53, calibration_epoch=2
         WHERE owner_user_id=$1`,
        [owner],
      );
      const ok = await port.agentCalibration.setCalibrated(
        principal(),
        agent,
        promotionQuad,
        emptyExpected,
        pinAt(0),
        event,
      );
      expect(ok).toBe(false);
      expect(await generation()).toBe(0); // nothing bumped on a refused write
      const { rows } = await pool.query(`SELECT calibrated_high FROM agent WHERE id=$1`, [agent]);
      expect(rows[0]).toEqual({ calibrated_high: null });
    });

    it('FAILS when membership moved under it', async () => {
      // Another agent gained or lost a pair since the evidence was read.
      await pool.query(
        `UPDATE routing_settings SET membership_generation=5 WHERE owner_user_id=$1`,
        [owner],
      );
      const ok = await port.agentCalibration.setCalibrated(
        principal(),
        agent,
        promotionQuad,
        emptyExpected,
        pinAt(0),
        event,
      );
      expect(ok).toBe(false);
    });
  });

  describe('the tenant write loses to a promotion (the interleaving itself)', () => {
    it('refuses a tenant move computed before an agent was promoted', async () => {
      // S1 reads the tenant's evidence: generation 0, pair 0.55/0.30, epoch 1.
      const readGeneration = await generation();

      // S2 promotes the agent.
      expect(
        await port.agentCalibration.setCalibrated(
          principal(),
          agent,
          promotionQuad,
          emptyExpected,
          pinAt(readGeneration),
          event,
        ),
      ).toBe(true);

      // S1 now tries to commit. Its evidence included the agent's rows, which
      // no longer belong to the tenant's population.
      const applied = await port.routingSettings.setCalibrated(
        principal(),
        { high: 0.53, low: 0.3, anchorHigh: 0.6, anchorLow: 0.25 },
        {
          enabled: true,
          high: 0.55,
          low: 0.3,
          anchorHigh: 0.6,
          anchorLow: 0.25,
          epoch: 1,
          membershipGeneration: readGeneration,
        },
        { ...event, anchorHigh: 0.6, anchorLow: 0.25 },
      );
      expect(applied).toBe(false);

      // And the agent keeps the pair it just earned — the whole point.
      const { rows } = await pool.query<{ calibrated_high: number }>(
        `SELECT calibrated_high FROM agent WHERE id=$1`,
        [agent],
      );
      expect(rows[0]!.calibrated_high).toBe(0.53);
    });

    it('still applies a tenant move when membership did NOT change', async () => {
      // The control: without this the test above would pass for a rail that
      // refuses every tenant write.
      const applied = await port.routingSettings.setCalibrated(
        principal(),
        { high: 0.53, low: 0.3, anchorHigh: 0.6, anchorLow: 0.25 },
        {
          enabled: true,
          high: 0.55,
          low: 0.3,
          anchorHigh: 0.6,
          anchorLow: 0.25,
          epoch: 1,
          membershipGeneration: 0,
        },
        { ...event, anchorHigh: 0.6, anchorLow: 0.25 },
      );
      expect(applied).toBe(true);
    });
  });

  describe('clear and revert do NOT pin the parent (r2b High-1)', () => {
    beforeEach(async () => {
      await port.agentCalibration.setCalibrated(
        principal(),
        agent,
        promotionQuad,
        emptyExpected,
        pinAt(0),
        event,
      );
      // The tenant then moves, staling the agent's anchor. This is exactly the
      // state hygiene exists to clear.
      await pool.query(
        `UPDATE routing_settings SET calibrated_high=0.53, calibration_epoch=9
         WHERE owner_user_id=$1`,
        [owner],
      );
    });

    it('clears a stale pair even though the parent moved', async () => {
      // With a parent CAS this would expect the OLD tuple, find the new one,
      // and no-op forever on the one state that requires clearing.
      const ok = await port.agentCalibration.setCalibrated(
        principal(),
        agent,
        null,
        { high: 0.53, low: 0.32, anchorHigh: 0.55, anchorLow: 0.3, epoch: 1 },
        null, // no pin — a retreat to the level above is correct against any parent
        { ...event, trigger: 'rebase' },
      );
      expect(ok).toBe(true);
      const { rows } = await pool.query(`SELECT calibrated_high FROM agent WHERE id=$1`, [agent]);
      expect(rows[0]).toEqual({ calibrated_high: null });
    });

    it('bumps the generation on the clear, but not on a repeat', async () => {
      const before = await generation();
      await port.agentCalibration.setCalibrated(
        principal(),
        agent,
        null,
        { high: 0.53, low: 0.32, anchorHigh: 0.55, anchorLow: 0.3, epoch: 1 },
        null,
        { ...event, trigger: 'rebase' },
      );
      expect(await generation()).toBe(before + 1);

      // A second clear is a no-op transition (null -> null). Bumping again
      // would manufacture failed tenant writes out of nothing, and could drive
      // a clear/fail/staler/clear cycle.
      await port.agentCalibration.setCalibrated(
        principal(),
        agent,
        null,
        { high: null, low: null, anchorHigh: null, anchorLow: null, epoch: 2 },
        null,
        { ...event, trigger: 'revert' },
      );
      expect(await generation()).toBe(before + 1);
    });
  });
});
