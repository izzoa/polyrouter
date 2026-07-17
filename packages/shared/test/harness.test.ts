import { describe, expect, it } from 'vitest';
import {
  HARNESS_LABELS,
  HARNESS_TYPES,
  connectionSnippet,
  isHarnessType,
  type HarnessType,
} from '../src/harness';

const BASE = 'https://router.example.com/v1';
const KEY = 'poly_testkey';

describe('harness registry', () => {
  it('every type has a label and there are no stray labels', () => {
    for (const t of HARNESS_TYPES) {
      expect(HARNESS_LABELS[t], `label for ${t}`).toBeTruthy();
    }
    expect(Object.keys(HARNESS_LABELS).sort()).toEqual([...HARNESS_TYPES].sort());
  });

  it('isHarnessType recognizes members and rejects non-members', () => {
    expect(isHarnessType('hermes')).toBe(true);
    expect(isHarnessType('openclaw')).toBe(true);
    expect(isHarnessType('nope')).toBe(false);
  });
});

describe('connectionSnippet golden output', () => {
  it('hermes → ~/.hermes/config.yaml model block, OpenAI-compatible /v1, default auto', () => {
    expect(connectionSnippet('hermes', BASE, KEY)).toBe(
      [
        '# ~/.hermes/config.yaml',
        'model:',
        '  default: auto',
        '  provider: custom',
        `  base_url: "${BASE}"`,
        `  api_key: "${KEY}"`,
      ].join('\n'),
    );
  });

  it('hermes → an unusual base_url stays a valid escaped YAML scalar', () => {
    // BETTER_AUTH_URL is only URL-validated; a quote/backslash must not break the YAML.
    const nasty = 'https://ex.com/v1"evil\\x';
    const snippet = connectionSnippet('hermes', nasty, KEY);
    // JSON.stringify is a valid YAML double-quoted scalar (same escapes).
    expect(snippet).toContain(`  base_url: ${JSON.stringify(nasty)}`);
    expect(snippet).not.toContain(`base_url: "${nasty}"`); // raw, unescaped — must NOT appear
  });

  it('openclaw → ~/.openclaw/config.toml [llm] block, OpenAI-compatible /v1', () => {
    expect(connectionSnippet('openclaw', BASE, KEY)).toBe(
      `# ~/.openclaw/config.toml\n[llm]\nbase_url = "${BASE}"\napi_key  = "${KEY}"\nmodel    = "auto"`,
    );
  });

  it('anthropic_sdk → Anthropic SDK with /v1 stripped from base_url', () => {
    const out = connectionSnippet('anthropic_sdk', BASE, KEY);
    expect(out).toContain('import anthropic');
    expect(out).toContain('base_url="https://router.example.com"'); // /v1 removed
    expect(out).not.toContain('/v1"');
  });

  it('curl → shell command against the OpenAI /v1 chat endpoint', () => {
    const out = connectionSnippet('curl', BASE, KEY);
    expect(out).toContain(`curl ${BASE}/chat/completions`);
    expect(out).toContain(`Authorization: Bearer ${KEY}`);
  });

  it('openai_sdk / vercel_ai_sdk / langchain → OpenAI SDK with the /v1 base URL', () => {
    for (const t of ['openai_sdk', 'vercel_ai_sdk', 'langchain'] as HarnessType[]) {
      const out = connectionSnippet(t, BASE, KEY);
      expect(out, t).toContain('from openai import OpenAI');
      expect(out, t).toContain(`base_url="${BASE}"`);
    }
  });
});
