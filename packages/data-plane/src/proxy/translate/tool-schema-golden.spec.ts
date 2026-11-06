// fix-tool-schema-null-keywords: the `tool-schema-nulls` golden pair. Each fixture is
// `{ request, normalized }` because the translator deliberately drops null-valued standard
// keywords on the way into the IR (golden/README.md). `canon` is NOT taught to erase that, so
// a regression that leaked a null back out fails here instead of passing silently.
import { openaiAdapter } from './openai';
import { anthropicAdapter } from './anthropic';
import { canonRequest } from './canon';
import type { NormalizedRequest } from './ir';
import oaiFx from './golden/openai/tool-schema-nulls.json';
import antFx from './golden/anthropic/tool-schema-nulls.json';

const oai = openaiAdapter;
const ant = anthropicAdapter;

type Obj = Record<string, unknown>;

function at(root: unknown, ...path: (string | number)[]): unknown {
  let cur = root;
  for (const p of path) {
    if (typeof cur !== 'object' || cur === null) throw new Error(`no ${String(p)} on path`);
    cur = (cur as Record<string | number, unknown>)[p];
  }
  return cur;
}

/** Every key the fixture's `request` nulls out that must be absent from the IR parameters. */
function expectNullsGone(ir: NormalizedRequest): void {
  const p = ir.tools![1]!.parameters;
  const absent = (node: unknown, key: string): void =>
    expect(Object.hasOwn(node as Obj, key)).toBe(false);
  absent(p, 'required');
  absent(at(p, 'properties', 'to'), 'description');
  absent(at(p, 'properties', 'to'), 'pattern');
  absent(at(p, 'properties', 'legs', 'items'), 'required');
  absent(at(p, 'properties', 'legs', 'items'), 'description');
  absent(at(p, 'properties', 'tags'), 'items');
  absent(at(p, 'properties', 'tags'), 'minItems');
  absent(at(p, 'properties', 'contact'), 'required');
  absent(at(p, 'properties', 'contact'), 'additionalProperties');
  absent(at(p, 'anyOf', 1), 'title');
  absent(at(p, 'anyOf', 1), 'required');
  absent(at(p, '$defs', 'Seat'), 'description');
  absent(at(p, '$defs', 'Seat'), 'format');
  absent(at(p, '$defs', 'Cabin'), 'nullable');
}

/** The values that must survive, asserted directly on the IR. */
function expectSurvivors(ir: NormalizedRequest): void {
  const p = ir.tools![1]!.parameters;
  const mode = at(p, 'properties', 'mode') as Obj;
  expect(mode['type']).toStrictEqual(['string', 'null']);
  expect(mode['enum']).toStrictEqual(['economy', 'business', null]);
  expect(Object.hasOwn(mode, 'default')).toBe(true);
  expect(mode['default']).toBeNull();
  const fixed = at(p, 'properties', 'fixed') as Obj;
  expect(Object.hasOwn(fixed, 'const')).toBe(true);
  expect(fixed['const']).toBeNull();
  const payload = at(p, 'properties', 'payload') as Obj;
  expect(payload['default']).toStrictEqual({ required: null, description: null });
  expect(payload['examples']).toStrictEqual([{ required: null }]);
  expect(payload['x-vendor']).toStrictEqual({ description: null, required: null });
  expect(Object.hasOwn(payload, 'propertyOrdering')).toBe(true);
  expect(payload['propertyOrdering']).toBeNull();
  expect(at(p, 'properties', 'required')).toStrictEqual({
    type: 'string',
    description: 'a property that happens to be named required',
  });
  expect(Object.hasOwn(at(p, 'properties') as Obj, 'items')).toBe(true);
  expect(at(p, 'properties', 'items')).toBeNull();
}

