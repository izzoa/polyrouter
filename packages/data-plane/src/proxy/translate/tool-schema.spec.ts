// fix-tool-schema-null-keywords: unit tests for the tool-schema ingress normalizer.
//
// Assertion rules: a removed keyword is asserted as key ABSENCE (Object.hasOwn), never
// with toBeUndefined/toEqual alone (toEqual ignores undefined-valued keys); "unchanged"
// is asserted with toStrictEqual, and reference identity with toBe.
import { normalizeToolSchema } from './tool-schema';

type Rec = Record<string, unknown>;
type Path = readonly (string | number)[];

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Build an input the way the wire does: through JSON.parse. */
function J(value: unknown): Rec {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  if (!isRec(parsed)) throw new Error('expected an object');
  return parsed;
}

function run(input: unknown): Rec {
  const out = normalizeToolSchema(input);
  if (!isRec(out)) throw new Error('expected an object result');
  return out;
}

function at(root: unknown, path: Path): unknown {
  let cur: unknown = root;
  for (const step of path) {
    if (typeof step === 'number') {
      if (!Array.isArray(cur)) throw new Error(`not an array at ${String(step)}`);
      const arr: readonly unknown[] = cur;
      cur = arr[step];
    } else {
      if (!isRec(cur)) throw new Error(`not an object at ${step}`);
      cur = Object.hasOwn(cur, step) ? cur[step] : undefined;
    }
  }
  return cur;
}

function recAt(root: unknown, path: Path): Rec {
  const v = at(root, path);
  if (!isRec(v)) throw new Error(`no object at ${path.join('.')}`);
  return v;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Rec)[key as string]);
    }
    Object.freeze(value);
  }
  return value;
}

/** A literal copy of the spec delta's list (68). Never imported from tool-schema.ts. */
const SPEC_STRIP_SET: readonly string[] = [
  '$schema',
  'id',
  '$id',
  '$ref',
  '$anchor',
  '$dynamicRef',
  '$dynamicAnchor',
  '$recursiveRef',
  '$recursiveAnchor',
  '$vocabulary',
  '$comment',
  '$defs',
  'definitions',
  'title',
  'description',
  'type',
  'enum',
  'examples',
  'format',
  'nullable',
  'multipleOf',
  'divisibleBy',
  'maximum',
  'minimum',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'maxLength',
  'minLength',
  'pattern',
  'maxItems',
  'minItems',
  'uniqueItems',
  'maxContains',
  'minContains',
  'maxProperties',
  'minProperties',
  'required',
  'dependentRequired',
  'properties',
  'patternProperties',
  'additionalProperties',
  'additionalItems',
  'items',
  'prefixItems',
  'contains',
  'propertyNames',
  'unevaluatedItems',
  'unevaluatedProperties',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'dependencies',
  'dependentSchemas',
  'extends',
  'disallow',
  'contentEncoding',
  'contentMediaType',
  'contentSchema',
  'readOnly',
  'writeOnly',
  'deprecated',
  'discriminator',
  'xml',
  'externalDocs',
];

/** One way a subschema can hang off its parent (a walked position or form). `make`
 * builds the keyword's value around `target` (the subschema under test) and `clean`
 * (an untouched sibling, absent for single-object forms). The target is never first. */
interface Form {
  readonly name: string;
  readonly keyword: string;
  readonly make: (target: Rec, clean: Rec) => unknown;
  /** Path of the target, relative to the keyword's value. */
  readonly targetPath: Path;
  /** Path of the clean sibling, relative to the keyword's value (when there is one). */
  readonly cleanPath?: Path;
}

const mapForm = (keyword: string): Form => ({
  name: `${keyword} (map value)`,
  keyword,
  make: (target, clean) => ({ first: clean, target }),
  targetPath: ['target'],
  cleanPath: ['first'],
});
const oneForm = (keyword: string): Form => ({
  name: `${keyword} (object)`,
  keyword,
  make: (target) => target,
  targetPath: [],
});
const arrayForm = (keyword: string): Form => ({
  name: `${keyword} (array element)`,
  keyword,
  make: (target, clean) => [clean, target],
  targetPath: [1],
  cleanPath: [0],
});

