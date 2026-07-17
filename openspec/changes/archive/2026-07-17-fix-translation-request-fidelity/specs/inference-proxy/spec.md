# inference-proxy — delta for fix-translation-request-fidelity

## ADDED Requirements

### Requirement: A multi-choice (`n > 1`) request is rejected in-protocol

The IR normalizes a single assistant choice and delegates `n > 1` policy to the proxy
(protocol-translation). The proxy SHALL enforce that policy: an OpenAI-wire request whose `n` is a
number greater than 1 SHALL be rejected before any upstream call with a protocol-shaped 400
(`invalid_request_error`) explaining that the router returns a single choice — rather than silently
dropping `n` and returning one choice as if `n` had been honored. A request with `n` absent or equal
to 1 SHALL be unaffected. The rejection SHALL be raised before request normalization so its
explanatory message is not overwritten by the generic invalid-body error.

#### Scenario: n > 1 is a clear 400, not a silent single choice

- **WHEN** a client POSTs `/v1/chat/completions` with `n: 2`
- **THEN** the response is a 400 in the OpenAI error envelope naming that `n > 1` is unsupported, and no upstream call is made

#### Scenario: n = 1 or absent is served normally

- **WHEN** a client sends `n: 1` or omits `n`
- **THEN** the request is routed and served as before
