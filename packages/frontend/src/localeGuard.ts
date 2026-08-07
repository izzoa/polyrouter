/** Makes a non-conforming `navigator.language` safe before anything reads it
 *  (fix-nonstandard-locale-boot-crash).
 *
 * WHY THIS EXISTS
 * uPlot runs `new Intl.NumberFormat(navigator.language)` at MODULE SCOPE
 * (`uplot@1.6.32`, `dist/uPlot.esm.js:442`) and is imported eagerly through
 * `App → Overview → Chart`. The HTML standard requires `navigator.language` to be a valid
 * BCP-47 tag, but some hosts report otherwise — a container or kiosk launching Chromium under
 * malformed locale state reports `en-US@posix`. `Intl` rejects that, so the throw happens
 * while the module graph is being EVALUATED, before `render()` is reached: `#root` stays
 * empty and the user sees a white page with the only evidence in a console nobody is watching.
 *
 * This is a WORKAROUND for that upstream defect, not a design choice. It should be deleted
 * when uPlot stops passing the raw tag through — check on any uPlot upgrade past 1.6.32,
 * which was the current release when this was found. See the change's `measurements.md` for
 * the stack trace and the reproduction. (Upstream report not yet filed; link it here when it
 * is, so the deletion condition is one click away.)
 *
 * WHY IT IS NOT ABOUT OUR OWN FORMATTING
 * The 24 bare `toLocaleString()`/`toLocaleDateString()` calls in this app are unaffected and
 * must NOT be "fixed". ECMA-402 resolves an omitted locale through `DefaultLocale`, which the
 * runtime guarantees well-formed; only an explicitly passed tag is validated. Measured on the
 * failing host: `Intl.DateTimeFormat().resolvedOptions().locale` is `"en-US"` and
 * `(1234.5).toLocaleString()` returns `"1,234.5"` while `navigator.language` is
 * `"en-US@posix"`. A bare call is safer here than passing `navigator.language`.
 */

/** Is this tag one the runtime will actually accept?
 *
 * Tested by construction rather than by matching against a list of known-bad strings: which
 * tags are rejected is the runtime's definition, not ours. Measured — `en-US@posix`, `C`,
 * `en_US` and `""` throw, while `POSIX`, `posix` and `en-US-POSIX` are accepted. A hand-written
 * blocklist would have missed the accepted ones and over-matched the rest. */
function isUsableLocale(tag: string): boolean {
  try {
    new Intl.NumberFormat(tag);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replaces a rejected `navigator.language` with the locale the runtime itself resolved from
 * this same host — valid by construction, and already the locale this app's own formatting
 * quietly uses. Nothing is imposed that the host did not imply.
 *
 * Conditional on the tag actually being rejected: a host reporting a usable tag keeps it, so
 * this changes nothing for the overwhelming majority of users.
 *
 * @returns the substituted locale, or `null` when nothing needed changing or the substitution
 *          could not be applied.
 */
export function applyLocaleGuard(): string | null {
  if (typeof navigator === 'undefined') return null;

  const reported = navigator.language;
  if (typeof reported === 'string' && isUsableLocale(reported)) return null;

  let safe: string;
  try {
    safe = Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    // The runtime cannot even resolve its own default. Nothing sensible is left to substitute,
    // and inventing one would be guessing at a host we clearly do not understand.
    return null;
  }
  if (!isUsableLocale(safe)) return null;

  try {
    // Fail soft: if the property is not redefinable on this engine we are no worse off than
    // before. This must never be the thing that throws on the way down.
    Object.defineProperty(Navigator.prototype, 'language', {
      get: () => safe,
      configurable: true,
    });
    Object.defineProperty(Navigator.prototype, 'languages', {
      get: () => Object.freeze([safe]),
      configurable: true,
    });
  } catch {
    return null;
  }
  return safe;
}

applyLocaleGuard();