const FORMS: readonly Form[] = [
  ...['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'].map(mapForm),
  {
    name: 'dependencies (object value after a string-array value)',
    keyword: 'dependencies',
    make: (target) => ({ list: ['b', 'c'], target }),
    targetPath: ['target'],
    cleanPath: ['list'],
  },
  ...[
    'additionalProperties',
    'additionalItems',
    'contains',
    'propertyNames',
    'unevaluatedItems',
    'unevaluatedProperties',
    'not',
    'if',
    'then',
    'else',
    'contentSchema',
  ].map(oneForm),
  ...['allOf', 'anyOf', 'oneOf', 'prefixItems'].map(arrayForm),
  oneForm('items'),
  { ...arrayForm('items'), name: 'items (tuple element)' },
  oneForm('extends'),
  { ...arrayForm('extends'), name: 'extends (tuple element)' },
  {
    name: 'type (draft-03 union element)',
    keyword: 'type',
    make: (target) => ['string', target],
    targetPath: [1],
  },
  {
    name: 'disallow (draft-03 union element)',
    keyword: 'disallow',
    make: (target) => ['string', target],
    targetPath: [1],
  },
];

const PROPERTIES_STEP: Form = FORMS[0] as Form;

/** The schema `{ [keyword]: <form value>, description: 'root' }` and where the target is. */
function placed(form: Form, target: Rec): { root: Rec; targetAt: Path; cleanAt?: Path } {
  const clean: Rec = J({ type: 'string', title: 'clean-sibling' });
  const root: Rec = { description: 'root', [form.keyword]: form.make(target, clean) };
  const out: { root: Rec; targetAt: Path; cleanAt?: Path } = {
    root,
    targetAt: [form.keyword, ...form.targetPath],
  };
  if (form.cleanPath !== undefined) out.cleanAt = [form.keyword, ...form.cleanPath];
  return out;
}

/** A chain of `steps.length` steps from the root. The leaf is at depth `steps.length`.
 * Built inside out, so no recursion. Returns the root and the path to the leaf. */
function chain(steps: readonly Form[], leaf: Rec): { root: Rec; leafAt: Path } {
  let node: Rec = leaf;
  const paths: (string | number)[][] = [];
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const form = steps[i] as Form;
    const clean: Rec = J({ type: 'string', title: 'clean-sibling' });
    node = { [form.keyword]: form.make(node, clean) };
    paths.unshift([form.keyword, ...form.targetPath]);
  }
  return { root: node, leafAt: paths.flat() };
}

describe('fix-tool-schema-null-keywords: Warp-shaped tools', () => {
  it('finish loses required and keeps every other key, in order', () => {
    const raw =
      '{"type":"object","properties":{"summary":{"type":"string"}},"required":null,"additionalProperties":false}';
    const input: Rec = JSON.parse(raw) as Rec;
    const out = run(input);
    expect(Object.hasOwn(out, 'required')).toBe(false);
    expect(out).toStrictEqual({
      type: 'object',
      properties: { summary: { type: 'string' } },
      additionalProperties: false,
    });
    expect(Object.keys(out)).toStrictEqual(['type', 'properties', 'additionalProperties']);
    expect(JSON.stringify(out)).toBe(
      '{"type":"object","properties":{"summary":{"type":"string"}},"additionalProperties":false}',
    );
    // the unchanged subtree is shared, not copied
    expect(out['properties']).toBe(input['properties']);
  });

  it('transfer_control_to_user (empty properties) loses required', () => {
    const input = J({ type: 'object', properties: {}, required: null });
    const out = run(input);
    expect(Object.hasOwn(out, 'required')).toBe(false);
    expect(JSON.stringify(out)).toBe('{"type":"object","properties":{}}');
  });

  it('a lone {"required": null} becomes an empty object with no keys', () => {
    const out = run(J({ required: null }));
    expect(Object.keys(out)).toStrictEqual([]);
  });
});

