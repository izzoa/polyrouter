import { createOpenaiAdapter } from './openai';
import plain from './golden/openai/plain.json';

describe('adapter quirks — genuine deviations absorbed at the boundary', () => {
  it('usageOmitted leaves IR usage undefined while the nominal adapter reads it', () => {
    const quirked = createOpenaiAdapter({ usageOmitted: true });
    expect(quirked.responseIn(plain.response).usage).toBeUndefined();
    // The core/IR is unchanged: the default adapter still reads provider usage.
    expect(createOpenaiAdapter().responseIn(plain.response).usage).toBeDefined();
  });

  it('toolArgumentsAlreadyObject skips the JSON parse step', () => {
    const wire = {
      id: 'r',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_o',
                type: 'function',
                // a provider that already returns a parsed object, not a string
                function: { name: 'f', arguments: { city: 'SF' } },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };
    const quirked = createOpenaiAdapter({ toolArgumentsAlreadyObject: true });
    const ir = quirked.responseIn(wire);
    const block = ir.content.find((b) => b.type === 'tool_use');
    expect(block && 'input' in block ? block.input : null).toEqual({ city: 'SF' });
  });
});
