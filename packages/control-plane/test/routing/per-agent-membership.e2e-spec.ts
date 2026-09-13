// Evidence MEMBERSHIP e2e (add-per-agent-calibration, tasks 4.1-4.3).
//
// Membership is legislated explicitly rather than emerging from the scope
// stamp, because v1 tried the latter and deadlocked: the stamp answers "which
// pair decided this row", which is a different question from "whose evidence is
// this row". Before an agent has a pair the honest answer to the second is
// BOTH, so an unpromoted agent has zero agent-scoped rows and could never earn
// a first pair.
//
// One seeded corpus exercises all three selections at once, so a predicate that
// over- or under-collects in any arm shows up as a wrong count in another.
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@polyrouter/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import { userPrincipal } from '@polyrouter/shared/server';
import { Pool } from 'pg';
import { buildPersistencePort } from '../../src/database/port';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/database/database.config';

const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;

/** Instance defaults; the high edge zone is [0.55, 0.60). */
const GEOMETRY = { high: 0.6, low: 0.25, edgeWidth: 0.05 };
const IN_HIGH_EDGE = 0.57;

describe('calibration evidence membership (add-per-agent-calibration)', () => {
  let pool: Pool;
  let port: ReturnType<typeof buildPersistencePort>;
  let owner: string;
  /** `promoted` holds its own pair; `plain` does not. */
  let promoted: string;
  let plain: string;

  const range = (): { from: Date; to: Date } => ({
    from: new Date(Date.now() - 14 * 86_400_000),
    to: new Date(Date.now() + 60_000),
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    try {
      await pool.query('SELECT 1');
    } catch (e) {
      throw new Error(`${COMPOSE_HINT}\n${String(e)}`);
    }
    port = buildPersistencePort(drizzle(pool));
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO "user" (id, name, email, email_verified)
       VALUES (gen_random_uuid(), 'mem', $1, true) RETURNING id`,
      [`mem-${Date.now()}-${randomUUID()}@cal.test`],
    );
    owner = rows[0]!.id;
    promoted = await seedAgent('promoted');
    plain = await seedAgent('plain');
    // `promoted` carries a pair anchored to the instance defaults.
    await pool.query(
      `UPDATE agent SET calibrated_high=0.55, calibrated_low=0.30,
         calibrated_anchor_high=0.6, calibrated_anchor_low=0.25, calibration_epoch=2
       WHERE id=$1`,
      [promoted],
    );
  });

  afterAll(async () => {
    await pool?.query(`DELETE FROM "user" WHERE id=$1`, [owner]).catch(() => undefined);
    await pool?.end();
  });

  async function seedAgent(label: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO agent (id, owner_user_id, name, api_key_hash, api_key_prefix, harness_type)
       VALUES ($1,$2,$3,'h',$4,'generic')`,
      [id, owner, label, `poly_${label}_${randomUUID().slice(0, 8)}`],
    );
    return id;
  }

  /** A quality-DECIDED, threshold-source ambiguous cascade row in the high edge. */
  async function seedRow(
    agentId: string | null,
    scope: string | null,
    epoch: number | null,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO request_log
        (id, owner_user_id, agent_id, decision_layer, routing_reason, input_tokens,
         output_tokens, usage_estimated, duration_ms, status, escalated, created_at,
         structural_band, structural_score, structural_band_source,
         structural_epoch, structural_scope, quality_signal)
       VALUES ($1,$2,$3,'cascade','t',10,5,false,1,'success',false,now(),
               'ambiguous',$4,'threshold',$5,$6,1)`,
      [randomUUID(), owner, agentId, IN_HIGH_EDGE, epoch, scope],
    );
  }

  const stats = (
    scope?: Parameters<typeof port.analytics.calibrationStats>[2]['scope'],
  ): Promise<{ highEdge: { samples: number } }> =>
    port.analytics.calibrationStats(userPrincipal(owner), range(), {
      ...GEOMETRY,
      epoch: 0,
      ...(scope ? { scope } : {}),
    });

  describe('the three selections over one corpus (task 4.1)', () => {
    beforeAll(async () => {
      // `plain` — no pair, so its rows are tenant-scoped and belong to BOTH the
      // tenant pool and its own bootstrap pool.
      await seedRow(plain, 'tenant', 0);
      await seedRow(plain, 'tenant', 0);
      await seedRow(plain, null, 0); // pre-migration shape: reads as tenant
      // `promoted` — rows decided under its OWN pair, at ITS epoch (2).
      await seedRow(promoted, 'agent', 2);
      await seedRow(promoted, 'agent', 2);
      await seedRow(promoted, 'agent', 2);
      await seedRow(promoted, 'agent', 2);
      // `promoted` — residual tenant-scoped rows from BEFORE it was promoted.
      await seedRow(promoted, 'tenant', 0);
      await seedRow(promoted, 'tenant', 0);
      // A keyless row (no agent): tenant evidence, nobody's bootstrap.
      await seedRow(null, 'tenant', 0);
      // Wrong epoch and wrong scope: must not appear anywhere.
      await seedRow(plain, 'tenant', 9);
      await seedRow(plain, 'agent', 0);
    });

    it('the TENANT sees only rows whose agent holds no pair', async () => {
      // 2 tenant-scoped + 1 null-scoped from `plain`, plus the keyless row = 4.
      // `promoted`'s two residual tenant-scoped rows are EXCLUDED because it
      // holds a pair now — that is immediate exclusion, not eventual.
      const t = await stats();
      expect(t.highEdge.samples).toBe(4);
    });

    it('an UNPROMOTED agent bootstraps from its own tenant-scoped rows', async () => {
      // This is the selection v1 could not express, and its absence is why v1
      // deadlocked: 0 rows would mean no agent could ever earn a first pair.
      const b = await stats({ kind: 'agent-bootstrap', agentId: plain });
      expect(b.highEdge.samples).toBe(3);
    });

    it('a PROMOTED agent draws only agent-scoped rows at its own epoch', async () => {
      const a = await port.analytics.calibrationStats(userPrincipal(owner), range(), {
        ...GEOMETRY,
        epoch: 2, // the AGENT's epoch, not the tenant's
        scope: { kind: 'agent', agentId: promoted },
      });
      expect(a.highEdge.samples).toBe(4);
    });

    it('never lets a null scope count as AGENT evidence', async () => {
      // Null-scoped rows predate the column; no agent pair decided them. The
      // asymmetry (null reads as tenant, never as agent) is what lets the
      // migration keep every tenant's window without inventing agent evidence.
      await seedRow(promoted, null, 2);
      const a = await port.analytics.calibrationStats(userPrincipal(owner), range(), {
        ...GEOMETRY,
        epoch: 2,
        scope: { kind: 'agent', agentId: promoted },
      });
      expect(a.highEdge.samples).toBe(4); // unchanged
    });
  });

  describe('immediate exclusion (task 4.3)', () => {
    it("a newly-promoted agent's residual rows leave the tenant pool at once", async () => {
      const fresh = await seedAgent('fresh');
      // Fourteen days of residual tenant-scoped rows, as an inheriting agent.
      for (let i = 0; i < 5; i += 1) await seedRow(fresh, 'tenant', 0);

      const before = await stats();
      const boot = await stats({ kind: 'agent-bootstrap', agentId: fresh });
      expect(boot.highEdge.samples).toBe(5);

      // It earns a pair. Nothing about its existing rows changes.
      await pool.query(
        `UPDATE agent SET calibrated_high=0.55, calibrated_low=0.30,
           calibrated_anchor_high=0.6, calibrated_anchor_low=0.25 WHERE id=$1`,
        [fresh],
      );

      // The VERY NEXT tenant selection drops all five. Waiting for them to age
      // out is what broke v1: they would keep moving the tenant pair, which
      // stales the new agent's anchor, which makes hygiene clear the pair it
      // just earned — with a 3-day tenant cooldown against weeks of agent
      // accumulation, the pair could never survive long enough to route on.
      const after = await stats();
      expect(after.highEdge.samples).toBe(before.highEdge.samples - 5);
    });
  });
});
