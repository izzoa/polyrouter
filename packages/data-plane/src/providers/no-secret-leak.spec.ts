import { createOpenaiProviderAdapter } from './openai-adapter';
import type { NormalizedRequest } from '../proxy/translate';
import { recordingClient, errorResponse } from './testkit.testkit';

const CRED = 'sk-super-secret-value-9f3a';
const config = {
  protocol: 'openai_compatible' as const,
  baseUrl: 'https://api.example/v1',
  credential: CRED,
  kind: 'api_key' as const,
  mode: 'cloud' as const,
};
const request: NormalizedRequest = {
  model: 'm',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  params: {},
};

describe('credential never leaks (invariant 8)', () => {
  let logs: string[] = [];
  const spies: jest.SpyInstance[] = [];
  beforeEach(() => {
    logs = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      spies.push(
        jest.spyOn(console, m).mockImplementation((...args: unknown[]) => {
          logs.push(args.map((a) => String(a)).join(' '));
        }),
      );
    }
  });
  afterEach(() => {
    for (const s of spies) s.mockRestore();
    spies.length = 0;
  });

  it('a failing chat never surfaces the credential in the error or logs', async () => {
    const { client } = recordingClient(() => errorResponse(500, 'internal error'));
    const adapter = createOpenaiProviderAdapter(config, { httpClient: client });
    let caught: unknown;
    try {
      await adapter.chat(request);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const serialized = `${String((caught as Error).message)} ${JSON.stringify(caught, Object.getOwnPropertyNames(caught))}`;
    expect(serialized).not.toContain(CRED);
    expect(logs.join('\n')).not.toContain(CRED);
  });

  it("testConnection's failure result omits the credential", async () => {
    const { client } = recordingClient(() => errorResponse(401, 'bad key'));
    const adapter = createOpenaiProviderAdapter(config, { httpClient: client });
    const result = await adapter.testConnection();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(CRED);
    expect(logs.join('\n')).not.toContain(CRED);
  });
});
