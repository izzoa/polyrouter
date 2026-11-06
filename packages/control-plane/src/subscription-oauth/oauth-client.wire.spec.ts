// add-honest-user-agent 3.2 — the wire request carries exactly buildTokenRequest's
// headers (one polyrouter User-Agent). undici's fetch and the SSRF primitives are
// mocked, so no socket is opened.
import { POLYROUTER_USER_AGENT } from '@polyrouter/shared/server';

const fetchMock = jest.fn();
const closeMock = jest.fn(() => Promise.resolve());

jest.mock('undici', () => ({
  fetch: (...args: unknown[]): unknown => fetchMock(...args),
}));
jest.mock('@polyrouter/shared/server', () => ({
  ...jest.requireActual<Record<string, unknown>>('@polyrouter/shared/server'),
  assertUrlSafe: jest.fn(() => Promise.resolve()),
  createGuardedDispatcher: jest.fn(() => ({ close: closeMock })),
}));

import { buildTokenRequest, fetchTokenSet, type ExchangeInput } from './oauth-client';

const base: ExchangeInput = {
  tokenEndpoint: 'https://idp.example/token',
  clientId: 'client-1',
  mode: 'cloud',
  body: { grant_type: 'refresh_token', refresh_token: 'rt-0' },
};

describe('fetchTokenSet — wire headers', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 60 }), {
          status: 200,
        }),
      ),
    );
  });

  for (const encoding of ['json', 'form'] as const) {
    for (const grant of ['exchange', 'refresh'] as const) {
      it(`${encoding} / ${grant}: sends exactly buildTokenRequest's headers, one User-Agent`, async () => {
        const input: ExchangeInput = { ...base, encoding, grant };
        await fetchTokenSet(input);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const init = fetchMock.mock.calls[0]![1] as {
          headers: Record<string, string>;
          body: string;
          redirect: string;
        };
        const expected = buildTokenRequest(input);
        expect(init.headers).toEqual(expected.headers);
        expect(init.body).toBe(expected.body);
        expect(init.redirect).toBe('manual');
        const uas = Object.keys(init.headers).filter((k) => k.toLowerCase() === 'user-agent');
        expect(uas).toEqual(['User-Agent']);
        expect(init.headers['User-Agent']).toBe(POLYROUTER_USER_AGENT);
      });
    }
  }
});
