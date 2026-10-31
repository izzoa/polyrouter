# Connect an agent

polyrouter speaks the OpenAI and Anthropic wire protocols, so any tool that lets you
set a **base URL** and **API key** works with no other changes. Create an agent key in
the dashboard (**Agents → New** — it looks like `poly_…` and is shown once), then point
your client at your instance:

- **Base URL:** an **OpenAI** SDK/client uses `https://<your-instance>/v1`; an **Anthropic** SDK uses
  `https://<your-instance>` (it appends `/v1/messages` itself). The raw endpoints are
  `/v1/chat/completions`, `/v1/messages`, and `/v1/models`
- **API key:** the `poly_…` key from the dashboard (sent as `Authorization: Bearer poly_…`)
- **Model:** an explicit model id (e.g. `gpt-4o`), `auto` (let the router pick), or a tier
  via the `x-polyrouter-tier` header — a tier you've created under Routing (only `default`
  exists out of the box; an unknown tier value falls back to default routing)

```bash
# OpenAI-compatible
curl https://<your-instance>/v1/chat/completions \
  -H "Authorization: Bearer poly_your_key" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}'

# Anthropic-compatible
curl https://<your-instance>/v1/messages \
  -H "Authorization: Bearer poly_your_key" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-3-5-sonnet","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'

# Pin a routing tier instead of a model:
#   -H "x-polyrouter-tier: fast"   (with "model":"auto")
```

The router applies your configured fallbacks, spend limits, and cost tracking on every
call. Explicit routing (a named model) is the reliable core; `auto` and tier routing are
opt-in and always degrade back to explicit/default.

### Terminal agents (OpenClaw, Hermes)

Terminal-native agents are configured with a **config file** rather than SDK code.
Both speak the OpenAI-compatible endpoint, so point their `base_url` at
`https://<your-instance>/v1` with your `poly_…` key and let the router pick the model
(`auto`). The dashboard's **Agents → New** picks the harness and shows the exact block once;
the equivalents are:

**OpenClaw** — `~/.openclaw/openclaw.json` (JSON5): register the router as a provider and
make it the default —

```json5
{
  models: {
    providers: {
      polyrouter: {
        baseUrl: 'https://<your-instance>/v1',
        apiKey: 'poly_your_key',
        api: 'openai-completions',
        models: [{ id: 'auto' }],
      },
    },
  },
  agents: { defaults: { model: { primary: 'polyrouter/auto' } } },
}
```

**[Hermes Agent](https://github.com/NousResearch/hermes-agent)** — `~/.hermes/config.yaml`:

```yaml
model:
  default: auto
  provider: custom
  base_url: 'https://<your-instance>/v1'
  api_key: 'poly_your_key'
```

Prefer to keep the key out of the YAML? Hermes supports env substitution — use
`api_key: ${POLYROUTER_KEY}` in `~/.hermes/config.yaml` and put `POLYROUTER_KEY=poly_your_key`
in `~/.hermes/.env`.

### Max-tokens field for OpenAI-compatible providers

Each **OpenAI-compatible** provider has a `maxTokensSpelling` setting (DB `max_tokens_spelling`)
that controls which wire field polyrouter sends the output-token cap under:

- `auto` (default) — kind-derived: a **local** provider emits `max_tokens` (older self-hosted
  runtimes like llama.cpp / LM Studio accept only that and **silently ignore** the newer field,
  which would drop your cap); every other kind emits `max_completion_tokens`, required by
  OpenAI's o-series and other reasoning models.
- `max_completion_tokens` / `max_tokens` — force one field. Set `max_tokens` for a **custom**
  endpoint that only understands the legacy field; `max_completion_tokens` for a reasoning
  endpoint reached through a custom `base_url`.

It only applies to OpenAI-compatible providers (Anthropic-compatible always uses `max_tokens`),
and is set on the provider create/update API (a dashboard control is a follow-up).
