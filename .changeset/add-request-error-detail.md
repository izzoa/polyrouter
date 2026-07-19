---
'@polyrouter/control-plane': minor
'@polyrouter/data-plane': minor
'@polyrouter/frontend': minor
'@polyrouter/shared': minor
---

Failed requests now record and display what the provider actually said. The
request drawer gains an ERROR card (error kind, upstream HTTP status, the
provider's own error message, and the upstream request id) backed by four new
`request_log` columns captured at failure time — including mid-stream failures,
whose wire error message was previously discarded. Privacy holds by
construction: messages persist only from structured provider error fields
through a sanitizing factory (exact credential redaction first, then heuristic
secret scrubbing; validation and content-policy messages are withheld since
they can quote prompt content), raw bodies never persist, and agent-facing
error responses are unchanged. Existing rows render exactly as before.
