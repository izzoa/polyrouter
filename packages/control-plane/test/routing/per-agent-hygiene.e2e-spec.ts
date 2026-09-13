// Agent hygiene: demotion, starvation recovery and revert
// (add-per-agent-calibration, tasks 5.2-5.5).
//
// Automatic promotion REQUIRES automatic demotion -- nothing else would ever
// take a pair away. And the ratchet needs a real recovery, not an assumed one:
// a homogeneous agent whose score mass sits inside an edge zone can have its
// threshold walked across that mass, after which every row bands confidently,
// stops being an ambiguous cascade row, and its evidence stream ends. v1
// assumed the next tenant move would rebase it; the silenced agent is usually
// the one supplying the volume, so its tenant's pool may never reach the floor
// again and there was no recovery at all.
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@polyrouter/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import { userPrincipal } from '@polyrouter/shared/server';
import { Pool } from 'pg';
import { buildPersistencePort } from '../../src/database/port';
import { buildCalibrationConfig, railsOf } from '../../src/calibration/calibration.config';
import { runCalibrationOccurrence } from '../../src/calibration/calibration.run';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/database/database.config';

const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
const INSTANCE = { high: 0.6, low: 0.25 };
const CFG = buildCalibrationConfig({
  CALIBRATION_SCHED_ENABLED: 'true',
  CALIBRATION_SCHED_CRON: '0 4 * * *',
  CALIBRATION_WINDOW_DAYS: 14,
  CALIBRATION_MIN_EDGE_SAMPLES: 50,
  CALIBRATION_STEP: 0.02,
  CALIBRATION_MAX_DRIFT: 0.1,
});
const silent = { warn: () => {}, log: () => {} };

