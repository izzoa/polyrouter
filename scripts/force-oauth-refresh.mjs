#!/usr/bin/env node
/**
 * Force an OAuth subscription refresh for the live verification runbooks
 * (scripts/verify-claude-oauth.md, scripts/verify-chatgpt-oauth.md). Preset-agnostic:
 * the envelope is spread through the rewrite, so per-preset fields (e.g. the ChatGPT
 * accountId) survive the rewind.
 *
 * The resolver reads expiry from the ENCRYPTED ENVELOPE — editing the display column
 * `credential_expires_at` alone would not force anything (codex round 3). This helper
 * decrypts the envelope with PROVIDER_CREDENTIAL_KEY, rewinds the embedded `expiresAt`
 * to now-1s, re-encrypts, and updates the row — so the NEXT request must perform a
 * real refresh (observable as a rotated refresh token + a jumped expiry).
 *
 * Usage:
 *   DATABASE_URL=postgres://… PROVIDER_CREDENTIAL_KEY=<hex64> \
 *     node scripts/force-oauth-refresh.mjs <provider-id>
 *
 * Local only; never prints token material.
 */
import pg from 'pg';
import {
  decryptSecret,
  encryptSecret,
  parseCredentialEnvelope,
  serializeOauthCredential,
} from '@polyrouter/shared/server';

const [providerId] = process.argv.slice(2);
const { DATABASE_URL, PROVIDER_CREDENTIAL_KEY } = process.env;
if (!providerId || !DATABASE_URL || !PROVIDER_CREDENTIAL_KEY) {
  console.error(
    'usage: DATABASE_URL=… PROVIDER_CREDENTIAL_KEY=… node scripts/force-oauth-refresh.mjs <provider-id>',
  );
  process.exit(1);
}

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();
try {
  const res = await client.query(
    'SELECT encrypted_credentials, oauth_preset FROM provider WHERE id = $1',
    [providerId],
  );
  const row = res.rows[0];
  if (!row?.encrypted_credentials || row.oauth_preset === null) {
    console.error('provider not found or not OAuth-connected');
    process.exit(1);
  }
  const parsed = parseCredentialEnvelope(decryptSecret(row.encrypted_credentials, PROVIDER_CREDENTIAL_KEY));
  if (parsed.kind !== 'oauth') {
    console.error('stored credential is not an OAuth envelope');
    process.exit(1);
  }
  const rewound = { ...parsed.cred, expiresAt: Date.now() - 1000 };
  await client.query(
    'UPDATE provider SET encrypted_credentials = $2, credential_expires_at = to_timestamp($3 / 1000.0) WHERE id = $1',
    [providerId, encryptSecret(serializeOauthCredential(rewound), PROVIDER_CREDENTIAL_KEY), rewound.expiresAt],
  );
  console.log(
    'envelope expiry rewound — the next request/test will perform a real refresh (verify the refresh token rotated and credential_expires_at jumped forward)',
  );
} finally {
  await client.end();
}
