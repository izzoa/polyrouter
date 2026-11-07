// add-key-subscription-presets (task 8.1): a key preset adds NO host mapping. Its cost
// follows the existing host-to-family map (`PROVIDER_FAMILY_HOSTS`), so this spec pins what
// each registry region resolves to today. The expected map is explicit and keyed by preset
// and region id: a new region, or an edit to the host map, fails here until the map is
// updated deliberately. A pricing change is a `pricing-catalog` change (invariant 4), never
// a side effect of adding a preset.
import { deriveProviderFamily } from '@polyrouter/shared/server';
import { KEY_PRESETS } from './key-presets';

/** `<preset id>/<region id>` -> the family the host map resolves, or null (unknown cost). */
const EXPECTED_FAMILY: Readonly<Record<string, string | null>> = {
  // opencode.ai serves several vendors' models under one host: no single family prices it.
  'opencode-go/default': null,
  // api.minimax.io is the USD endpoint (mapped); api.minimaxi.com is the CNY one (unmapped).
  'minimax-m-plan/intl': 'minimax',
  'minimax-m-plan/cn': null,
  // Kimi's plan ids are unlikely catalog keys, so neither coding host is mapped.
  'kimi-code/intl': null,
  'kimi-code/cn': null,
  // api.z.ai is the USD endpoint (mapped); open.bigmodel.cn bills in CNY (unmapped).
  'zai-coding-plan/intl': 'zai',
  'zai-coding-plan/cn': null,
};

const registryRegions = KEY_PRESETS.flatMap((preset) =>
  preset.regions.map((region) => ({ key: `${preset.id}/${region.id}`, preset, region })),
);

describe('key-preset pricing follows the existing host map (task 8.1)', () => {
  it('every registry region, disabled ones included, resolves the expected family', () => {
    const actual = Object.fromEntries(
      registryRegions.map(({ key, region }) => [key, deriveProviderFamily(region.baseUrl)]),
    );
    expect(actual).toEqual(EXPECTED_FAMILY);
  });

  it('the expected map has exactly one entry per registry region', () => {
    expect(registryRegions.map(({ key }) => key).sort()).toEqual(
      Object.keys(EXPECTED_FAMILY).sort(),
    );
    // A region id repeated within a preset would collapse two regions onto one key.
    expect(new Set(registryRegions.map(({ key }) => key)).size).toBe(registryRegions.length);
  });

  it('only the two international USD hosts map to a family; the five other hosts are unknown', () => {
    const byHost = new Map(
      registryRegions.map(({ region }) => [
        new URL(region.baseUrl).hostname,
        deriveProviderFamily(region.baseUrl),
      ]),
    );
    expect(Object.fromEntries(byHost)).toEqual({
      'opencode.ai': null,
      'api.minimax.io': 'minimax',
      'api.minimaxi.com': null,
      'api.kimi.ai': null,
      'api.kimi.com': null,
      'api.z.ai': 'zai',
      'open.bigmodel.cn': null,
    });
  });

  it('the pay-as-you-go Z.ai path shares the coding host family (the host decides, not the path)', () => {
    // The map is host-only by design, so a Z.ai coding row and a pay-as-you-go row on the
    // same host price from the same family; the immutable provider_kind snapshot is what
    // keeps a subscription's cost notional (cost-sql), not the family.
    expect(deriveProviderFamily('https://api.z.ai/api/paas/v4')).toBe('zai');
    expect(deriveProviderFamily('https://api.z.ai/api/coding/paas/v4')).toBe('zai');
  });
});
