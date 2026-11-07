/**
 * Preset-declared client identity (allow-preset-client-identity, design D2).
 *
 * A bundled subscription preset MAY declare fixed client-identity headers (a User-Agent
 * among them) that polyrouter sends only while the provider's per-row switch is on. The
 * values are CODE CONSTANTS, never user input and never part of a URL; the API accepts
 * only a boolean switch. This module owns the declaration type and its validation, so an
 * invalid declaration (a reserved name, a case-variant duplicate, a control character)
 * can never become available to any send site.
 */

import type { ProviderRow } from '@polyrouter/shared/server';
import type { OauthPreset } from '../subscription-oauth/presets';

export interface PresetClientIdentity {
  /** The imitated client, for UI copy only (e.g. "Example CLI"). */
  readonly label: string;
  /** Sent on the model API: chat, stream, listing/Test. */
  readonly apiHeaders: Readonly<Record<string, string>>;
  /** Sent on the OAuth token endpoint only, where the preset has one. */
  readonly tokenHeaders?: Readonly<Record<string, string>>;
}

export const MAX_IDENTITY_LABEL_LENGTH = 64;
export const MAX_IDENTITY_VALUE_LENGTH = 256;

/**
 * Header names an identity declaration can never carry (compared case-insensitively):
 * authentication, protocol selection, content negotiation/framing and hop-by-hop names,
 * plus the OpenRouter attribution pair. Protocol-agnostic on purpose (design D2): the
 * adapter merge drops a clash with a name the protocol sets on THAT request, and this
 * set also covers the reserved names a protocol does not set.
 */
export const RESERVED_IDENTITY_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'anthropic-version',
  'anthropic-beta',
  'chatgpt-account-id',
  'openai-beta',
  'content-type',
  'content-length',
  'content-encoding',
  'accept',
  'accept-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'te',
  'upgrade',
  'host',
  'cookie',
  'http-referer',
  'x-openrouter-title',
]);

/** RFC 9110 §5.6.2 `token`. */
const HEADER_NAME_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// eslint-disable-next-line no-control-regex -- the point is to reject control characters
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function headerMapProblems(surface: string, map: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  const names = Object.keys(map);
  if (names.length === 0) {
    problems.push(`${surface} is empty`);
    return problems;
  }
  const seen = new Set<string>();
  for (const name of names) {
    if (!HEADER_NAME_TOKEN.test(name)) {
      problems.push(`${surface} name is not an RFC 9110 token`);
      continue;
    }
    const lower = name.toLowerCase();
    if (seen.has(lower)) problems.push(`${surface} has two names equal ignoring case: ${lower}`);
    seen.add(lower);
    if (RESERVED_IDENTITY_HEADER_NAMES.has(lower)) {
      problems.push(`${surface} name is reserved: ${lower}`);
    }
    const value = map[name];
    if (typeof value !== 'string' || value.length === 0) {
      problems.push(`${surface} value for ${lower} is empty`);
    } else if (value.length > MAX_IDENTITY_VALUE_LENGTH) {
      problems.push(
        `${surface} value for ${lower} is over ${MAX_IDENTITY_VALUE_LENGTH} characters`,
      );
    } else if (CONTROL_CHARS.test(value)) {
      problems.push(`${surface} value for ${lower} has a control character`);
    }
  }
  return problems;
}

/**
 * Every reason `identity` is not a usable declaration; empty means valid. Messages name
 * header NAMES only, never values.
 */
export function validateClientIdentity(identity: PresetClientIdentity): readonly string[] {
  const problems: string[] = [];
  const label = typeof identity.label === 'string' ? identity.label.trim() : '';
  if (label.length === 0) problems.push('label is empty');
  else if (label.length > MAX_IDENTITY_LABEL_LENGTH) {
    problems.push(`label is over ${MAX_IDENTITY_LABEL_LENGTH} characters`);
  } else if (CONTROL_CHARS.test(label)) problems.push('label has a control character');
  problems.push(...headerMapProblems('apiHeaders', identity.apiHeaders));
  if (identity.tokenHeaders !== undefined) {
    problems.push(...headerMapProblems('tokenHeaders', identity.tokenHeaders));
  }
  return problems;
}

/** True when `validateClientIdentity` finds nothing to reject. */
export function isValidClientIdentity(identity: PresetClientIdentity): boolean {
  return validateClientIdentity(identity).length === 0;
}

/**
 * What a preset lookup resolved for a row (design D3/D4): the preset's declaration, if
 * any, and the ONE endpoint pin the row must still match. An OAuth preset has a single
 * pin; a key preset's lookup supplies the pin of the region the row matched, so the rule
 * below needs no edit for a multi-region preset.
 */
export interface IdentityBinding {
  readonly identity: PresetClientIdentity | undefined;
  readonly pin: {
    readonly baseUrl: string;
    readonly protocol: OauthPreset['protocol'];
  };
}

/** The row columns the availability rule and the switch read. */
export type IdentityRow = Pick<ProviderRow, 'kind' | 'baseUrl' | 'protocol'> &
  Partial<Pick<ProviderRow, 'imitateClientIdentity'>>;

// Validation is a pure function of the (constant) declaration object: memoize it so the
// per-request path pays one WeakMap lookup.
const validityMemo = new WeakMap<PresetClientIdentity, boolean>();

function declarationIsValid(identity: PresetClientIdentity): boolean {
  let valid = validityMemo.get(identity);
  if (valid === undefined) {
    valid = isValidClientIdentity(identity);
    validityMemo.set(identity, valid);
  }
  return valid;
}

/**
 * The ONE availability rule (allow-preset-client-identity, design D3). Returns the
 * binding's declaration only when the row is a `subscription` provider, the declaration
 * validates, and the row still sits on the pinned endpoint and protocol. The deployment
 * mode is deliberately not an input (design D9).
 */
export function clientIdentityFor(
  row: IdentityRow,
  binding: IdentityBinding | undefined,
): PresetClientIdentity | null {
  if (row.kind !== 'subscription') return null;
  const identity = binding?.identity;
  if (identity === undefined) return null;
  if (!declarationIsValid(identity)) return null;
  if (row.baseUrl !== binding!.pin.baseUrl || row.protocol !== binding!.pin.protocol) {
    return null;
  }
  return identity;
}

/**
 * The headers to send for a surface: the available declaration's `apiHeaders` or
 * `tokenHeaders`, only while the row's switch is on; `undefined` otherwise (and for a
 * token surface the preset gave no headers). The switch is read from whichever row the
 * caller holds (the request's row, the locked `fresh` row, or the row read just before
 * an exchange, design D6).
 */
export function identityHeaders(
  row: Pick<ProviderRow, 'imitateClientIdentity'>,
  available: PresetClientIdentity | null,
  surface: 'api' | 'token',
): Readonly<Record<string, string>> | undefined {
  if (available === null || row.imitateClientIdentity !== true) return undefined;
  return surface === 'api' ? available.apiHeaders : available.tokenHeaders;
}

/**
 * The API view of an available declaration (design D8): the label only, never the header
 * names or values. `null` when imitation is not available for the row.
 */
export function clientIdentityView(
  available: PresetClientIdentity | null,
): { label: string } | null {
  return available === null ? null : { label: available.label };
}