describe('fix-tool-schema-null-keywords: each walked position (D3)', () => {
  describe.each(FORMS)('$name', (form) => {
    it('removes a null strip-set keyword in the subschema and leaves its clean sibling untouched', () => {
      const target = J({ type: 'string', minLength: null, title: 'kept' });
      const { root, targetAt, cleanAt } = placed(form, target);
      const out = run(root);
      const got = recAt(out, targetAt);
      expect(Object.hasOwn(got, 'minLength')).toBe(false);
      expect(got).toStrictEqual({ type: 'string', title: 'kept' });
      expect(Object.keys(got)).toStrictEqual(['type', 'title']);
      expect(out['description']).toBe('root');
      if (cleanAt !== undefined) {
        // the clean member is the very same object, not a copy
        expect(at(out, cleanAt)).toBe(at(root, cleanAt));
      } else {
        expect(at(out, [form.keyword])).not.toBe(at(root, [form.keyword]));
      }
      // string members beside an object member of a type/disallow union stay as sent
      if (form.keyword === 'type' || form.keyword === 'disallow') {
        expect(at(out, [form.keyword, 0])).toBe('string');
      }
    });

    it('does nothing to a subschema that carries no null', () => {
      const target = J({ type: 'string', title: 'kept' });
      const { root } = placed(form, target);
      expect(run(root)).toBe(root);
    });
  });

  it('keeps a dependencies string-array value as the same array after an object value changes', () => {
    const input = J({
      dependencies: { first: ['b'], second: { type: 'object', required: null } },
    });
    const out = run(input);
    expect(at(out, ['dependencies', 'first'])).toBe(at(input, ['dependencies', 'first']));
    expect(Object.hasOwn(recAt(out, ['dependencies', 'second']), 'required')).toBe(false);
  });
});

describe('fix-tool-schema-null-keywords: the strip set (D2)', () => {
  it('the literal list has 68 distinct entries', () => {
    expect(SPEC_STRIP_SET).toHaveLength(68);
    expect(new Set(SPEC_STRIP_SET).size).toBe(68);
  });

  it.each(SPEC_STRIP_SET)('removes %s when null (root schema)', (keyword) => {
    const input = J({ [keyword]: null, default: 'kept' });
    const out = run(input);
    expect(Object.hasOwn(out, keyword)).toBe(false);
    expect(out).toStrictEqual({ default: 'kept' });
  });

  it('never strips const, default, example, x-* or unknown keys, whatever the value', () => {
    const input = J({
      const: null,
      default: null,
      example: null,
      'x-vendor': null,
      propertyOrdering: null,
      madeUpKeyword: null,
      required: null,
    });
    const out = run(input);
    expect(Object.hasOwn(out, 'required')).toBe(false);
    expect(out).toStrictEqual({
      const: null,
      default: null,
      example: null,
      'x-vendor': null,
      propertyOrdering: null,
      madeUpKeyword: null,
    });
  });
});

describe('fix-tool-schema-null-keywords: keyword x position matrix', () => {
  const siblingFor = (keyword: string): string => (keyword === 'title' ? 'description' : 'title');

  /** A child carrying only `keyword: null` plus non-null siblings that must survive. */
  const childFor = (keyword: string): Rec =>
    J({ [keyword]: null, [siblingFor(keyword)]: 'kept-sibling', default: 'kept-default' });

  it.each(FORMS)(
    'every strip-set keyword is removed from a child reached through $name',
    (form) => {
      for (const keyword of SPEC_STRIP_SET) {
        const { root, targetAt } = placed(form, childFor(keyword));
        const got = recAt(run(root), targetAt);
        expect({ form: form.name, keyword, present: Object.hasOwn(got, keyword) }).toStrictEqual({
          form: form.name,
          keyword,
          present: false,
        });
        expect({ form: form.name, keyword, got }).toStrictEqual({
          form: form.name,
          keyword,
          got: { [siblingFor(keyword)]: 'kept-sibling', default: 'kept-default' },
        });
      }
    },
  );

  it('the root schema uses the same rule', () => {
    for (const keyword of SPEC_STRIP_SET) {
      const got = run(childFor(keyword));
      expect({ keyword, present: Object.hasOwn(got, keyword) }).toStrictEqual({
        keyword,
        present: false,
      });
    }
  });
});

