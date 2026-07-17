import { decryptSecret, type PersistencePort, type Principal } from '@polyrouter/shared/server';
import { ChannelsService } from './channels.service';
import type { NotifyRuntime } from './notify.config';
import type { CreateChannelDto } from './channels.dto';

const SECRET = 'a'.repeat(64);
const PRINCIPAL: Principal = { kind: 'user', userId: 'u1' };

function makeSvc(rtOver?: Partial<NotifyRuntime>) {
  const rows: Record<string, unknown>[] = [];
  let seq = 0;
  const channels = {
    insert: jest.fn((_p: unknown, v: Record<string, unknown>) => {
      const row = { id: `c${(seq += 1)}`, ownerUserId: 'u1', orgId: null, ...v };
      rows.push(row);
      return Promise.resolve(row);
    }),
    findById: jest.fn((_p: unknown, id: string) =>
      Promise.resolve(rows.find((r) => r['id'] === id) ?? null),
    ),
    update: jest.fn((_p: unknown, id: string, patch: Record<string, unknown>) => {
      const r = rows.find((x) => x['id'] === id);
      if (!r) return Promise.resolve(null);
      Object.assign(r, patch);
      return Promise.resolve(r);
    }),
    list: jest.fn(() => Promise.resolve(rows)),
    remove: jest.fn(() => Promise.resolve(true)),
  };
  const db = { notificationChannels: channels } as unknown as PersistencePort;
  const rt: NotifyRuntime = {
    mode: 'selfhosted',
    notifySecret: SECRET,
    appriseApiUrl: undefined,
    allowedEndpoints: [],
    appriseEgressConfirmed: false,
    ...rtOver,
  };
  // A fake Redis whose eval always reports "1st hit" → the test-send rate check
  // (E14.2) always allows; these tests exercise CRUD/SSRF, not throttling.
  const redis = { eval: () => Promise.resolve([1, 60]) } as unknown as import('ioredis').Redis;
  return { svc: new ChannelsService(db, rt, redis), rows };
}

const smtpDto = (host: string): CreateChannelDto => ({
  name: 'ops email',
  kind: 'smtp',
  eventsSubscribed: ['provider_down'],
  config: {
    host,
    port: 587,
    secure: 'starttls',
    user: 'me',
    pass: 'topsecret',
    from: 'a@b.c',
    to: ['x@y.z'],
  },
});

describe('ChannelsService', () => {
  it('encrypts the config at rest and never exposes the secret', async () => {
    const { svc, rows } = makeSvc();
    const safe = await svc.create(PRINCIPAL, smtpDto('1.1.1.1')); // public literal IP → passes SSRF, no DNS
    expect(safe.hasConfig).toBe(true);
    expect(JSON.stringify(safe)).not.toContain('topsecret');
    const stored = rows[0]!['encryptedConfig'] as string;
    expect(stored).not.toContain('topsecret'); // at rest is ciphertext
    expect(decryptSecret(stored, SECRET)).toContain('topsecret'); // round-trips under the key
  });

  it('rejects an SMTP host that resolves to a private address (422)', async () => {
    const { svc } = makeSvc();
    await expect(svc.create(PRINCIPAL, smtpDto('10.0.0.5'))).rejects.toMatchObject({ status: 422 });
  });

  it('rejects a cloud Apprise channel without egress confirmation', async () => {
    const { svc } = makeSvc({ mode: 'cloud' });
    await expect(
      svc.create(PRINCIPAL, {
        name: 'discord',
        kind: 'apprise',
        eventsSubscribed: ['provider_down'],
        config: { urls: ['discord://id/token'] },
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('rejects a kind change without a new config', async () => {
    const { svc } = makeSvc();
    const created = await svc.create(PRINCIPAL, smtpDto('1.1.1.1'));
    await expect(svc.update(PRINCIPAL, created.id, { kind: 'apprise' })).rejects.toMatchObject({
      status: 422,
    });
  });

  it('records a sanitized failed test-send (no secret)', async () => {
    const { svc, rows } = makeSvc(); // appriseApiUrl undefined → fast, no network
    const created = await svc.create(PRINCIPAL, {
      name: 'discord',
      kind: 'apprise',
      eventsSubscribed: ['provider_down'],
      config: { urls: ['discord://webhook_id/webhook_token'] },
    });
    const res = await svc.testSend(PRINCIPAL, created.id);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('apprise_not_configured');
    expect(rows[0]!['lastTestStatus']).toBe('failed:apprise_not_configured');
    expect(JSON.stringify(res)).not.toContain('webhook_token');
  });
});
