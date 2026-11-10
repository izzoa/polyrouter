// add-subscription-usage-history task 2.2: the SHIPPED Claude and ChatGPT probes, through the
// REAL data-plane read, send exactly their documented header sets (a fake transport records them;
// nothing is dialled).
import {
  readPlanUsage,
  type HttpClient,
  type HttpInit,
  type HttpResponse,
  type ProviderConfig,
} from '@polyrouter/data-plane';
import { POLYROUTER_USER_AGENT } from '@polyrouter/shared/server';
import { CHATGPT_PRESET, CLAUDE_PRESET } from '../subscription-oauth/presets';
import { KEY_PRESETS } from '../subscription-presets/key-presets';

function response(json: unknown): HttpResponse {
  const bytes = new TextEncoder().encode(JSON.stringify(json));
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    text: () => Promise.resolve(new TextDecoder().decode(bytes)),
    json: () => Promise.resolve(json),
  };
}

function recorder(json: unknown): {
  client: HttpClient;
  calls: Array<{ url: string; init: HttpInit }>;
} {
  const calls: Array<{ url: string; init: HttpInit }> = [];
  const client: HttpClient = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(response(json));
  };
  return { client, calls };
}

const TOKEN = 'oauth-access-token-test';
const config = (extra: Partial<ProviderConfig>): ProviderConfig => ({
  protocol: 'anthropic_compatible',
  baseUrl: 'https://api.anthropic.com/',
  credential: TOKEN,
  kind: 'subscription',
  mode: 'cloud',
  authScheme: 'oauth_bearer',
  // An identity in extraHeaders must never ride a usage read.
  extraHeaders: { 'User-Agent': 'claude-cli/2.1.319 (external, cli)', originator: 'codex_cli_rs' },
  ...extra,
});

describe('the shipped Claude and ChatGPT probes through the real read (task 2.2)', () => {
  it('Claude: Bearer, Accept, polyrouter UA and anthropic-beta, on the plain path', async () => {
    const { client, calls } = recorder({ five_hour: { utilization: 3, resets_at: null } });
    await readPlanUsage(config({ oauthBeta: 'oauth-2025-04-20' }), CLAUDE_PRESET.usageProbe!, {
      httpClient: client,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.body).toBeUndefined();
    expect(calls[0]!.init.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': POLYROUTER_USER_AGENT,
    });
  });

  it('ChatGPT: Bearer, Accept, polyrouter UA and chatgpt-account-id, nothing else', async () => {
    const { client, calls } = recorder({ rate_limit: { primary_window: null } });
    await readPlanUsage(
      config({ protocol: 'openai_responses', oauthAccountId: 'acct-0001' }),
      CHATGPT_PRESET.usageProbe!,
      { httpClient: client },
    );
    expect(calls[0]!.url).toBe('https://chatgpt.com/backend-api/wham/usage');
    expect(calls[0]!.init.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json',
      'chatgpt-account-id': 'acct-0001',
      'User-Agent': POLYROUTER_USER_AGENT,
    });
  });

  it('every key-region probe sends only Bearer, Accept and the polyrouter UA', async () => {
    for (const preset of KEY_PRESETS) {
      for (const region of preset.regions) {
        if (region.usageProbe === undefined) continue;
        const { client, calls } = recorder({});
        await readPlanUsage(config({ protocol: 'openai_compatible' }), region.usageProbe, {
          httpClient: client,
        });
        expect(calls[0]!.url).toBe(region.usageProbe.url);
        expect(Object.keys(calls[0]!.init.headers).sort()).toEqual([
          'Accept',
          'Authorization',
          'User-Agent',
        ]);
      }
    }
  });
});