describe('golden tool-schema-nulls: OpenAI (fix-tool-schema-null-keywords)', () => {
  const { request, normalized } = oaiFx;

  it('the raw request really carries the nulls (the fixture is not vacuous)', () => {
    const raw = at(request, 'tools', 1, 'function', 'parameters') as Obj;
    expect(Object.hasOwn(raw, 'required')).toBe(true);
    expect(raw['required']).toBeNull();
    expect(
      Object.hasOwn(at(normalized, 'tools', 1, 'function', 'parameters') as Obj, 'required'),
    ).toBe(false);
  });

  it('canon(Out(In(request))) equals canon(normalized), schema key order included', () => {
    const out = oai.requestOut(oai.requestIn(request));
    expect(canonRequest('openai', out)).toStrictEqual(canonRequest('openai', normalized));
    expect(JSON.stringify(canonRequest('openai', out)['tools'])).toBe(
      JSON.stringify(canonRequest('openai', normalized)['tools']),
    );
  });

  it('In(request) equals In(normalized), and the IR carries no stripped key', () => {
    const ir = oai.requestIn(request);
    expect(ir).toStrictEqual(oai.requestIn(normalized));
    expectNullsGone(ir);
    expectSurvivors(ir);
  });

  it('normalized itself round-trips to itself', () => {
    const ir = oai.requestIn(normalized);
    const back = oai.requestOut(ir);
    expect(oai.requestIn(back)).toStrictEqual(ir);
    expect(canonRequest('openai', back)).toStrictEqual(canonRequest('openai', normalized));
  });

  it('cross-direction: parameters equal the Anthropic input_schema, both ways', () => {
    for (const wire of [request, normalized]) {
      const antWire = ant.requestOut(oai.requestIn(wire)) as {
        tools: { name: string; input_schema: unknown }[];
      };
      expect(antWire.tools[1]!.input_schema).toStrictEqual(
        at(normalized, 'tools', 1, 'function', 'parameters'),
      );
      expect(antWire.tools[1]!.input_schema).toStrictEqual(
        at(antFx.normalized, 'tools', 1, 'input_schema'),
      );
    }
    for (const wire of [antFx.request, antFx.normalized]) {
      const oaiWire = oai.requestOut(ant.requestIn(wire)) as {
        tools: { function: { parameters: unknown } }[];
      };
      expect(oaiWire.tools[1]!.function.parameters).toStrictEqual(
        at(antFx.normalized, 'tools', 1, 'input_schema'),
      );
    }
  });
});

describe('golden tool-schema-nulls: Anthropic (fix-tool-schema-null-keywords)', () => {
  const { request, normalized } = antFx;

  it('the raw request really carries the nulls (the fixture is not vacuous)', () => {
    const raw = at(request, 'tools', 1, 'input_schema') as Obj;
    expect(Object.hasOwn(raw, 'required')).toBe(true);
    expect(raw['required']).toBeNull();
    expect(Object.hasOwn(at(normalized, 'tools', 1, 'input_schema') as Obj, 'required')).toBe(
      false,
    );
  });

  it('canon(Out(In(request))) equals canon(normalized), schema key order included', () => {
    const out = ant.requestOut(ant.requestIn(request));
    expect(canonRequest('anthropic', out)).toStrictEqual(canonRequest('anthropic', normalized));
    expect(JSON.stringify(canonRequest('anthropic', out)['tools'])).toBe(
      JSON.stringify(canonRequest('anthropic', normalized)['tools']),
    );
  });

  it('In(request) equals In(normalized), and the IR carries no stripped key', () => {
    const ir = ant.requestIn(request);
    expect(ir).toStrictEqual(ant.requestIn(normalized));
    expectNullsGone(ir);
    expectSurvivors(ir);
  });

  it('normalized itself round-trips to itself', () => {
    const ir = ant.requestIn(normalized);
    const back = ant.requestOut(ir);
    expect(ant.requestIn(back)).toStrictEqual(ir);
    expect(canonRequest('anthropic', back)).toStrictEqual(canonRequest('anthropic', normalized));
  });

  it('both fixtures normalize to the same IR tools', () => {
    expect(ant.requestIn(request).tools).toStrictEqual(oai.requestIn(oaiFx.request).tools);
  });
});
