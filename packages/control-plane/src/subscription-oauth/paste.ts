/**
 * The connect wizard's paste parser (add-subscription-oauth). Exactly TWO accepted
 * forms, both of which MUST yield `code` AND `state` (there is no state-less
 * completion path — both presets deliver state):
 *
 *   1. the full redirect URL — must match the preset's registered callback origin+path
 *      exactly and carry exactly one `code` and one `state` (query OR fragment, not
 *      both; duplicated parameters rejected per RFC 6749 §3.1), or
 *   2. `code#state` (the code-display page's copy format).
 *
 * The input is CREDENTIAL MATERIAL: size-capped, control-character-rejected, never
 * logged/echoed — errors carry fixed messages only (invariant 8).
 */

export const MAX_PASTE_LEN = 4096;

export interface ParsedPaste {
  readonly code: string;
  readonly state: string;
}

export class PasteParseError extends Error {
  constructor(message: string) {
    super(message); // fixed guidance strings only — never the pasted content
    this.name = 'PasteParseError';
  }
}

// eslint-disable-next-line no-control-regex -- rejecting control chars is the point
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
/** OAuth `code`/`state` are URL-safe tokens; anything else is malformed. */
const TOKEN_SHAPE = /^[A-Za-z0-9._~-]+$/;

function single(params: string[][], name: string): string | null {
  const values = params.filter(([k]) => k === name).map(([, v]) => v);
  if (values.length !== 1) return null; // absent or duplicated → reject (RFC 6749 §3.1)
  const v = values[0] ?? '';
  return TOKEN_SHAPE.test(v) ? v : null;
}

export function parsePastedRedirect(pasted: string, registeredRedirectUri: string): ParsedPaste {
  if (pasted.length === 0 || pasted.length > MAX_PASTE_LEN) {
    throw new PasteParseError('paste the full redirect URL or the code#state string');
  }
  if (CONTROL_CHARS.test(pasted)) {
    throw new PasteParseError('the pasted value contains unexpected characters');
  }
  const trimmed = pasted.trim();

  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new PasteParseError('that does not look like a valid redirect URL');
    }
    const registered = new URL(registeredRedirectUri);
    if (url.origin !== registered.origin || url.pathname !== registered.pathname) {
      throw new PasteParseError('that URL is not this preset’s sign-in callback');
    }
    const query = [...url.searchParams.entries()];
    const fragment = url.hash.startsWith('#')
      ? [...new URLSearchParams(url.hash.slice(1)).entries()]
      : [];
    const inQuery = query.some(([k]) => k === 'code' || k === 'state');
    const inFragment = fragment.some(([k]) => k === 'code' || k === 'state');
    if (inQuery && inFragment) {
      throw new PasteParseError('that URL carries parameters in both the query and the fragment');
    }
    const params = inFragment ? fragment : query;
    const code = single(params, 'code');
    const state = single(params, 'state');
    if (code === null || state === null) {
      throw new PasteParseError(
        'the URL must carry exactly one code and one state — copy the full address after signing in',
      );
    }
    return { code, state };
  }

  // `code#state` — the code-display page's format. A bare code has no state → reject.
  const hash = trimmed.indexOf('#');
  if (hash <= 0 || hash === trimmed.length - 1) {
    throw new PasteParseError(
      'paste the full redirect URL or the code#state string shown after signing in (a bare code is not enough)',
    );
  }
  const code = trimmed.slice(0, hash);
  const state = trimmed.slice(hash + 1);
  if (state.includes('#') || !TOKEN_SHAPE.test(code) || !TOKEN_SHAPE.test(state)) {
    throw new PasteParseError('that does not look like a code#state string');
  }
  return { code, state };
}
