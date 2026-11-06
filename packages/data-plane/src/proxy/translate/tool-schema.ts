// Tool-schema ingress normalization (fix-tool-schema-null-keywords).
//
// A client may send a tool parameter schema in which a standard keyword carries the
// value `null` (for example `"required": null`). `null` is never valid for such a
// keyword in any supported dialect, and a strict upstream rejects the whole request.
// Removing the keyword restores the evident intent (absent) without changing meaning.
//
// Rules (design.md D2-D7):
//  - Only keywords in STRIP_WHEN_NULL are removed, and only when the value is `null`.
//  - Only subschema positions are walked. Instance data (const, default, enum,
//    examples, ...) and unknown or vendor keys are never entered.
//  - Copy on write: an unchanged node is returned as the same object, a parent is
//    copied only when a descendant changed, and the input is never mutated.
//  - Copies are built from own entries with `Object.fromEntries`, which defines
//    properties, so an own `__proto__` key stays an own key. A removed key is absent.
//  - The root schema is depth 0 and each step into a subschema position adds one level.
//    A subschema deeper than MAX_DEPTH is returned unchanged and nothing throws.
//  - A non-plain-object input is returned as given.
//
// This module is private to `translate/` and is deliberately not re-exported.

import type { ToolParameters } from './ir';

/** Deepest schema level whose keywords are normalized (the root schema is level 0). */
const MAX_DEPTH = 64;

/** Standard keywords for which `null` is invalid in every supported dialect that
 * defines them (JSON Schema draft-03 to 2020-12, OpenAPI 3.0 Schema Object). The same
 * list is normative in the protocol-translation spec. `const`, `default`, `example`,
 * `x-*` and unknown keys are intentionally absent: null is data or unknown there. */
const STRIP_WHEN_NULL: ReadonlySet<string> = new Set([
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
]);

/** How a keyword's value holds subschemas.
 *  - map: an object whose values are subschemas (the keys are names, not keywords)
 *  - one: a single subschema
 *  - many: an array whose object elements are subschemas
 *  - oneOrMany: a single subschema, or the array (tuple) form */
type Position = 'map' | 'one' | 'many' | 'oneOrMany';

const POSITIONS: ReadonlyMap<string, Position> = new Map<string, Position>([
  ['properties', 'map'],
  ['patternProperties', 'map'],
  ['$defs', 'map'],
  ['definitions', 'map'],
  ['dependentSchemas', 'map'],
  ['dependencies', 'map'],
  ['additionalProperties', 'one'],
  ['additionalItems', 'one'],
  ['contains', 'one'],
  ['propertyNames', 'one'],
  ['unevaluatedItems', 'one'],
  ['unevaluatedProperties', 'one'],
  ['not', 'one'],
  ['if', 'one'],
  ['then', 'one'],
  ['else', 'one'],
  ['contentSchema', 'one'],
  ['allOf', 'many'],
  ['anyOf', 'many'],
  ['oneOf', 'many'],
  ['prefixItems', 'many'],
  ['type', 'many'],
  ['disallow', 'many'],
  ['items', 'oneOrMany'],
  ['extends', 'oneOrMany'],
]);

/** Marks an entry the visitor removes (distinct from every real value). */
const DROP: unique symbol = Symbol('drop');

type Json = Record<string, unknown>;

/** A JSON-shaped object: not null, not an array, and a null or root prototype (the
 * check is realm-neutral, so an object from another realm still qualifies). */
function isPlainObject(value: unknown): value is Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

/** Copy-on-write over an object's own entries. `visit` returns the entry's new value,
 * the same value to keep it, or DROP to remove it. Returns `source` itself when no
 * entry changed. */
function rewrite(source: Json, visit: (key: string, value: unknown) => unknown): Json {
  const entries = Object.entries(source);
  let out: [string, unknown][] | undefined;
  let index = 0;
  for (const [key, value] of entries) {
    const next = visit(key, value);
    if (out === undefined && !Object.is(next, value)) out = entries.slice(0, index);
    if (out !== undefined && next !== DROP) out.push([key, next]);
    index += 1;
  }
  return out === undefined ? source : Object.fromEntries(out);
}

/** The subschema `value` normalized one level below its holder, or `value` as given
 * when it is not an object. */
function child(value: unknown, depth: number): unknown {
  return isPlainObject(value) ? normalizeNode(value, depth + 1) : value;
}

/** An array whose object elements are subschemas; copied only when an element changed. */
function visitArray(value: unknown, depth: number): unknown {
  if (!Array.isArray(value)) return value;
  const items: readonly unknown[] = value;
  let out: unknown[] | undefined;
  for (let i = 0; i < items.length; i += 1) {
    const before = items[i];
    const after = child(before, depth);
    if (out === undefined && !Object.is(after, before)) out = items.slice();
    if (out !== undefined) out[i] = after;
  }
  return out ?? value;
}

/** A name-to-subschema map. Its keys are names, so no keyword test applies to them. */
function visitMap(value: unknown, depth: number): unknown {
  if (!isPlainObject(value)) return value;
  return rewrite(value, (_name, member) => child(member, depth));
}

function visitPosition(position: Position, value: unknown, depth: number): unknown {
  switch (position) {
    case 'map':
      return visitMap(value, depth);
    case 'one':
      return child(value, depth);
    case 'many':
      return visitArray(value, depth);
    case 'oneOrMany':
      return Array.isArray(value) ? visitArray(value, depth) : child(value, depth);
  }
}

/** Normalize the schema `node` that sits at `depth`. */
function normalizeNode(node: Json, depth: number): Json {
  if (depth > MAX_DEPTH) return node;
  return rewrite(node, (key, value) => {
    if (value === null) return STRIP_WHEN_NULL.has(key) ? DROP : value;
    const position = POSITIONS.get(key);
    return position === undefined ? value : visitPosition(position, value, depth);
  });
}

/** Remove null-valued standard keywords from a tool parameter schema (see the header).
 * Returns the input itself when there is nothing to remove, and any value that is not
 * a plain object as given. */
export function normalizeToolSchema(schema: ToolParameters): ToolParameters;
export function normalizeToolSchema(schema: unknown): unknown;
export function normalizeToolSchema(schema: unknown): unknown {
  return isPlainObject(schema) ? normalizeNode(schema, 0) : schema;
}
