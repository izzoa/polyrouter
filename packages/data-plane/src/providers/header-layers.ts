/**
 * Case-insensitive header layering (allow-preset-client-identity, design D5).
 *
 * undici appends every entry of a header record, so `authorization` from an identity
 * layer beside the adapter's `Authorization` would be sent as TWO values and corrupt
 * authentication. This pure helper replaces the plain object spread that built the
 * outbound headers. Precedence, lowest first:
 *   1. `defaults`  - e.g. OpenRouter attribution;
 *   2. `extra`     - an entry replaces any default whose name matches case-insensitively;
 *   3. `protocol`  - authentication, Content-Type, Accept. An `extra` entry whose name
 *                    matches a protocol name case-insensitively is DROPPED, never merged.
 * Protocol headers keep their exact spelling. With an empty `extra` the result equals
 * `{ ...defaults, ...protocol }`. Inputs are not mutated.
 */
export function mergeHeaderLayers(
  defaults: Readonly<Record<string, string>>,
  extra: Readonly<Record<string, string>>,
  protocol: Readonly<Record<string, string>>,
): Record<string, string> {
  const protocolNames = new Set(Object.keys(protocol).map((k) => k.toLowerCase()));
  // Extra entries that survive the protocol drop. A later spelling of the same name
  // inside `extra` wins, matching the object-spread precedence this replaces.
  const kept = new Map<string, [string, string]>();
  for (const [name, value] of Object.entries(extra)) {
    const lower = name.toLowerCase();
    if (!protocolNames.has(lower)) kept.set(lower, [name, value]);
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(defaults)) {
    if (!kept.has(name.toLowerCase())) out[name] = value;
  }
  for (const [name, value] of kept.values()) out[name] = value;
  for (const [name, value] of Object.entries(protocol)) out[name] = value;
  return out;
}
