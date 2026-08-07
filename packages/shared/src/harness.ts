/** Canonical supported-harness list and connection snippets (spec §2.1).
 * Browser-safe (root entry) — consumed by both the dashboard and the auth
 * change's agent-create responses so there is one source of truth. */

export const HARNESS_TYPES = [
  'openai_sdk',
  'anthropic_sdk',
  'vercel_ai_sdk',
  'langchain',
  'openclaw',
  'hermes',
  'curl',
] as const;

export type HarnessType = (typeof HARNESS_TYPES)[number];

export function isHarnessType(value: string): value is HarnessType {
  return (HARNESS_TYPES as readonly string[]).includes(value);
}

export const HARNESS_LABELS: Record<HarnessType, string> = {
  openai_sdk: 'OpenAI SDK',
  anthropic_sdk: 'Anthropic SDK',
  vercel_ai_sdk: 'Vercel AI SDK',
  langchain: 'LangChain',
  openclaw: 'OpenClaw',
  hermes: 'Hermes',
  curl: 'cURL / other',
};

/** Copy-paste connection snippet pointing a harness at the router. */
export function connectionSnippet(harness: HarnessType, baseUrl: string, apiKey: string): string {
  if (harness === 'anthropic_sdk') {
    return `import anthropic\n\nclient = anthropic.Anthropic(\n    base_url="${baseUrl.replace('/v1', '')}",\n    api_key="${apiKey}")\n# model="auto" lets the router decide`;
  }
  if (harness === 'curl') {
    return `curl ${baseUrl}/chat/completions \\\n  -H "Authorization: Bearer ${apiKey}" \\\n  -d '{"model":"auto","messages":[...]}'`;
  }
  if (harness === 'openclaw') {
    // OpenClaw's only config is JSON5 at ~/.openclaw/openclaw.json (its src/config/paths.ts:
    // CONFIG_FILENAME = "openclaw.json"; no TOML loader exists). A custom OpenAI-compatible
    // endpoint is a models.providers entry, and the default model is selected by
    // agents.defaults.model.primary in provider/model form — so one `auto` model keeps the
    // router doing the choosing, same contract as every other harness. JSON.stringify emits
    // properly-escaped double-quoted strings (valid JSON5), so an unusual base_url/key can't
    // corrupt the block — the same guarantee the hermes snippet makes for YAML.
    return `// ~/.openclaw/openclaw.json  (JSON5)\n{\n  models: {\n    providers: {\n      polyrouter: {\n        baseUrl: ${JSON.stringify(baseUrl)},\n        apiKey: ${JSON.stringify(apiKey)},\n        api: "openai-completions",\n        models: [{ id: "auto" }],\n      },\n    },\n  },\n  agents: { defaults: { model: { primary: "polyrouter/auto" } } },\n}`;
  }
  if (harness === 'hermes') {
    // OpenAI-compatible: base_url keeps its /v1, provider=custom, default=auto lets the
    // router decide. JSON.stringify emits a properly-escaped double-quoted scalar (valid
    // YAML) so an unusual base_url/key can't corrupt the block.
    return `# ~/.hermes/config.yaml\nmodel:\n  default: auto\n  provider: custom\n  base_url: ${JSON.stringify(baseUrl)}\n  api_key: ${JSON.stringify(apiKey)}`;
  }
  // openai_sdk, vercel_ai_sdk, langchain all speak the OpenAI base URL
  return `from openai import OpenAI\n\nclient = OpenAI(\n    base_url="${baseUrl}",\n    api_key="${apiKey}")\n# model="auto" lets the router decide`;
}
