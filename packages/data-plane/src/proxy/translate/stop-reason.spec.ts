import {
  stopReasonFromOpenai,
  stopReasonFromAnthropic,
  stopReasonToOpenai,
  stopReasonToAnthropic,
} from './stop-reason';

describe('stop-reason mapping', () => {
  it('OpenAI tool_calls ⟷ canonical tool_use', () => {
    expect(stopReasonFromOpenai('tool_calls')).toBe('tool_use');
    expect(stopReasonToOpenai('tool_use')).toBe('tool_calls');
    expect(stopReasonToAnthropic('tool_use')).toBe('tool_use');
  });

  it('Anthropic max_tokens → length → OpenAI length', () => {
    expect(stopReasonFromAnthropic('max_tokens')).toBe('length');
    expect(stopReasonToOpenai('length')).toBe('length');
  });

  it('refusal → content_filter; pause_turn → distinct pause', () => {
    expect(stopReasonFromAnthropic('refusal')).toBe('content_filter');
    expect(stopReasonFromAnthropic('pause_turn')).toBe('pause');
  });

  it('same-protocol raw value is preferred for fidelity', () => {
    // stop_sequence canonicalizes to `stop`, but the raw restores exactly.
    expect(stopReasonToAnthropic('stop', 'stop_sequence')).toBe('stop_sequence');
    expect(stopReasonToOpenai('stop', 'stop')).toBe('stop');
  });

  it('unknown degrades to other, never throws', () => {
    expect(stopReasonFromOpenai('made_up')).toBe('other');
    expect(stopReasonFromAnthropic('made_up')).toBe('other');
    expect(stopReasonFromOpenai(null)).toBe('other');
  });

  it('pause has no OpenAI equivalent → stop', () => {
    expect(stopReasonToOpenai('pause')).toBe('stop');
    expect(stopReasonToAnthropic('pause')).toBe('pause_turn');
  });
});