describe('fix-tool-schema-null-keywords: survivors', () => {
  const survivors = (): Rec =>
    J({
      type: 'object',
      properties: {
        konst: { const: null },
        dflt: { default: null },
        example: { example: null },
        choice: { type: 'string', enum: ['F', 'C', null] },
        union: { type: ['string', 'null'] },
        nul: { type: 'null' },
        vendor: { 'x-vendor': null, propertyOrdering: null, unknownKey: null },
        required: { type: 'string' },
      },
    });

  it('keeps every meaningful null and a property named required (clean input returned as is)', () => {
    const input = survivors();
    expect(run(input)).toBe(input);
  });

  it('keeps them all, and copies around them, when something else is removed', () => {
    const input = survivors();
    input['required'] = null;
    const out = run(input);
    expect(Object.hasOwn(out, 'required')).toBe(false);
    const props = recAt(out, ['properties']);
    expect(props).toBe(input['properties']);
    expect(at(props, ['konst', 'const'])).toBeNull();
    expect(Object.hasOwn(recAt(props, ['konst']), 'const')).toBe(true);
    expect(Object.hasOwn(recAt(props, ['dflt']), 'default')).toBe(true);
    expect(Object.hasOwn(recAt(props, ['example']), 'example')).toBe(true);
    expect(at(props, ['choice', 'enum'])).toStrictEqual(['F', 'C', null]);
    expect(at(props, ['union', 'type'])).toStrictEqual(['string', 'null']);
    expect(at(props, ['nul', 'type'])).toBe('null');
    const vendor = recAt(props, ['vendor']);
    expect(Object.hasOwn(vendor, 'x-vendor')).toBe(true);
    expect(Object.hasOwn(vendor, 'propertyOrdering')).toBe(true);
    expect(Object.hasOwn(vendor, 'unknownKey')).toBe(true);
    expect(at(props, ['required'])).toStrictEqual({ type: 'string' });
  });
});

describe('fix-tool-schema-null-keywords: never entered', () => {
  const DATA = (): Rec => ({ required: null, description: null });
  const SLOTS: readonly { slot: string; wrap: (data: Rec) => unknown }[] = [
    { slot: 'const', wrap: (d) => d },
    { slot: 'default', wrap: (d) => d },
    { slot: 'example', wrap: (d) => d },
    { slot: 'examples', wrap: (d) => [d] },
    { slot: 'enum', wrap: (d) => [d] },
    { slot: 'x-vendor', wrap: (d) => d },
    { slot: 'unknownKeyword', wrap: (d) => d },
    { slot: 'discriminator', wrap: (d) => d },
    { slot: 'xml', wrap: (d) => d },
    { slot: 'externalDocs', wrap: (d) => d },
    { slot: '$vocabulary', wrap: (d) => d },
    { slot: 'required', wrap: (d) => d },
    { slot: 'dependentRequired', wrap: (d) => d },
    { slot: 'type', wrap: (d) => d },
    { slot: 'disallow', wrap: (d) => d },
  ];

  describe.each(SLOTS)('$slot', ({ slot, wrap }) => {
    it('is returned unchanged, same object, at the root', () => {
      const root = J({ description: 'root' });
      root[slot] = wrap(DATA());
      const snapshot = J(root);
      expect(run(root)).toBe(root);
      expect(root).toStrictEqual(snapshot);
    });

    it('is returned unchanged, same object, inside a property schema', () => {
      const prop = J({ type: 'string' });
      prop[slot] = wrap(DATA());
      const root = J({ type: 'object', properties: { clean: { type: 'string' }, prop } });
      expect(run(root)).toBe(root);
    });

    it('keeps the very same data object when a null elsewhere forces a copy', () => {
      const data = DATA();
      const root = J({ description: 'root', required: null });
      root[slot] = wrap(data);
      const out = run(root);
      expect(Object.hasOwn(out, 'required')).toBe(slot === 'required');
      expect(out[slot]).toBe(root[slot]);
      expect(Object.hasOwn(data, 'required')).toBe(true);
      expect(data['required']).toBeNull();
      expect(data['description']).toBeNull();
    });
  });

  it('keeps default { required: null } byte for byte in a changed schema', () => {
    const input = J({ properties: { a: { default: { required: null }, description: null } } });
    const out = run(input);
    expect(JSON.stringify(out)).toBe('{"properties":{"a":{"default":{"required":null}}}}');
  });
});

