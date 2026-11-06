/**
 * polyrouter's honest outbound identity (add-honest-user-agent): the bare RFC 9110
 * product token `polyrouter/<release version>`, with no comment, URL, OS or Node
 * detail. The version is fixed when shared is built (tsup/vitest `define`), never
 * read at runtime and never overridable by configuration (design D2, D7).
 */

declare const __POLYROUTER_RELEASE_VERSION__: string;

// Concatenation, not a template literal: esbuild folds it to one literal.
export const POLYROUTER_USER_AGENT: string = 'polyrouter/' + __POLYROUTER_RELEASE_VERSION__;

/** The header name, in the case the single emitted header uses. */
const USER_AGENT_HEADER = 'User-Agent';

type HeaderRecord = Record<string, string>;

/** What a caller may hand in: a record, a list of pairs, or a `Headers` (which
 * iterates as pairs) — structural, so no DOM lib types are needed. */
export type HeadersLike =
  | Readonly<Record<string, string | readonly string[] | undefined>>
  | Iterable<readonly [string, string]>
  | readonly (readonly string[])[];

const joined = (v: string | readonly string[] | undefined): string =>
  v === undefined ? '' : typeof v === 'string' ? v : v.join(', ');

/** Normalizes any accepted headers shape to `[name, value]` pairs, in order. */
function entriesOf(headers: HeadersLike | undefined): (readonly [string, string])[] {
  if (headers === undefined) return [];
  if (Array.isArray(headers)) {
    return (headers as readonly (readonly string[])[]).map(
      (pair) => [joined(pair[0]), joined(pair[1])] as [string, string],
    );
  }
  // A `Headers` (the global one or undici's — different classes) iterates as pairs.
  if (Symbol.iterator in headers) return [...(headers as Iterable<readonly [string, string]>)];
  // An undefined value is no header at all, never an empty one.
  return Object.entries(headers)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => [k, joined(v)] as [string, string]);
}

/**
 * A copy of `headers` with every case variant of `user-agent` removed and exactly
 * one `User-Agent: value` set. Every other key is kept; the input is not mutated.
 */
export function withUserAgent(headers: HeadersLike | undefined, value: string): HeaderRecord {
  const out: HeaderRecord = {};
  for (const [key, val] of entriesOf(headers)) {
    if (key.toLowerCase() !== 'user-agent') out[key] = val;
  }
  out[USER_AGENT_HEADER] = value;
  return out;
}

/**
 * The value of the LAST key, in insertion order, whose lower-case form is
 * `user-agent`, or `undefined` ("last wins" matches the object-spread precedence
 * the provider header builder uses).
 */
export function findUserAgent(headers: HeadersLike | undefined): string | undefined {
  let found: string | undefined;
  for (const [key, val] of entriesOf(headers)) {
    if (key.toLowerCase() === 'user-agent') found = val;
  }
  return found;
}