describe('per-agent calibration hygiene (add-per-agent-calibration)', () => {
  let pool: Pool;
  let port: ReturnType<typeof buildPersistencePort>;
  let owner: string;

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

  beforeEach(async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO "user" (id, name, email, email_verified)
       VALUES (gen_random_uuid(), 'hyg', $1, true) RETURNING id`,
      [`hyg-${Date.now()}-${randomUUID()}@cal.test`],
    );
    owner = rows[0]!.id;
  });

  afterEach(async () => {
    await pool?.query(`DELETE FROM "user" WHERE id=$1`, [owner]).catch(() => undefined);
  });

  const settings = async (over: Record<string, unknown> = {}): Promise<void> => {
    await pool.query(
      `INSERT INTO routing_settings
         (id, owner_user_id, structural_enabled, cascade_enabled, calibration_enabled,
          calibrated_high, calibrated_low, calibrated_anchor_high, calibrated_anchor_low,
          calibration_epoch)
       VALUES (gen_random_uuid(), $1, true, $2, $3, $4, $5, $6, $7, $8)`,
      [
        owner,
        over.cascadeEnabled ?? true,
        over.calibrationEnabled ?? false,
        over.high ?? null,
        over.low ?? null,
        over.anchorHigh ?? null,
        over.anchorLow ?? null,
        over.epoch ?? 0,
      ],
    );
  };

  const seedAgent = async (
    label: string,
    pair: { high: number; low: number; anchorHigh: number; anchorLow: number } | null,
  ): Promise<string> => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO agent (id, owner_user_id, name, api_key_hash, api_key_prefix, harness_type,
         calibrated_high, calibrated_low, calibrated_anchor_high, calibrated_anchor_low,
         calibration_epoch)
       VALUES ($1,$2,$3,'h',$4,'generic',$5,$6,$7,$8,1)`,
      [
        id,
        owner,
        label,
        `poly_${label}_${randomUUID().slice(0, 8)}`,
        pair?.high ?? null,
        pair?.low ?? null,
        pair?.anchorHigh ?? null,
        pair?.anchorLow ?? null,
      ],
    );
    return id;
  };

  const pairOf = async (id: string): Promise<number | null> => {
    const { rows } = await pool.query<{ calibrated_high: number | null }>(
      `SELECT calibrated_high FROM agent WHERE id=$1`,
      [id],
    );
    return rows[0]!.calibrated_high;
  };

  const sweep = (): Promise<unknown> =>
    runCalibrationOccurrence(port, INSTANCE, CFG, railsOf(CFG), Date.now(), silent);

  describe('demotion by stale anchor (task 5.2)', () => {
    it('clears a pair whose anchor no longer matches the tenant pair', async () => {
      // The tenant now sits at 0.55/0.30; this agent is anchored to 0.6/0.25.
      await settings({ high: 0.55, low: 0.3, anchorHigh: 0.6, anchorLow: 0.25, epoch: 1 });
      const stale = await seedAgent('stale', {
        high: 0.58,
        low: 0.27,
        anchorHigh: 0.6,
        anchorLow: 0.25,
      });
      await sweep();
      expect(await pairOf(stale)).toBeNull();
    });

    it('runs even for a tenant with calibration switched OFF', async () => {
      // Otherwise a disabled tenant's agent pair could lurk in storage and
      // silently reactivate if the tenant pair later returned to its old value.
      await settings({
        calibrationEnabled: false,
        high: 0.55,
        low: 0.3,
        anchorHigh: 0.6,
        anchorLow: 0.25,
        epoch: 1,
      });
      const stale = await seedAgent('stale-off', {
        high: 0.58,
        low: 0.27,
        anchorHigh: 0.6,
        anchorLow: 0.25,
      });
      await sweep();
      expect(await pairOf(stale)).toBeNull();
    });

    it('leaves a correctly-anchored pair alone', async () => {
      await settings({ high: 0.55, low: 0.3, anchorHigh: 0.6, anchorLow: 0.25, epoch: 1 });
      const ok = await seedAgent('anchored', {
        high: 0.53,
        low: 0.32,
        anchorHigh: 0.55,
        anchorLow: 0.3,
      });
      // Live decided evidence INSIDE this agent's own high edge zone, which for
      // a 0.53 high is [0.48, 0.53) — not the tenant's [0.50, 0.55). The zones
      // move with the pair, which is the point of having one.
      await seedDecided(ok, 4, 0.5);
      await sweep();
      expect(await pairOf(ok)).toBeCloseTo(0.53, 4);
    });
  });

  describe('starvation recovery (task 5.3) — the rail v1 lacked', () => {
    it('clears the pair of an agent that is ALIVE but produces no decided rows', async () => {
      await settings();
      const silenced = await seedAgent('silenced', {
        high: 0.55,
        low: 0.3,
        anchorHigh: 0.6,
        anchorLow: 0.25,
      });
      // Traffic, but every row bands confidently now — the ratchet closed.
      await seedConfident(silenced, 30);
      await sweep();
      expect(await pairOf(silenced)).toBeNull();
    });

    it('does NOT clear an agent that is merely unused', async () => {
      // No rows at all. Clearing here would punish absence rather than repair a
      // ratchet, and would retire pairs over a quiet weekend.
      await settings();
      const idle = await seedAgent('idle', {
        high: 0.55,
        low: 0.3,
        anchorHigh: 0.6,
        anchorLow: 0.25,
      });
      await sweep();
      expect(await pairOf(idle)).toBeCloseTo(0.55, 4);
    });

    it('is SUPPRESSED while cascade is off for the tenant', async () => {
      // The evidence population requires decision_layer='cascade'. Without this
      // suppression, switching cascade off would retire every agent pair one
      // window later, though no pair silenced anything.
      await settings({ cascadeEnabled: false });
      const parked = await seedAgent('parked', {
        high: 0.55,
        low: 0.3,
        anchorHigh: 0.6,
        anchorLow: 0.25,
      });
      await seedConfident(parked, 30);
      await sweep();
      expect(await pairOf(parked)).toBeCloseTo(0.55, 4);
    });
  });

  describe('revert (tasks 5.4, 5.5)', () => {
    it('clears one agent on user-wins terms, leaving the tenant and siblings alone', async () => {
      await settings({ high: 0.55, low: 0.3, anchorHigh: 0.6, anchorLow: 0.25, epoch: 1 });
      const a = await seedAgent('revert-a', {
        high: 0.53,
        low: 0.32,
        anchorHigh: 0.55,
        anchorLow: 0.3,
      });
      const b = await seedAgent('revert-b', {
        high: 0.53,
        low: 0.32,
        anchorHigh: 0.55,
        anchorLow: 0.3,
      });

      const ok = await port.agentCalibration.setCalibrated(
        userPrincipal(owner),
        a,
        null,
        { high: 0.53, low: 0.32, anchorHigh: 0.55, anchorLow: 0.3, epoch: 1 },
        null, // user-wins: no parent pin
        {
          trigger: 'revert',
          oldHigh: 0.53,
          oldLow: 0.32,
          newHigh: 0.55,
          newLow: 0.3,
          anchorHigh: 0.55,
          anchorLow: 0.3,
          reason: 'user revert',
        },
      );
      expect(ok).toBe(true);
      expect(await pairOf(a)).toBeNull();
      expect(await pairOf(b)).toBeCloseTo(0.53, 4); // sibling untouched

      const { rows: tenant } = await pool.query<{ calibrated_high: number }>(
        `SELECT calibrated_high FROM routing_settings WHERE owner_user_id=$1`,
        [owner],
      );
      expect(tenant[0]!.calibrated_high).toBeCloseTo(0.55, 4); // tenant untouched
    });

    it('reverting the TENANT does not clear agent pairs directly — hygiene resolves them', async () => {
      // Task 5.5. The tenant revert touches only the tenant row; the agent pair
      // becomes STALE by anchor and Pass A2 retires it on the next sweep. That
      // indirection is what keeps the two levels' write paths independent.
      await settings({ high: 0.55, low: 0.3, anchorHigh: 0.6, anchorLow: 0.25, epoch: 1 });
      const child = await seedAgent('child', {
        high: 0.53,
        low: 0.32,
        anchorHigh: 0.55,
        anchorLow: 0.3,
      });

      await port.routingSettings.clearCalibrated(userPrincipal(owner), () => ({
        trigger: 'revert',
        oldHigh: 0.55,
        oldLow: 0.3,
        newHigh: 0.6,
        newLow: 0.25,
        anchorHigh: 0.6,
        anchorLow: 0.25,
        reason: 'tenant revert',
      }));

      // Immediately after the revert the agent row is UNCHANGED...
      expect(await pairOf(child)).toBeCloseTo(0.53, 4);
      // ...but its anchor no longer matches, so it is already inert to routing,
      // and the next sweep retires it.
      await sweep();
      expect(await pairOf(child)).toBeNull();
    });
  });

  /** Decided ambiguous cascade rows at the agent's own scope and epoch. */
  async function seedDecided(agentId: string, n: number, score: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      await pool.query(
        `INSERT INTO request_log
          (id, owner_user_id, agent_id, decision_layer, routing_reason, input_tokens,
           output_tokens, usage_estimated, duration_ms, status, escalated, created_at,
           structural_band, structural_score, structural_band_source,
           structural_epoch, structural_scope, quality_signal)
         VALUES ($1,$2,$3,'cascade','t',10,5,false,1,'success',false,now(),
                 'ambiguous',$4,'threshold',1,'agent',1)`,
        [randomUUID(), owner, agentId, score],
      );
    }
  }

  /** Live traffic that produces NO calibration evidence — the ratchet closed. */
  async function seedConfident(agentId: string, n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      await pool.query(
        `INSERT INTO request_log
          (id, owner_user_id, agent_id, decision_layer, routing_reason, input_tokens,
           output_tokens, usage_estimated, duration_ms, status, escalated, created_at,
           structural_band, structural_score, structural_band_source,
           structural_epoch, structural_scope, quality_signal)
         VALUES ($1,$2,$3,'structural','t',10,5,false,1,'success',false,now(),
                 'high',0.9,'threshold',1,'agent',1)`,
        [randomUUID(), owner, agentId],
      );
    }
  }
});