describe('fix-tool-schema-null-keywords: left as sent', () => {
  it('leaves non-null invalid required values alone', () => {
    const city = J({ type: 'object', required: 'city' });
    expect(run(city)).toBe(city);
    expect(city['required']).toBe('city');
    const empty = J({ type: 'object', required: [] });
    expect(run(empty)).toBe(empty);
    expect(empty['required']).toStrictEqual([]);
  });

  it('treats map entries as names, never as keywords', () => {
    const input = J({ properties: { a: null, required: null, items: null } });
    expect(run(input)).toBe(input);
    // ...and a copy made elsewhere still carries every name with its null
    const changed = J({ description: null, properties: { a: null, required: null, items: null } });
    const out = run(changed);
    const props = recAt(out, ['properties']);
    expect(Object.keys(props)).toStrictEqual(['a', 'required', 'items']);
    for (const name of ['a', 'required', 'items']) {
      expect(Object.hasOwn(props, name)).toBe(true);
      expect(props[name]).toBeNull();
    }
    expect(Object.hasOwn(out, 'description')).toBe(false);
  });

  it('treats $defs and definitions entries as names too', () => {
    const input = J({ $defs: { description: null }, definitions: { title: null, required: null } });
    expect(run(input)).toBe(input);
    const changed = J({ type: null, $defs: { description: null } });
    const out = run(changed);
    expect(Object.hasOwn(recAt(out, ['$defs']), 'description')).toBe(true);
  });

  it('keeps a null element of anyOf and removes the null inside its sibling', () => {
    const untouched = J({ anyOf: [null, { type: 'string' }] });
    expect(run(untouched)).toBe(untouched);
    const input = J({ anyOf: [null, { type: 'string', required: null }] });
    const out = run(input);
    const members = at(out, ['anyOf']);
    expect(Array.isArray(members)).toBe(true);
    expect(members).toHaveLength(2);
    expect(at(out, ['anyOf', 0])).toBeNull();
    expect(Object.hasOwn(recAt(out, ['anyOf', 1]), 'required')).toBe(false);
  });
});

describe('fix-tool-schema-null-keywords: identity', () => {
  it('returns the same reference for a clean schema', () => {
    const input = J({
      type: 'object',
      properties: { a: { type: 'array', items: { type: 'string' } }, b: { anyOf: [{}, {}] } },
      required: ['a'],
    });
    expect(run(input)).toBe(input);
  });

  it('shares every unchanged subtree of a changed schema and copies only the spine', () => {
    const input = J({
      type: 'object',
      required: null,
      properties: {
        clean: { type: 'object', properties: { deep: { type: 'string' } } },
        dirty: { type: 'object', properties: { deep: { type: 'string', title: null } } },
      },
      anyOf: [{ type: 'string' }, { type: 'number' }],
    });
    const out = run(input);
    expect(out).not.toBe(input);
    expect(at(out, ['properties', 'clean'])).toBe(at(input, ['properties', 'clean']));
    expect(at(out, ['anyOf'])).toBe(at(input, ['anyOf']));
    expect(at(out, ['properties', 'dirty'])).not.toBe(at(input, ['properties', 'dirty']));
    expect(at(out, ['properties', 'dirty', 'properties', 'deep'])).not.toBe(
      at(input, ['properties', 'dirty', 'properties', 'deep']),
    );
    expect(Object.hasOwn(recAt(out, ['properties', 'dirty', 'properties', 'deep']), 'title')).toBe(
      false,
    );
  });

  it('copies an array only when an element changed, preserving order and length', () => {
    const input = J({ anyOf: [{ type: 'a' }, { type: 'b', required: null }, { type: 'c' }] });
    const out = run(input);
    const members = at(out, ['anyOf']);
    expect(Array.isArray(members)).toBe(true);
    expect(members).not.toBe(at(input, ['anyOf']));
    expect(members).toStrictEqual([{ type: 'a' }, { type: 'b' }, { type: 'c' }]);
    expect(at(out, ['anyOf', 0])).toBe(at(input, ['anyOf', 0]));
    expect(at(out, ['anyOf', 2])).toBe(at(input, ['anyOf', 2]));
  });
});

