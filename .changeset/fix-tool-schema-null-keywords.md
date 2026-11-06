---
'@polyrouter/data-plane': patch
'@polyrouter/control-plane': patch
---

Tool schemas whose standard keywords are `null` (for example Warp's `"required": null` on its `finish` and `transfer_control_to_user` tools) are now repaired on the way into the router, so strict OpenAI-compatible providers no longer reject the whole request with HTTP 400. A null-valued standard JSON Schema keyword is removed, only where a subschema can appear, so instance data such as `const`, `default`, `examples` and `enum` and property names such as a property called `required` are left alone. Your client's request body is never modified, and a schema with nothing to remove is passed through unchanged. One routing edge case: when every tool's top-level schema consisted only of null keywords (for example `{"required": null}`), the structural router's tool-schema signal (`toolSchemaDemand`) is now false instead of true, so its `schema` sub-score drops from 1 to 0 unless a structured-output format is declared, and that request can land in a different Layer 1 band.
