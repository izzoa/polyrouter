// add-subscription-quota-display task 6.4, amended by add-subscription-usage-history task 7.1:
// the self-hosting docs name every usage endpoint the registries declare (key presets and the
// Claude and ChatGPT OAuth presets), and state the interactions both tasks list.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEY_PRESETS } from '../subscription-presets/key-presets';
import { OAUTH_PRESETS } from '../subscription-oauth/presets';

const docs = readFileSync(join(__dirname, '../../../../docs/self-hosting.md'), 'utf8');
const section = docs.slice(
  docs.indexOf('#### Plan usage on the card'),
  docs.indexOf('### Model lists stay current'),
);

describe('docs/self-hosting.md plan-usage section', () => {
  it('exists and names every usage endpoint in both registries', () => {
    expect(docs).toContain('#### Plan usage on the card');
    const keyUrls = KEY_PRESETS.flatMap((p) => p.regions.map((r) => r.usageProbe?.url)).filter(
      (u): u is string => u !== undefined,
    );
    const oauthUrls = OAUTH_PRESETS.map((p) => p.usageProbe?.url).filter(
      (u): u is string => u !== undefined,
    );
    expect(keyUrls.length).toBeGreaterThanOrEqual(6);
    expect(oauthUrls).toEqual([
      'https://api.anthropic.com/api/oauth/usage',
      'https://chatgpt.com/backend-api/wham/usage',
    ]);
    for (const url of [...keyUrls, ...oauthUrls]) expect(section).toContain(url);
  });

  it('states the shared cooldown, the honest UA, the enablement and the exclusions', () => {
    expect(section).toMatch(/5-minute cooldown/);
    expect(section).toMatch(/User-Agent: polyrouter\/<version>/);
    expect(section).toMatch(/never sends the\s+imitation identity/);
    expect(section).toMatch(/ships enabled/i);
    expect(section).not.toMatch(/ships disabled/i);
    expect(section).not.toMatch(/no Refresh usage for Claude or ChatGPT/i);
    expect(section).toMatch(/account-wide/);
    expect(section).toMatch(/kimi-code#2937/);
    expect(section).toMatch(/Z\.ai's terms/);
    expect(section).toMatch(/403 when a plan is used up/);
    expect(section).toMatch(/credential-style status line/);
    expect(section).toMatch(/ambiguous/);
  });

  it('states the schedule, its switch, the ToS caution, the history and the display-only rule', () => {
    expect(section).toMatch(/about every 15 minutes/);
    expect(section).toMatch(/Check plan usage on a schedule/);
    expect(section).toMatch(/checkPlanUsage/);
    expect(section).toMatch(/automatically extracting data/);
    expect(section).toMatch(/35-day history/);
    expect(section).toMatch(/plan_usage_sample/);
    expect(section).toMatch(/no reading yet/);
    expect(section).toMatch(/never spends plan quota/);
    expect(section).toMatch(/never changes routing/);
    expect(section).toMatch(/anthropic-beta: oauth-2025-04-20/);
    expect(section).toMatch(/chatgpt-account-id/);
  });
});
