import {
  DEFAULT_STRUCTURAL_WEIGHTS,
  type StructuralThresholds,
  classifyStructural,
} from './classify';
import { extractStructuralFeatures, type StructuralFeatures } from './features';
import type { NormalizedMessage, NormalizedRequest } from '../../proxy/translate';

const OPTS: StructuralThresholds = { high: 0.6, low: 0.25, weights: DEFAULT_STRUCTURAL_WEIGHTS };

function features(p: Partial<StructuralFeatures>): StructuralFeatures {
  return {
    effectiveInputChars: 0,
    codeBlockChars: 0,
    toolCount: 0,
    toolSchemaDemand: false,
    multimodalPresent: false,
    conversationDepth: 0,
    maxOutputTokens: 0,
    ...p,
  };
}

describe('classifyStructural', () => {
  it('bands a complex request high', () => {
    const v = classifyStructural(
      features({ effectiveInputChars: 8_000, codeBlockChars: 4_000, toolCount: 8 }),
      null,
      OPTS,
    );
    expect(v.band).toBe('high'); // .3 + .2 + .2 = .7
    expect(v.score).toBeCloseTo(0.7, 5);
  });

  it('bands a trivial request low', () => {
    expect(classifyStructural(features({ effectiveInputChars: 20 }), null, OPTS).band).toBe('low');
  });

  it('bands a middling request ambiguous', () => {
    const v = classifyStructural(
      features({ effectiveInputChars: 8_000, toolSchemaDemand: true }),
      null,
      OPTS,
    );
    expect(v.band).toBe('ambiguous'); // .3 + .1 = .4, between .25 and .6
  });

  it('honors the exact thresholds (inclusive both sides)', () => {
    const high = classifyStructural(
      features({ effectiveInputChars: 8_000, codeBlockChars: 4_000, toolSchemaDemand: true }),
      null,
      OPTS,
    );
    expect(high.score).toBeCloseTo(0.6, 5);
    expect(high.band).toBe('high'); // >= high

    const low = classifyStructural(
      features({ conversationDepth: 20, maxOutputTokens: 4_096, toolSchemaDemand: true }),
      null,
      OPTS,
    );
    expect(low.score).toBeCloseTo(0.25, 5);
    expect(low.band).toBe('low'); // <= low
  });

  it('subtracts the per-agent baseline from the size signal', () => {
    const g = features({ effectiveInputChars: 16_000, codeBlockChars: 4_000, toolCount: 8 });
    // Null baseline: size(16k)→1 (.3) + code(4k)→1 (.2) + tools(8)→1 (.2) = .7 → high.
    expect(classifyStructural(g, null, OPTS).band).toBe('high');
    // Large learned baseline: size delta collapses to 0 → 0 + .2 + .2 = .4 → ambiguous
    // (size alone can never push a request below the low band).
    expect(classifyStructural(g, { ewma: 16_000 }, OPTS).band).toBe('ambiguous');
  });

  it('is language-neutral (operates only on numeric features)', () => {
    const shape = { effectiveInputChars: 8_000, codeBlockChars: 4_000, toolCount: 8 };
    expect(classifyStructural(features(shape), null, OPTS).band).toBe('high');
  });

  it('reason carries only numbers, never raw text', () => {
    const v = classifyStructural(features({ effectiveInputChars: 8_000 }), null, OPTS);
    expect(v.reason).toMatch(/^structural:(high|low|ambiguous) score=/);
    expect(v.reason).not.toMatch(/[A-Za-z]{20,}/); // no long prose/prompt text
  });

  it('a weight override changes the score', () => {
    const f = features({ toolCount: 8 }); // tools sub-score = 1
    const base = classifyStructural(f, null, OPTS).score; // .2
    const boosted = classifyStructural(f, null, {
      ...OPTS,
      weights: { ...DEFAULT_STRUCTURAL_WEIGHTS, tools: 0.8 },
    }).score;
    expect(boosted).toBeGreaterThan(base);
  });

  it('coerces non-finite / negative inputs to zero', () => {
    const v = classifyStructural(
      features({
        effectiveInputChars: Number.NaN,
        codeBlockChars: -100,
        maxOutputTokens: Infinity,
      }),
      null,
      OPTS,
    );
    expect(v.score).toBe(0);
    expect(v.band).toBe('low');
  });
});

describe('structural perf sanity (extract + classify)', () => {
  it('handles a worst-case input within a generous bounded budget', () => {
    const msg: NormalizedMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'Z'.repeat(200_000) }],
    };
    const request: NormalizedRequest = {
      model: 'auto',
      system: [{ type: 'text', text: 'S'.repeat(200_000) }],
      messages: Array.from({ length: 6 }, () => msg),
      params: { maxOutputTokens: 4_096 },
    };
    const start = process.hrtime.bigint();
    for (let i = 0; i < 50; i++) {
      classifyStructural(extractStructuralFeatures(request), { ewma: 1_000 }, OPTS);
    }
    const perOpMs = Number(process.hrtime.bigint() - start) / 1e6 / 50;
    expect(perOpMs).toBeLessThan(20); // generous guard against a caps regression (not a strict 1ms)
  });
});
