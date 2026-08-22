import { extractStructuralFeatures, type StructuralFeatures } from './features';
import {
  DEFAULT_WORKLOAD_THRESHOLDS,
  WORKLOAD_THRESHOLD_KEYS,
  classifyWorkload,
  workloadRevision,
  type WorkloadThresholds,
} from './workload';
import type { NormalizedRequest } from '../../proxy/translate';

const REV = workloadRevision(DEFAULT_WORKLOAD_THRESHOLDS);
const T = DEFAULT_WORKLOAD_THRESHOLDS;

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

describe('classifyWorkload (add-workload-telemetry D3)', () => {
  it('vision fires on an image alone, score 1, source structural, the given revision', () => {
    const v = classifyWorkload(features({ multimodalPresent: true }), T, REV);
    expect(v).toMatchObject({ class: 'vision', score: 1, source: 'structural', revision: REV });
  });

  it('structured fires on a declared OUTPUT format alone, score 1', () => {
    const v = classifyWorkload(features({ responseFormatDemand: true }), T, REV);
    expect(v).toMatchObject({ class: 'structured', score: 1 });
  });

  it('the tool-schema exclusion is pinned: tool schemas alone (no output format) → none', () => {
    const v = classifyWorkload(
      features({ toolCount: 5, toolSchemaDemand: true, responseFormatDemand: false }),
      T,
      REV,
    );
    expect(v.class).toBe('none');
    expect(v.score).toBe(0);
  });

  it('code fires on fenced share ≥ codeShare AND chars ≥ codeMinChars; score = the share', () => {
    const v = classifyWorkload(
      features({ effectiveInputChars: 1000, codeBlockChars: 420 }),
      T,
      REV,
    );
    expect(v.class).toBe('code');
    expect(v.score).toBeCloseTo(0.42, 10);
  });

  it('exactly-at-threshold fires; just below the share does not; above share but below the floor does not', () => {
    // share exactly 0.30, chars 300 ≥ 200 → code
    expect(
      classifyWorkload(features({ effectiveInputChars: 1000, codeBlockChars: 300 }), T, REV).class,
    ).toBe('code');
    // share 0.299 → none
    expect(
      classifyWorkload(features({ effectiveInputChars: 1000, codeBlockChars: 299 }), T, REV).class,
    ).toBe('none');
    // share 0.5 but only 100 chars (< 200 floor) → none
    expect(
      classifyWorkload(features({ effectiveInputChars: 200, codeBlockChars: 100 }), T, REV).class,
    ).toBe('none');
    // exactly at the floor with share ≥ 0.3 → code
    expect(
      classifyWorkload(features({ effectiveInputChars: 400, codeBlockChars: 200 }), T, REV).class,
    ).toBe('code');
  });

  it('zero counted text → share 0 → none (never NaN)', () => {
    const v = classifyWorkload(features({ effectiveInputChars: 0, codeBlockChars: 0 }), T, REV);
    expect(v.class).toBe('none');
    expect(v.score).toBe(0);
    expect(v.reason).toContain('share=0.00');
  });

  it('none scores 0 and carries the same source/revision', () => {
    const v = classifyWorkload(features({ effectiveInputChars: 50 }), T, REV);
    expect(v).toMatchObject({ class: 'none', score: 0, source: 'structural', revision: REV });
  });

  it('precedence: vision > structured > code for every co-firing pair and the triple', () => {
    const code = { effectiveInputChars: 1000, codeBlockChars: 900 };
    expect(classifyWorkload(features({ ...code, multimodalPresent: true }), T, REV).class).toBe(
      'vision',
    );
    expect(classifyWorkload(features({ ...code, responseFormatDemand: true }), T, REV).class).toBe(
      'structured',
    );
    expect(
      classifyWorkload(features({ multimodalPresent: true, responseFormatDemand: true }), T, REV)
        .class,
    ).toBe('vision');
    const triple = classifyWorkload(
      features({ ...code, multimodalPresent: true, responseFormatDemand: true }),
      T,
      REV,
    );
    expect(triple.class).toBe('vision');
    expect(triple.score).toBe(1);
    // The same request without the image records code with its share.
    expect(classifyWorkload(features(code), T, REV)).toMatchObject({ class: 'code', score: 0.9 });
  });

  it('operator thresholds move the boundary (a 40% window: none at 0.5, code at 0.3)', () => {
    const f = features({ effectiveInputChars: 1000, codeBlockChars: 400 });
    expect(classifyWorkload(f, { codeShare: 0.5, codeMinChars: 200 }, REV).class).toBe('none');
    expect(classifyWorkload(f, { codeShare: 0.3, codeMinChars: 200 }, REV).class).toBe('code');
  });

  it('is language-neutral by construction: two feature vectors that differ only in the (absent) text are identical inputs', () => {
    // The classifier never sees text; identical counts in any human language are
    // the SAME vector, so the verdicts are byte-identical.
    const en = features({ effectiveInputChars: 1000, codeBlockChars: 500 });
    const ja = features({ effectiveInputChars: 1000, codeBlockChars: 500 });
    expect(classifyWorkload(en, T, REV)).toEqual(classifyWorkload(ja, T, REV));
  });

  it('the reason is numbers/flags only — no input-derived text', () => {
    const v = classifyWorkload(
      features({ effectiveInputChars: 1000, codeBlockChars: 500 }),
      T,
      REV,
    );
    expect(v.reason).toMatch(/^workload:code score=0\.50 share=0\.50 codechars=500 mm=0 rf=0$/);
  });
});

