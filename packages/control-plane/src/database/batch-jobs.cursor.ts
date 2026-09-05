import type { BatchJobsCursor } from '@polyrouter/shared/server';

/** The opaque keyset cursor of the batch-job listing (active first, then
 * newest-submitted, tie-broken by id; the timestamp is the column's full µs
 * text). Encoded by the accessor, decoded by whichever service pages. */
export function encodeBatchJobsCursor(c: BatchJobsCursor): string {
  return Buffer.from(`${c.terminal ? '1' : '0'}|${c.submittedAt}|${c.id}`, 'utf8').toString(
    'base64',
  );
}

const SUBMITTED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** Null for anything that is not a cursor this listing produced. */
export function decodeBatchJobsCursor(raw: string): BatchJobsCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = decoded.split('|');
  if (parts.length !== 3) return null;
  const [t, submittedAt, id] = parts as [string, string, string];
  if ((t !== '0' && t !== '1') || !SUBMITTED_AT.test(submittedAt) || id.length === 0) return null;
  return { terminal: t === '1', submittedAt, id };
}
