---
'@polyrouter/control-plane': minor
'@polyrouter/frontend': minor
---

Kimi Code and Z.ai offer the identity-imitation switch when you connect them

The coding-plan detail in Add provider → Subscription now shows the identity-imitation switch for a plan that declares a client identity (Kimi Code and Z.ai GLM Coding Plan), off by default and behind the same confirmation as Edit. Connect sends the choice, so the new provider starts with the switch as you set it and its first Test already uses it; the switch stays available in Edit. `POST /api/providers/key-presets/connect` accepts an optional boolean `imitateClientIdentity`, exactly as the OAuth sign-in start does: absent means off, `null` is refused with 400, and `true` for a plan that declares no identity (OpenCode Go, MiniMax M Plan) is refused with 422 and writes nothing. The key-preset list gains `clientIdentityLabel`, the declared client's display name, for the confirmation. No migration and no new configuration.
