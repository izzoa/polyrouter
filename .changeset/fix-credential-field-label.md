---
"@polyrouter/frontend": patch
---

fix(providers): credential field mislabeled "Base URL" for custom/local kinds

In the add/edit provider form, selecting the Custom endpoint (or Local) kind labeled
the API-key input as a second "Base URL" field with a URL placeholder. The kind
definitions now label it "API key" with key-shaped placeholders; the dedicated Base URL
field is unchanged.
