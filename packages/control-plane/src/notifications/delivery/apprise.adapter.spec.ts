/**
 * add-branded-notifications: the Apprise payload gains presentation-only
 * fields. Two things are asserted — that `type`/`format` ride the payload
 * verbatim from the RENDERER (the adapter resolves nothing, so no second
 * severity map can appear), and that neither field changes where the request
 * goes: the SSRF contract is untouched because neither names a host.
 */
import { deliverApprise } from './apprise.adapter';
import type { AppriseConfig } from '../channel-config';
import type { NotifyRuntime } from '../notify.config';

const guardedFetch = jest.fn();
jest.mock('@polyrouter/shared/server', () => ({
  ...jest.requireActual('@polyrouter/shared/server'),
  guardedFetch: (...args: unknown[]) => guardedFetch(...args),
}));

const cfg: AppriseConfig = { urls: ['discord://a/b'] };
const rt = (): NotifyRuntime => ({
  mode: 'selfhosted',
  notifySecret: 's'.repeat(32),
  appriseApiUrl: 'http://127.0.0.1:8000',
  allowedEndpoints: [],
  appriseEgressConfirmed: false,
  appOrigin: null,
});

const bodyOf = (): Record<string, unknown> =>
  JSON.parse((guardedFetch.mock.calls[0]![1] as { body: string }).body) as Record<string, unknown>;

beforeEach(() => {
  guardedFetch.mockReset();
  guardedFetch.mockResolvedValue({ status: 200, text: () => Promise.resolve('') });
});

describe('deliverApprise — presentation fields', () => {
  it('emits the rendered severity and explicit format verbatim', async () => {
    await deliverApprise(
      cfg,
      { title: 't', body: 'b', type: 'failure', format: 'text' },
      rt(),
      1_000,
    );
    expect(bodyOf()).toMatchObject({
      urls: 'discord://a/b',
      title: 't',
      body: 'b',
      type: 'failure',
      format: 'text',
    });
  });

  it('omits both keys entirely when the caller supplies neither (unchanged shape)', async () => {
    await deliverApprise(cfg, { title: 't', body: 'b' }, rt(), 1_000);
    const payload = bodyOf();
    expect('type' in payload).toBe(false);
    expect('format' in payload).toBe(false);
    expect(payload).toMatchObject({ urls: 'discord://a/b', title: 't', body: 'b' });
  });

  it('targets the SAME configured endpoint — the new fields add no egress', async () => {
    await deliverApprise(cfg, { title: 't', body: 'b', type: 'warning', format: 'text' }, rt(), 1_000);
    expect(guardedFetch).toHaveBeenCalledTimes(1);
    expect(guardedFetch.mock.calls[0]![0]).toBe('http://127.0.0.1:8000/notify');
  });
});
