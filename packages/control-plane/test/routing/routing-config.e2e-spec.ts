// Routing-config e2e (real Postgres). Stub principal guard (no better-auth);
// each tenant's default tier + provider/models are seeded through the port.
import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { loadConfig } from '@polyrouter/shared';
import {
  PERSISTENCE_PORT,
  userPrincipal,
  type PersistencePort,
  type Principal,
} from '@polyrouter/shared/server';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Pool } from 'pg';
import { configureApp } from '../../src/app.setup';
import type { AuthedRequest } from '../../src/auth/principal.decorator';
import { RoutingConfigModule } from '../../src/routing-config/routing-config.module';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/database/database.config';

const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;

@Injectable()
class TestPrincipalGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const u = req.headers['x-test-user'];
    if (typeof u === 'string' && u.length > 0) {
      req.principal = userPrincipal(u);
      return true;
    }
    throw new UnauthorizedException();
  }
}

interface Tenant {
  userId: string;
  principal: Principal;
  modelIds: string[];
}

async function seedTenant(port: PersistencePort, pool: Pool, label: string): Promise<Tenant> {
  const userId = (
    await pool.query<{ id: string }>(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), $1, $2, true) RETURNING id`,
      [label, `${label}-${Date.now()}@routing.test`],
    )
  ).rows[0]!.id;
  const principal = userPrincipal(userId);
  await port.ensureDefaultTier(principal);
  const provider = await port.providers.insert(principal, {
    name: 'p',
    kind: 'api_key',
    protocol: 'openai_compatible',
    baseUrl: 'https://api.example.com',
  });
  const modelIds: string[] = [];
  for (const ext of ['m-a', 'm-b', 'm-c']) {
    const m = await port.models.createForProvider(principal, provider.id, { externalModelId: ext });
    modelIds.push(m!.id);
  }
  return { userId, principal, modelIds };
}

describe('routing-config e2e', () => {
  let app: INestApplication;
  let server: App;
  let pool: Pool;
  let port: PersistencePort;
  let A: Tenant;
  let B: Tenant;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'selfhosted';
    process.env['BIND_ADDRESS'] = '127.0.0.1';
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(`${COMPOSE_HINT}\n(${(error as Error).message})`);
    }
    const moduleRef = await Test.createTestingModule({
      imports: [RoutingConfigModule],
      providers: [{ provide: APP_GUARD, useClass: TestPrincipalGuard }],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
    await app.init(); // runs migrations
    server = app.getHttpServer();
    port = app.get<PersistencePort>(PERSISTENCE_PORT);
    A = await seedTenant(port, pool, 'routeA');
    B = await seedTenant(port, pool, 'routeB');
  }, 60_000);

  afterAll(async () => {
    await pool.query('DELETE FROM "user" WHERE id = ANY($1)', [[A.userId, B.userId]]);
    await app.close();
    await pool.end();
  });

  const asA = (m: 'get' | 'post' | 'patch' | 'delete' | 'put', path: string) =>
    request(server)[m](path).set('x-test-user', A.userId);

  // --- tiers ---

  it('seeds a default tier and does CRUD, protecting default', async () => {
    const list = await asA('get', '/api/routing/tiers');
    expect(list.status).toBe(200);
    expect(list.body.some((t: { key: string }) => t.key === 'default')).toBe(true);
    const defaultId = list.body.find((t: { key: string }) => t.key === 'default').id;

    expect((await asA('post', '/api/routing/tiers').send({ key: 'auto' })).status).toBe(422);
    const created = await asA('post', '/api/routing/tiers').send({ key: 'fast', displayName: 'F' });
    expect(created.status).toBe(201);
    expect((await asA('post', '/api/routing/tiers').send({ key: 'fast' })).status).toBe(409);

    const patched = await asA('patch', `/api/routing/tiers/${created.body.id}`).send({
      displayName: 'Renamed',
    });
    expect(patched.body).toMatchObject({ key: 'fast', displayName: 'Renamed' });

    // A-44: a nullable field can be CLEARED by an explicit null (not rejected 4xx,
    // not silently ignored) — displayName/description are `@IsOptional` (null-tolerant)
    // and the update persists the null.
    const cleared = await asA('patch', `/api/routing/tiers/${created.body.id}`).send({
      displayName: null,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.displayName).toBeNull();

    expect((await asA('delete', `/api/routing/tiers/${defaultId}`)).status).toBe(422);
    expect((await asA('delete', `/api/routing/tiers/${created.body.id}`)).status).toBe(200);
  });

  // --- entries ---

  it('replaces the ordered chain, enforcing cap/dedupe/ownership', async () => {
    const tiers = await asA('get', '/api/routing/tiers');
    const defaultId = tiers.body.find((t: { key: string }) => t.key === 'default').id;
    const entriesUrl = `/api/routing/tiers/${defaultId}/entries`;

    const put = await asA('put', entriesUrl).send({ modelIds: A.modelIds });
    expect(put.status).toBe(200);
    expect(put.body.map((e: { position: number; modelId: string }) => e.position)).toEqual([
      0, 1, 2,
    ]);

    const get = await asA('get', entriesUrl);
    expect(get.body.map((e: { modelId: string }) => e.modelId)).toEqual(A.modelIds);
    expect(get.body[0].model.externalModelId).toBe('m-a');

    // Reorder + unassign (shorter list).
    const reordered = await asA('put', entriesUrl).send({
      modelIds: [A.modelIds[2], A.modelIds[0]],
    });
    expect(reordered.body.map((e: { modelId: string }) => e.modelId)).toEqual([
      A.modelIds[2],
      A.modelIds[0],
    ]);

    // Over-cap (6) → 4xx; duplicate → 422; another tenant's model → 422.
    expect(
      (await asA('put', entriesUrl).send({ modelIds: [...A.modelIds, ...A.modelIds] })).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await asA('put', entriesUrl).send({ modelIds: [A.modelIds[0], A.modelIds[0]] })).status,
    ).toBe(422);
    expect((await asA('put', entriesUrl).send({ modelIds: [B.modelIds[0]] })).status).toBe(422);
  });

  // --- rules ---

  it('does rule CRUD with target validation and priority bounds', async () => {
    const okTier = await asA('post', '/api/routing/rules').send({
      matchType: 'header',
      headerValue: 'fast',
      target: 'tier:default',
    });
    expect(okTier.status).toBe(201);
    expect(okTier.body.headerName).toBe('x-polyrouter-tier');

    const okModel = await asA('post', '/api/routing/rules').send({
      matchType: 'header',
      headerName: 'X-Route',
      headerValue: 'm',
      target: `model:${A.modelIds[0]}`,
    });
    expect(okModel.body.headerName).toBe('x-route');

    expect(
      (
        await asA('post', '/api/routing/rules').send({
          matchType: 'header',
          headerValue: 'x',
          target: 'tier:ghost',
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await asA('post', '/api/routing/rules').send({
          matchType: 'header',
          headerValue: 'x',
          target: 'bogus',
        })
      ).status,
    ).toBe(422);
    // A-25: a target naming ANOTHER tenant's model is rejected (write-time referential
    // integrity is owner-scoped — never resolves across the tenant boundary).
    expect(
      (
        await asA('post', '/api/routing/rules').send({
          matchType: 'header',
          headerValue: 'x',
          target: `model:${B.modelIds[0]}`,
        })
      ).status,
    ).toBe(422);
    // header rule without a header_value → 422
    expect(
      (
        await asA('post', '/api/routing/rules').send({
          matchType: 'header',
          target: 'tier:default',
        })
      ).status,
    ).toBe(422);
    // priority out of range → 4xx (DTO bound), never a 500
    expect(
      (
        await asA('post', '/api/routing/rules').send({
          matchType: 'header',
          headerValue: 'x',
          target: 'tier:default',
          priority: 2_000_000,
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);

    const del = await asA('delete', `/api/routing/rules/${okModel.body.id}`);
    expect(del.status).toBe(200);
  });

  // --- auto_workload rules (add-workload-routing D5) ---

  it('does auto_workload rule CRUD: class pairing, null-clear, reserved classes, listing', async () => {
    const asB = (m: 'get' | 'post' | 'patch' | 'delete', path: string) =>
      request(server)[m](path).set('x-test-user', B.userId);
    const coding = await asA('post', '/api/routing/tiers').send({ key: 'coding' });
    expect(coding.status).toBe(201);

    // Happy path: ONE class, no header_value, target validated like any rule.
    const created = await asA('post', '/api/routing/rules').send({
      matchType: 'auto_workload',
      workloadClass: 'code',
      target: 'tier:coding',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      matchType: 'auto_workload',
      workloadClass: 'code',
      headerValue: null,
      target: 'tier:coding',
    });
    // The listing carries the class (the dashboard's Workload-targets card reads it).
    const listed = await asA('get', '/api/routing/rules');
    expect(listed.status).toBe(200);
    expect(listed.body.find((r: { id: string }) => r.id === created.body.id)).toMatchObject({
      workloadClass: 'code',
    });
    expect(
      listed.body
        .filter((r: { matchType: string }) => r.matchType !== 'auto_workload')
        .every((r: { workloadClass: unknown }) => r.workloadClass === null),
    ).toBe(true);

    // Rejected shapes — a clean 4xx, never a constraint 500.
    const rejects: Array<Record<string, unknown>> = [
      { matchType: 'auto_workload', target: 'tier:coding' }, // no class
      { matchType: 'auto_workload', workloadClass: 'none', target: 'tier:coding' }, // telemetry-only class
      { matchType: 'auto_workload', workloadClass: 'bogus', target: 'tier:coding' }, // unknown class
      {
        matchType: 'auto_workload',
        workloadClass: 'code',
        headerValue: 'x',
        target: 'tier:coding',
      },
      { matchType: 'auto_workload', workloadClass: 'code', headerValue: '', target: 'tier:coding' }, // '' is not null (clink r5 M1)
      { matchType: 'header', headerValue: 'x', workloadClass: 'code', target: 'tier:coding' },
      { matchType: 'default', workloadClass: 'vision', target: 'tier:coding' },
      { matchType: 'auto_workload', workloadClass: 'code', target: 'tier:ghost' }, // target validation still applies
    ];
    for (const body of rejects) {
      const res = await asA('post', '/api/routing/rules').send(body);
      expect([400, 422]).toContain(res.status);
    }

    // Reserved classes (semantic-only today) are still VALID rule targets —
    // the rule is inert until a source emits them, never a validation error.
    for (const cls of ['research', 'writing', 'vision', 'structured']) {
      const r = await asA('post', '/api/routing/rules').send({
        matchType: 'auto_workload',
        workloadClass: cls,
        target: 'tier:coding',
      });
      expect(r.status).toBe(201);
      expect((await asA('delete', `/api/routing/rules/${r.body.id}`)).status).toBe(200);
    }

    // PATCH validates the EFFECTIVE merged row.
    expect(
      (
        await asA('patch', `/api/routing/rules/${created.body.id}`).send({
          workloadClass: 'vision',
        })
      ).body,
    ).toMatchObject({ matchType: 'auto_workload', workloadClass: 'vision' });
    // Clearing the class on a still-auto_workload row → 422 (pairing).
    expect(
      (await asA('patch', `/api/routing/rules/${created.body.id}`).send({ workloadClass: null }))
        .status,
    ).toBe(422);
    // Adding a header_value to an auto_workload row → 422.
    expect(
      (await asA('patch', `/api/routing/rules/${created.body.id}`).send({ headerValue: 'x' }))
        .status,
    ).toBe(422);
    // '' is not null either — a clean 422, never the DB CHECK → 500 (clink r5 M1).
    expect(
      (await asA('patch', `/api/routing/rules/${created.body.id}`).send({ headerValue: '' }))
        .status,
    ).toBe(422);
    // Moving the type away WITHOUT clearing the class → 422 (class forbidden there).
    expect(
      (await asA('patch', `/api/routing/rules/${created.body.id}`).send({ matchType: 'default' }))
        .status,
    ).toBe(422);
    // The atomic move: type + explicit null class in ONE patch → 200, class cleared.
    const moved = await asA('patch', `/api/routing/rules/${created.body.id}`).send({
      matchType: 'default',
      workloadClass: null,
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ matchType: 'default', workloadClass: null });
    // And back: type without a class → 422; type + class → 200.
    expect(
      (
        await asA('patch', `/api/routing/rules/${created.body.id}`).send({
          matchType: 'auto_workload',
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await asA('patch', `/api/routing/rules/${created.body.id}`).send({
          matchType: 'auto_workload',
          workloadClass: 'code',
        })
      ).status,
    ).toBe(200);

    // Tenant isolation by id: B can neither read-modify nor delete A's rule.
    expect(
      (
        await asB('patch', `/api/routing/rules/${created.body.id}`).send({
          workloadClass: 'vision',
        })
      ).status,
    ).toBe(404);
    expect((await asB('delete', `/api/routing/rules/${created.body.id}`)).status).toBe(404);
    expect(
      (await asB('get', '/api/routing/rules')).body.some(
        (r: { id: string }) => r.id === created.body.id,
      ),
    ).toBe(false);

    expect((await asA('delete', `/api/routing/rules/${created.body.id}`)).status).toBe(200);
    expect((await asA('delete', `/api/routing/tiers/${coding.body.id}`)).status).toBe(200);
  });

  it('band rules may carry a class SCOPE; PATCH merges keep or refuse it (add-workload-scoped-bands)', async () => {
    const coding = await asA('post', '/api/routing/tiers').send({ key: 'strong-code' });
    expect(coding.status).toBe(201);
    // A scoped band rule is accepted and listed with its class.
    const scoped = await asA('post', '/api/routing/rules').send({
      matchType: 'auto_high',
      workloadClass: 'code',
      target: 'tier:strong-code',
    });
    expect(scoped.status).toBe(201);
    expect(scoped.body).toMatchObject({
      matchType: 'auto_high',
      workloadClass: 'code',
      headerValue: null,
    });
    const listed = await asA('get', '/api/routing/rules');
    expect(listed.body.find((r: { id: string }) => r.id === scoped.body.id)).toMatchObject({
      workloadClass: 'code',
    });
    // A generic band rule stays unscoped; a band rule with `none`/unknown is rejected.
    const generic = await asA('post', '/api/routing/rules').send({
      matchType: 'auto_low',
      target: 'tier:default',
    });
    expect(generic.status).toBe(201);
    expect(generic.body.workloadClass).toBeNull();
    for (const cls of ['none', 'bogus']) {
      expect([400, 422]).toContain(
        (
          await asA('post', '/api/routing/rules').send({
            matchType: 'auto_low',
            workloadClass: cls,
            target: 'tier:default',
          })
        ).status,
      );
    }
    // header/default never carry a class.
    expect([400, 422]).toContain(
      (
        await asA('post', '/api/routing/rules').send({
          matchType: 'default',
          workloadClass: 'code',
          target: 'tier:default',
        })
      ).status,
    );
    // PATCH merges: scoped band → header without clearing → 422; scoped band → auto_workload keeps the class;
    // unscoped band → auto_workload without a class → 422; auto_workload → auto_high keeps the class as a scope.
    expect(
      (
        await asA('patch', `/api/routing/rules/${scoped.body.id}`).send({
          matchType: 'header',
          headerValue: 'x',
        })
      ).status,
    ).toBe(422);
    const toClaim = await asA('patch', `/api/routing/rules/${scoped.body.id}`).send({
      matchType: 'auto_workload',
    });
    expect(toClaim.status).toBe(200);
    expect(toClaim.body).toMatchObject({ matchType: 'auto_workload', workloadClass: 'code' });
    expect(
      (
        await asA('patch', `/api/routing/rules/${generic.body.id}`).send({
          matchType: 'auto_workload',
        })
      ).status,
    ).toBe(422);
    const backToBand = await asA('patch', `/api/routing/rules/${scoped.body.id}`).send({
      matchType: 'auto_high',
    });
    expect(backToBand.status).toBe(200);
    expect(backToBand.body).toMatchObject({ matchType: 'auto_high', workloadClass: 'code' });
    // A scoped band PATCHed to a different class keeps working; clearing the class makes it generic.
    expect(
      (await asA('patch', `/api/routing/rules/${scoped.body.id}`).send({ workloadClass: 'vision' }))
        .body.workloadClass,
    ).toBe('vision');
    expect(
      (await asA('patch', `/api/routing/rules/${scoped.body.id}`).send({ workloadClass: null }))
        .body.workloadClass,
    ).toBeNull();
    for (const id of [scoped.body.id, generic.body.id])
      expect((await asA('delete', `/api/routing/rules/${id}`)).status).toBe(200);
    expect((await asA('delete', `/api/routing/tiers/${coding.body.id}`)).status).toBe(200);
  });

  it('DB CHECKs refuse malformed workload rows even when the API is bypassed (add-workload-routing 1.1)', async () => {
    const insert = (matchType: string, workloadClass: string | null, headerValue: string | null) =>
      pool.query(
        `INSERT INTO routing_rule (id, owner_user_id, match_type, header_value, workload_class, target)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'tier:default')`,
        [A.userId, matchType, headerValue, workloadClass],
      );
    // add-workload-scoped-bands: the three-way SCOPE check replaces W-2's pairing.
    await expect(insert('auto_workload', null, null)).rejects.toThrow(
      /routing_rule_workload_class_scope/,
    );
    await expect(insert('header', 'code', 'x')).rejects.toThrow(
      /routing_rule_workload_class_scope/,
    );
    await expect(insert('default', 'code', null)).rejects.toThrow(
      /routing_rule_workload_class_scope/,
    );
    await expect(insert('auto_workload', 'none', null)).rejects.toThrow(
      /routing_rule_workload_class_valid/,
    );
    await expect(insert('auto_workload', 'code', 'x')).rejects.toThrow(
      /routing_rule_workload_no_header_value/,
    );
    // The well-formed rows are accepted (and cleaned up): a claim with its class, a
    // band with a class SCOPE, and a band without one.
    await insert('auto_workload', 'code', null);
    await insert('auto_high', 'code', null);
    await insert('auto_low', null, null);
    const del = await pool.query(
      `DELETE FROM routing_rule WHERE owner_user_id = $1 AND match_type IN ('auto_workload','auto_high','auto_low')`,
      [A.userId],
    );
    expect(del.rowCount).toBe(3);
  });

  it('persists a rule when its target tier is deleted; the key can be recreated', async () => {
    const temp = await asA('post', '/api/routing/tiers').send({ key: 'temp' });
    const ruleRes = await asA('post', '/api/routing/rules').send({
      matchType: 'header',
      headerValue: 't',
      target: 'tier:temp',
    });
    expect((await asA('delete', `/api/routing/tiers/${temp.body.id}`)).status).toBe(200);

    // The rule is NOT rewritten/deleted — its target persists (now unresolved; #10's concern).
    const stillThere = await asA('get', `/api/routing/rules/${ruleRes.body.id}`);
    expect(stillThere.body.target).toBe('tier:temp');

    // The key is free to recreate (late-bound targets rebind at #10).
    expect((await asA('post', '/api/routing/tiers').send({ key: 'temp' })).status).toBe(201);
    await asA('delete', `/api/routing/rules/${ruleRes.body.id}`);
  });

  it('rejects an explicit null on a non-nullable rule field with 4xx, not 500 (E10.1)', async () => {
    const created = await asA('post', '/api/routing/rules').send({
      matchType: 'header',
      headerValue: 'x',
      target: `model:${A.modelIds[0]}`,
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    for (const bad of [
      { target: null },
      { priority: null },
      { matchType: null },
      { headerName: null },
    ]) {
      const res = await asA('patch', `/api/routing/rules/${id}`).send(bad);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500); // 4xx validation, NOT a 500 (TypeError/NOT NULL)
    }
    // POST with an explicit null target is also a 4xx, not a 500.
    const post = await asA('post', '/api/routing/rules').send({
      matchType: 'header',
      headerValue: 'x',
      target: null,
    });
    expect(post.status).toBeGreaterThanOrEqual(400);
    expect(post.status).toBeLessThan(500);
    // The stored rule is unchanged by the rejected PATCHes.
    const after = await asA('get', `/api/routing/rules/${id}`);
    expect(after.body.target).toBe(`model:${A.modelIds[0]}`);
    await asA('delete', `/api/routing/rules/${id}`);
  });

  it('re-compacts tier positions when a position-0 provider is deleted (E10.2)', async () => {
    // A cross-provider chain so deleting the primary's provider leaves a healthy survivor.
    const p1 = await port.providers.insert(A.principal, {
      name: 'e10p1',
      kind: 'api_key',
      protocol: 'openai_compatible',
      baseUrl: 'https://e10a.example.com',
    });
    const mm1 = (await port.models.createForProvider(A.principal, p1.id, {
      externalModelId: 'e10-m1',
    }))!;
    const p2 = await port.providers.insert(A.principal, {
      name: 'e10p2',
      kind: 'api_key',
      protocol: 'openai_compatible',
      baseUrl: 'https://e10b.example.com',
    });
    const mm2 = (await port.models.createForProvider(A.principal, p2.id, {
      externalModelId: 'e10-m2',
    }))!;
    const tier = await asA('post', '/api/routing/tiers').send({ key: 'e10tier' });
    await asA('put', `/api/routing/tiers/${tier.body.id}/entries`).send({
      modelIds: [mm1.id, mm2.id],
    });

    // Delete p1 (owns the position-0 model) — the cascade removes mm1's entry.
    expect(await port.providers.remove(A.principal, p1.id)).toBe(true);

    // The tier is re-compacted: the survivor mm2 is now position 0 (routable), not left at 1.
    const entries = await port.routingEntries.listForTier(A.principal, tier.body.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.modelId).toBe(mm2.id);
    expect(entries[0]!.position).toBe(0);

    // Deleting the sole remaining provider leaves the tier genuinely empty.
    expect(await port.providers.remove(A.principal, p2.id)).toBe(true);
    expect(await port.routingEntries.listForTier(A.principal, tier.body.id)).toHaveLength(0);
  });

  // --- tenant isolation ---

  it('never leaks another tenant’s tiers, entries, or rules by id', async () => {
    const aTiers = await asA('get', '/api/routing/tiers');
    const aDefault = aTiers.body.find((t: { key: string }) => t.key === 'default').id;
    const aRule = await asA('post', '/api/routing/rules').send({
      matchType: 'header',
      headerValue: 'iso',
      target: 'tier:default',
    });
    const asB = (m: 'get' | 'patch' | 'delete' | 'put', path: string) =>
      request(server)[m](path).set('x-test-user', B.userId);

    expect((await asB('get', `/api/routing/tiers/${aDefault}`)).status).toBe(404);
    expect(
      (await asB('patch', `/api/routing/tiers/${aDefault}`).send({ displayName: 'x' })).status,
    ).toBe(404);
    expect((await asB('delete', `/api/routing/tiers/${aDefault}`)).status).toBe(404);
    // B cannot replace entries on A's tier (tier_not_found → 404), even with B's own models.
    expect(
      (
        await asB('put', `/api/routing/tiers/${aDefault}/entries`).send({
          modelIds: [B.modelIds[0]],
        })
      ).status,
    ).toBe(404);
    // B cannot see or fetch A's rule.
    expect((await asB('get', `/api/routing/rules/${aRule.body.id}`)).status).toBe(404);
    const bRules = await request(server).get('/api/routing/rules').set('x-test-user', B.userId);
    expect(bRules.body.some((r: { id: string }) => r.id === aRule.body.id)).toBe(false);

    // A's data is unchanged.
    expect((await asA('get', `/api/routing/rules/${aRule.body.id}`)).status).toBe(200);
    await asA('delete', `/api/routing/rules/${aRule.body.id}`);
  });
});