describe('workloadRevision (design D4)', () => {
  it('is stable for equal thresholds regardless of key order, and pinned in shape', () => {
    const a = workloadRevision({ codeShare: 0.3, codeMinChars: 200 });
    const b = workloadRevision({ codeMinChars: 200, codeShare: 0.3 } as WorkloadThresholds);
    expect(a).toBe(b);
    expect(a).toMatch(/^structural\/v1\/c1\/[0-9a-f]{12}$/);
    expect(a).toBe(REV);
  });

  it('differs when any threshold changes', () => {
    expect(workloadRevision({ codeShare: 0.31, codeMinChars: 200 })).not.toBe(REV);
    expect(workloadRevision({ codeShare: 0.3, codeMinChars: 201 })).not.toBe(REV);
  });

  it('exposes exactly the two tunable keys', () => {
    expect([...WORKLOAD_THRESHOLD_KEYS].sort()).toEqual(['codeMinChars', 'codeShare']);
  });
});

describe('the INHERITED scan boundary is pinned (design D3 / spec)', () => {
  const big = 'A'.repeat(33_000); // exhausts the 32k text budget in the first message
  function ir(messages: NormalizedRequest['messages']): NormalizedRequest {
    return { model: 'auto', messages, params: {} };
  }

  it('an image block AFTER the budget is exhausted is not seen → multimodalPresent=false → none', () => {
    const f = extractStructuralFeatures(
      ir([
        { role: 'user', content: [{ type: 'text', text: big }] },
        { role: 'user', content: [{ type: 'image', data: 'abc', mediaType: 'image/png' }] },
      ]),
    );
    expect(f.multimodalPresent).toBe(false);
    expect(classifyWorkload(f, T, REV).class).toBe('none');
    // The SAME image before the budget is exhausted is seen → vision.
    const g = extractStructuralFeatures(
      ir([
        { role: 'user', content: [{ type: 'image', data: 'abc', mediaType: 'image/png' }] },
        { role: 'user', content: [{ type: 'text', text: big }] },
      ]),
    );
    expect(g.multimodalPresent).toBe(true);
    expect(classifyWorkload(g, T, REV).class).toBe('vision');
  });

  it('a fenced block AFTER the budget is exhausted is uncounted → none', () => {
    const f = extractStructuralFeatures(
      ir([
        { role: 'user', content: [{ type: 'text', text: big }] },
        { role: 'user', content: [{ type: 'text', text: '```\n' + 'x'.repeat(5_000) + '\n```' }] },
      ]),
    );
    expect(f.codeBlockChars).toBe(0);
    expect(classifyWorkload(f, T, REV).class).toBe('none');
  });
});
