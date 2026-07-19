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
    reasoningDemand: null,
    responseFormatDemand: false,
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

describe('declared reasoning demand (add-auto-hint-features)', () => {
  const R = 0.1; // DEFAULT_REASONING_ADJUST

  it('NO-HINT PARITY: the three pinned legacy cases band identically to the pre-change classifier (r1-High-3)', () => {
    // Saturated size + code + schema: exactly the high threshold.
    const a = classifyStructural(
      features({ effectiveInputChars: 8_000, codeBlockChars: 4_000, toolSchemaDemand: true }),
      null,
      OPTS,
    );
    expect(a.score).toBeCloseTo(0.6, 10);
    expect(a.band).toBe('high');
    // Saturated size alone.
    const b = classifyStructural(features({ effectiveInputChars: 8_000 }), null, OPTS);
    expect(b.score).toBeCloseTo(0.3, 10);
    expect(b.band).toBe('ambiguous');
    // Size sub-score 0.9.
    const c = classifyStructural(features({ effectiveInputChars: 7_200 }), null, OPTS);
    expect(c.score).toBeCloseTo(0.27, 10);
    expect(c.band).toBe('ambiguous');
  });

  it('NO-HINT PARITY mechanism: null demand adds no adjustment term', () => {
    const base = features({ effectiveInputChars: 2_400 });
    const withNull = classifyStructural(base, null, OPTS);
    const legacyScore = DEFAULT_STRUCTURAL_WEIGHTS.size * (2_400 / 8_000);
    expect(withNull.score).toBeCloseTo(legacyScore, 10);
  });

  it('centered adjustment: none −R, minimal −R/2, low 0, medium +R/2 — presence-aware', () => {
    const base = features({ effectiveInputChars: 4_000 }); // ambient .25·.5 = .125
    const ambient = classifyStructural(base, null, OPTS).score;
    const at = (demand: number) =>
      classifyStructural(
        features({ effectiveInputChars: 4_000, reasoningDemand: demand }),
        null,
        OPTS,
      ).score;
    expect(at(0)).toBeCloseTo(Math.max(0, ambient - R), 10); // none
    expect(at(0.25)).toBeCloseTo(ambient - R / 2, 10); // minimal
    expect(at(0.5)).toBeCloseTo(ambient, 10); // low / adaptive / unknown → centered zero
    expect(at(0.75)).toBeCloseTo(ambient + R / 2, 10); // medium
  });

  it('clamps at both ends', () => {
    const zero = classifyStructural(features({ reasoningDemand: 0 }), null, OPTS);
    expect(zero.score).toBe(0); // ambient 0 − R clamps to 0
    const maxed = classifyStructural(
      features({
        effectiveInputChars: 80_000,
        codeBlockChars: 40_000,
        toolCount: 80,
        toolSchemaDemand: true,
        conversationDepth: 200,
        multimodalPresent: true,
        maxOutputTokens: 40_960,
        reasoningDemand: 0.75,
      }),
      null,
      OPTS,
    );
    expect(maxed.score).toBeLessThanOrEqual(1);
  });

  it('the declared-maximal band rule fires at demand exactly 1, independent of R', () => {
    const v = classifyStructural(
      features({ reasoningDemand: 1 }),
      null,
      { ...OPTS, reasoningAdjust: 0 }, // R=0 disables ONLY the centered adjustment
    );
    expect(v.band).toBe('high');
    expect(v.reason).toContain('declared=max');
  });

  it('a just-below-saturation demand does NOT trigger the rule', () => {
    const v = classifyStructural(features({ reasoningDemand: 0.99 }), null, OPTS);
    expect(v.band).not.toBe('high');
    expect(v.reason).not.toContain('declared=max');
  });

  it('AMBIENT-HIGH BAND FLOOR: no permitted R can demote heavy structure', () => {
    const heavy = { effectiveInputChars: 8_000, codeBlockChars: 4_000, toolSchemaDemand: true };
    const ambient = classifyStructural(features(heavy), null, OPTS);
    expect(ambient.band).toBe('high'); // .25+.18+.10 = ... wait — legacy weights .30+.20+.10 = .60
    const demoted = classifyStructural(
      features({ ...heavy, reasoningDemand: 0 }),
      null,
      { ...OPTS, reasoningAdjust: 0.5 }, // the maximum permitted R
    );
    expect(demoted.band).toBe('high'); // the downward adjustment is not applied
    expect(demoted.score).toBeCloseTo(ambient.score, 10);
  });

  it('cascade bypass is INTENDED: ambiguous ambient + declared none routes low directly', () => {
    const v = classifyStructural(
      features({ effectiveInputChars: 8_000, reasoningDemand: 0 }), // ambient .30 − .10 = .20
      null,
      OPTS,
    );
    expect(v.score).toBeCloseTo(0.2, 10);
    expect(v.band).toBe('low'); // ≤ .25 → cheap directly, no L3 verify
  });

  it('schema sub-score ORs tool-schema and response-format demand, with rf= provenance', () => {
    const viaTool = classifyStructural(features({ toolSchemaDemand: true }), null, OPTS);
    const viaRf = classifyStructural(features({ responseFormatDemand: true }), null, OPTS);
    const both = classifyStructural(
      features({ toolSchemaDemand: true, responseFormatDemand: true }),
      null,
      OPTS,
    );
    expect(viaTool.score).toBeCloseTo(viaRf.score, 10);
    expect(both.score).toBeCloseTo(viaTool.score, 10); // OR, no double count
    expect(viaRf.reason).toContain('rf=1.00');
    expect(viaTool.reason).toContain('rf=0.00');
  });

  it('reason carries think= demand or -- when absent', () => {
    expect(classifyStructural(features({}), null, OPTS).reason).toContain('think=--');
    expect(classifyStructural(features({ reasoningDemand: 0.25 }), null, OPTS).reason).toContain(
      'think=0.25',
    );
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