describe('fix-tool-schema-null-keywords: frozen input', () => {
  it('normalizes a deeply frozen schema without mutating it', () => {
    const input = J({
      type: 'object',
      description: null,
      required: null,
      properties: {
        x: { type: 'string', description: null, items: { type: 'string', title: null } },
        y: { type: 'number' },
      },
      anyOf: [{ type: 'string' }, { type: 'number', required: null }],
    });
    const snapshot: unknown = structuredClone(input);
    deepFreeze(input);
    let out: Rec = {};
    expect(() => {
      out = run(input);
    }).not.toThrow();
    expect(input).toStrictEqual(snapshot);
    expect(Object.hasOwn(out, 'required')).toBe(false);
    expect(Object.hasOwn(out, 'description')).toBe(false);
    expect(Object.hasOwn(recAt(out, ['properties', 'x']), 'description')).toBe(false);
    expect(Object.hasOwn(recAt(out, ['properties', 'x', 'items']), 'title')).toBe(false);
    expect(Object.hasOwn(recAt(out, ['anyOf', 1]), 'required')).toBe(false);
    expect(at(out, ['properties', 'y'])).toBe(at(input, ['properties', 'y']));
    expect(at(out, ['anyOf', 0])).toBe(at(input, ['anyOf', 0]));
  });

  it('returns a frozen clean schema as is', () => {
    const input = deepFreeze(J({ type: 'object', properties: { a: { type: 'string' } } }));
    expect(run(input)).toBe(input);
  });
});

describe('fix-tool-schema-null-keywords: idempotence', () => {
  it('a second pass is a no-op and returns the first result itself', () => {
    const input = J({
      type: 'object',
      required: null,
      properties: {
        a: { type: 'array', items: { type: 'string', description: null }, minItems: null },
        b: { anyOf: [{ type: 'string' }, { type: 'null', title: null }] },
      },
      $defs: { d: { type: 'string', format: null } },
      default: { required: null },
    });
    const once = run(input);
    const twice = run(once);
    expect(twice).toStrictEqual(once);
    expect(twice).toBe(once);
  });
});

describe('fix-tool-schema-null-keywords: __proto__ keys stay own data', () => {
  it('(a) a root with an own __proto__ key and a required: null sibling', () => {
    const payload = '{"polluted":true,"required":["x"]}';
    const input = JSON.parse(`{"type":"object","required":null,"__proto__":${payload}}`) as Rec;
    expect(Object.hasOwn(input, '__proto__')).toBe(true);
    const out = run(input);
    expect(out).not.toBe(input);
    expect(Object.hasOwn(out, 'required')).toBe(false);
    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect('polluted' in out).toBe(false);
    expect(Reflect.get(out, 'polluted')).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).toBe(
      Object.getOwnPropertyDescriptor(input, '__proto__')?.value,
    );
    expect(Object.keys(out)).toStrictEqual(['type', '__proto__']);
  });

  it('(b) a properties map with a __proto__ entry whose sibling entry changes', () => {
    const input = JSON.parse(
      '{"properties":{"__proto__":{"polluted":true},"b":{"type":"string","required":null}}}',
    ) as Rec;
    const out = run(input);
    const props = recAt(out, ['properties']);
    expect(props).not.toBe(input['properties']);
    expect(Object.hasOwn(props, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(props)).toBe(Object.prototype);
    expect('polluted' in props).toBe(false);
    expect(Object.getOwnPropertyDescriptor(props, '__proto__')?.value).toBe(
      Object.getOwnPropertyDescriptor(input['properties'], '__proto__')?.value,
    );
    expect(Object.hasOwn(recAt(props, ['b']), 'required')).toBe(false);
  });

  it('(c) a __proto__ entry that is itself the changed schema', () => {
    const input = JSON.parse(
      '{"properties":{"a":{"type":"string"},"__proto__":{"type":"string","required":null,"polluted":true}}}',
    ) as Rec;
    const out = run(input);
    const props = recAt(out, ['properties']);
    expect(Object.getPrototypeOf(props)).toBe(Object.prototype);
    expect(Object.hasOwn(props, '__proto__')).toBe(true);
    expect('polluted' in props).toBe(false);
    const entry = Object.getOwnPropertyDescriptor(props, '__proto__')?.value as Rec;
    expect(Object.hasOwn(entry, 'required')).toBe(false);
    expect(entry['polluted']).toBe(true);
  });
});

