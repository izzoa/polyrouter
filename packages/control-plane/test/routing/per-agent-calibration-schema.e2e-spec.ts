// Per-agent calibration SCHEMA e2e (add-per-agent-calibration, tasks 1.1-1.3).
//
// The migration is purely additive and backfill-free, which is easy to claim
// and easy to get wrong. Three things are pinned here against a real Postgres:
//
//  1. The `agent` quad's constraints actually reject what they promise — a
//     PARTIAL quad, an inverted pair, and an inverted ANCHOR. The anchor check
//     matters as much as the pair: an inverted anchor can never equal a valid
//     tenant pair, so such a row would be permanently inert rather than merely
//     wrong, failing silently forever.
//  2. Existing rows are NOT rewritten. Every added column is nullable or
//     defaulted, so a populated database keeps its values and its NULLs.
//  3. The null-scope reading rule holds: a `structural_epoch`-stamped row with
//     a NULL `structural_scope` is the pre-migration shape, and tenant-scope
//     evidence selection must still count it. If it did not, the migration
//     would silently discard every tenant's current evidence window — the
//     failure mode the scope column was designed to avoid.
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@polyrouter/shared';
import { Pool } from 'pg';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/database/database.config';

const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;

describe('per-agent calibration schema (add-per-agent-calibration)', () => {
  let pool: Pool;
  let owner: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    try {
      await pool.query('SELECT 1');
    } catch (e) {
      throw new Error(`${COMPOSE_HINT}\n${String(e)}`);
    }
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO "user" (id, name, email, email_verified)
       VALUES (gen_random_uuid(), 'pac', $1, true) RETURNING id`,
      [`pac-${Date.now()}-${randomUUID()}@cal.test`],
    );
    owner = rows[0]!.id;
  });

  afterAll(async () => {
    await pool?.query(`DELETE FROM "user" WHERE id = $1`, [owner]).catch(() => undefined);
    await pool?.end();
  });

  /** A minimal agent row; the calibrated columns default to NULL (inherited). */
  async function seedAgent(suffix: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO agent (id, owner_user_id, name, api_key_hash, api_key_prefix, harness_type)
       VALUES ($1, $2, $3, 'h', $4, 'generic')`,
      [id, owner, `a-${suffix}`, `poly_${suffix}_${randomUUID().slice(0, 8)}`],
    );
    return id;
  }

  const setQuad = (
    id: string,
    high: number | null,
    low: number | null,
    anchorHigh: number | null,
    anchorLow: number | null,
  ): Promise<unknown> =>
    pool.query(
      `UPDATE agent SET calibrated_high=$2, calibrated_low=$3,
         calibrated_anchor_high=$4, calibrated_anchor_low=$5 WHERE id=$1`,
      [id, high, low, anchorHigh, anchorLow],
    );

  describe('the agent quad travels together and stays ordered', () => {
    it('accepts a complete, ordered quad', async () => {
      const id = await seedAgent('ok');
      await expect(setQuad(id, 0.52, 0.32, 0.55, 0.3)).resolves.toBeDefined();
      const { rows } = await pool.query<{ calibration_epoch: number }>(
        `SELECT calibration_epoch FROM agent WHERE id=$1`,
        [id],
      );
      // The epoch is NOT NULL default 0 — a fresh agent starts at the same
      // place a fresh tenant does, which is what "no promotion event" means.
      expect(rows[0]!.calibration_epoch).toBe(0);
    });

    it('accepts all-NULL — the inherited default', async () => {
      const id = await seedAgent('null');
      await expect(setQuad(id, null, null, null, null)).resolves.toBeDefined();
    });

    it('rejects a PARTIAL quad', async () => {
      const id = await seedAgent('partial');
      // A pair with half an anchor is inert at read time; rejecting it here is
      // how the tenant scope avoids ever storing one.
      await expect(setQuad(id, 0.52, 0.32, null, null)).rejects.toThrow(/agent_calibration_quad/);
      await expect(setQuad(id, 0.52, null, 0.55, 0.3)).rejects.toThrow(/agent_calibration_quad/);
    });

    it('rejects an inverted PAIR', async () => {
      const id = await seedAgent('invpair');
      await expect(setQuad(id, 0.3, 0.52, 0.55, 0.3)).rejects.toThrow(/agent_calibration_range/);
    });

    it('rejects an inverted ANCHOR', async () => {
      const id = await seedAgent('invanchor');
      // The one that would fail SILENTLY: an inverted anchor can never equal a
      // valid tenant pair, so the row would be inert forever with no error.
      await expect(setQuad(id, 0.52, 0.32, 0.3, 0.55)).rejects.toThrow(/agent_calibration_range/);
    });

    it('rejects an out-of-range pair', async () => {
      const id = await seedAgent('range');
      await expect(setQuad(id, 1.5, 0.32, 0.55, 0.3)).rejects.toThrow(/agent_calibration_range/);
      await expect(setQuad(id, 0.52, -0.1, 0.55, 0.3)).rejects.toThrow(/agent_calibration_range/);
    });
  });

  describe('the migration rewrites nothing', () => {
    it('leaves an existing agent inheriting, with a zero epoch', async () => {
      const id = await seedAgent('inherit');
      const { rows } = await pool.query(
        `SELECT calibrated_high, calibrated_low, calibrated_anchor_high,
                calibrated_anchor_low, calibration_epoch FROM agent WHERE id=$1`,
        [id],
      );
      expect(rows[0]).toEqual({
        calibrated_high: null,
        calibrated_low: null,
        calibrated_anchor_high: null,
        calibrated_anchor_low: null,
        calibration_epoch: 0,
      });
    });

    it('starts every tenant at membership generation 0', async () => {
      await pool.query(
        `INSERT INTO routing_settings (id, owner_user_id, structural_enabled, cascade_enabled)
         VALUES (gen_random_uuid(), $1, true, true)
         ON CONFLICT (owner_user_id) DO NOTHING`,
        [owner],
      );
      const { rows } = await pool.query<{ membership_generation: number }>(
        `SELECT membership_generation FROM routing_settings WHERE owner_user_id=$1`,
        [owner],
      );
      expect(rows[0]!.membership_generation).toBe(0);
    });
  });

  describe('structural_scope', () => {
    const seedRow = (scope: string | null, epoch: number | null): Promise<unknown> =>
      pool.query(
        `INSERT INTO request_log
          (id, owner_user_id, decision_layer, routing_reason, input_tokens, output_tokens,
           usage_estimated, duration_ms, status, escalated, created_at,
           structural_band, structural_score, structural_band_source,
           structural_epoch, structural_scope, quality_signal)
         VALUES ($1,$2,'cascade','t',10,5,false,1,'success',false,now(),
                 'ambiguous',0.57,'threshold',$3,$4,1)`,
        [randomUUID(), owner, epoch, scope],
      );

    it('accepts the two valid values and NULL', async () => {
      await expect(seedRow('tenant', 0)).resolves.toBeDefined();
      await expect(seedRow('agent', 0)).resolves.toBeDefined();
      await expect(seedRow(null, 0)).resolves.toBeDefined();
    });

    it('rejects anything else', async () => {
      await expect(seedRow('org', 0)).rejects.toThrow(/request_log_structural_scope_valid/);
    });

    it('permits a stamped epoch beside a NULL scope — the pre-migration shape', async () => {
      // Deliberately NOT constrained together. Tenant selection must keep
      // reading these rows, or the migration discards every tenant's evidence
      // window at the moment it runs.
      await expect(seedRow(null, 7)).resolves.toBeDefined();
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM request_log
          WHERE owner_user_id=$1 AND structural_epoch IS NOT NULL AND structural_scope IS NULL`,
        [owner],
      );
      expect(Number(rows[0]!.n)).toBeGreaterThan(0);
    });
  });

  describe('threshold_calibration_event.agent_id', () => {
    it('accepts a null agent (tenant scope) and a free-text agent id', async () => {
      const write = (agentId: string | null): Promise<unknown> =>
        pool.query(
          `INSERT INTO threshold_calibration_event
            (id, owner_user_id, trigger, old_high, old_low, new_high, new_low,
             anchor_high, anchor_low, reason, agent_id)
           VALUES ($1,$2,'calibrator',0.6,0.25,0.58,0.25,0.6,0.25,'{}',$3)`,
          [randomUUID(), owner, agentId],
        );
      await expect(write(null)).resolves.toBeDefined();
      // No FK, deliberately: the audit is append-only and must survive the
      // agent being deleted. A retained event naming a vanished agent is the
      // honest record; a cascade would erase a threshold move that really
      // happened.
      await expect(write(randomUUID())).resolves.toBeDefined();
    });

    it('survives the agent being deleted, with agent_id preserved', async () => {
      // Task 1.4. The audit is the record of thresholds that really moved; a
      // cascade would delete that history the moment an agent was rotated out,
      // and `request_log` already retains a denormalized `agent_id` for the
      // same reason.
      const id = await seedAgent('deleted');
      await pool.query(
        `INSERT INTO threshold_calibration_event
          (id, owner_user_id, trigger, old_high, old_low, new_high, new_low,
           anchor_high, anchor_low, reason, agent_id)
         VALUES ($1,$2,'calibrator',0.55,0.30,0.53,0.30,0.55,0.30,'{}',$3)`,
        [randomUUID(), owner, id],
      );
      await pool.query(`DELETE FROM agent WHERE id=$1`, [id]);

      const { rows } = await pool.query<{ agent_id: string }>(
        `SELECT agent_id FROM threshold_calibration_event WHERE agent_id=$1`,
        [id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.agent_id).toBe(id);
      // And the agent really is gone — otherwise this asserts nothing.
      const { rows: gone } = await pool.query(`SELECT id FROM agent WHERE id=$1`, [id]);
      expect(gone).toHaveLength(0);
    });
  });
});
