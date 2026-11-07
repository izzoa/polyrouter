// add-subscription-quota-display task 6.4: the self-hosting docs name every usage endpoint the
// registry declares (design D7), and state the interactions the task lists.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEY_PRESETS } from '../subscription-presets/key-presets';

const docs = readFileSync(join(__dirname, '../../../../docs/self-hosting.md'), 'utf8');
const section = docs.slice(docs.indexOf('#### Plan usage on the card'));

describe('docs/self-hosting.md plan-usage section (task 6.4)', () => {
  it('exists and names every usage endpoint in the registry', () => {
    expect(docs).toContain('#### Plan usage on the card');
    const urls = KEY_PRESETS.flatMap((p) => p.regions.map((r) => r.usageProbe?.url)).filter(
      (u): u is string => u !== undefined,
    );
    expect(urls.length).toBeGreaterThanOrEqual(6);
    for (const url of urls) expect(section).toContain(url);
  });

  it('states the attended-only cooldown, the honest UA, the per-region enablement and the exclusions', () => {
    expect(section).toMatch(/5-minute cooldown/);
    expect(section).toMatch(/User-Agent: polyrouter\/<version>/);
    expect(section).toMatch(/never sends the\s+imitation identity/);
    expect(section).toMatch(/ships disabled/i);
    expect(section).toMatch(/no Refresh usage for Claude or ChatGPT/i);
    expect(section).toMatch(/account-wide/);
    expect(section).toMatch(/kimi-code#2937/);
    expect(section).toMatch(/Z\.ai's terms/);
    expect(section).toMatch(/403 when a plan is used up/);
    expect(section).toMatch(/credential-style status line/);
    expect(section).toMatch(/ambiguous/);
  });
});
