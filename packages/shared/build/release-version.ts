import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The release version, read at BUILD time for `polyrouter/<version>` (the
 * outbound User-Agent, add-honest-user-agent). Release versions follow the
 * frontend package's version (`CHANGELOG.md`), so that manifest is the one
 * source. It is read with `readFileSync` + `JSON.parse` — never imported — so
 * this is a build input, not a code dependency, and the workspace boundary
 * matrix (`shared` depends on no workspace package) still holds.
 */

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Validates a release version; throws an error that names the release version. */
export function validateReleaseVersion(value: unknown): string {
  if (typeof value !== 'string' || !SEMVER.test(value)) {
    throw new Error(
      `polyrouter release version is missing or invalid: expected a semantic version ` +
        `(MAJOR.MINOR.PATCH) in packages/frontend/package.json "version", got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** Reads and validates `version` from the frontend manifest. */
export function readReleaseVersion(
  manifestPath: string = fileURLToPath(new URL('../../frontend/package.json', import.meta.url)),
): string {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown };
  return validateReleaseVersion(manifest.version);
}