describe('fix-tool-schema-null-keywords: depth bound (D7)', () => {
  const NULLED = (): Rec => J({ type: 'string', required: null, title: 'leaf' });

  describe.each(FORMS)('final step through $name', (form) => {
    const steps = (depth: number): Form[] => [
      ...Array.from({ length: depth - 1 }, () => PROPERTIES_STEP),
      form,
    ];

    it('removes a null at depth 64', () => {
      const { root, leafAt } = chain(steps(64), NULLED());
      const out = run(root);
      const leaf = recAt(out, leafAt);
      expect(Object.hasOwn(leaf, 'required')).toBe(false);
      expect(leaf).toStrictEqual({ type: 'string', title: 'leaf' });
    });

    it('carries depth 65 as sent, by reference', () => {
      const { root, leafAt } = chain(steps(65), NULLED());
      const out = run(root);
      expect(out).toBe(root);
      const leaf = recAt(out, leafAt);
      expect(leaf).toBe(recAt(root, leafAt));
      expect(Object.hasOwn(leaf, 'required')).toBe(true);
      expect(leaf['required']).toBeNull();
    });
  });

  it('counts one level per step across mixed positions, and none for the holder', () => {
    for (const [depth, removed] of [
      [63, true],
      [64, true],
      [65, false],
      [66, false],
    ] as const) {
      const seq = Array.from({ length: depth }, (_v, i) => FORMS[i % FORMS.length] as Form);
      const { root, leafAt } = chain(seq, NULLED());
      const out = run(root);
      const leaf = recAt(out, leafAt);
      expect({ depth, present: Object.hasOwn(leaf, 'required') }).toStrictEqual({
        depth,
        present: !removed,
      });
      if (!removed) expect(out).toBe(root);
    }
  });

  it('normalizes the root (depth 0) together with a chain, leaving depth 65 as sent', () => {
    const { root, leafAt } = chain(
      Array.from({ length: 65 }, () => PROPERTIES_STEP),
      NULLED(),
    );
    root['required'] = null;
    const out = run(root);
    expect(Object.hasOwn(out, 'required')).toBe(false);
    // the depth-65 leaf was not normalized and is carried by reference
    expect(recAt(out, leafAt)).toBe(recAt(root, leafAt));
    expect(Object.hasOwn(recAt(out, leafAt), 'required')).toBe(true);
  });

  it('survives a schema nested 100,000 levels deep without throwing', () => {
    let node: Rec = { type: 'string', required: null };
    for (let i = 0; i < 100_000; i += 1) node = { properties: { next: node } };
    node['required'] = null;
    const root = node;
    let out: Rec = {};
    expect(() => {
      out = run(root);
    }).not.toThrow();
    expect(Object.hasOwn(out, 'required')).toBe(false);
    // everything below the bound is untouched and shared
    expect(out['properties']).toBe(root['properties']);
  });
});

describe('fix-tool-schema-null-keywords: non-objects pass through', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an array', [{ required: null }]],
    ['a string', 'object'],
    ['a number', 7],
    ['a boolean', true],
  ])('returns %s as given', (_name, value) => {
    expect(normalizeToolSchema(value)).toBe(value);
  });

  it('does not touch the array contents either', () => {
    const arr: unknown[] = [{ required: null }];
    normalizeToolSchema(arr);
    expect(Object.hasOwn(arr[0] as Rec, 'required')).toBe(true);
  });
});
