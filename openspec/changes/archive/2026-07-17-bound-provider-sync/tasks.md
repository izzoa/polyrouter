## 1. E11.1a — Byte-bound the buffered response drain (data-plane)

- [x] 1.1 In `providers/adapter.ts`, add and export `DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024` and `MAX_PARSED_MODELS = 5000`.
- [x] 1.2 In `providers/http.ts`, give `drainText(stream, maxBytes = DEFAULT_MAX_RESPONSE_BYTES)` a running byte count (`+= value.length`); the moment appending a chunk would exceed `maxBytes`, cancel the reader and throw `ProviderError('bad_request', 'provider response body exceeds N bytes')` before decoding/appending it. Wrap the read loop so any throw cancels the reader (no leaked dispatcher). Both `bindDispatcherToBody` and `guardBufferedBodyIdle` inherit the cap via the default.
- [x] 1.3 Unit test (`http.spec` / adapter spec): a buffered body over the cap rejects with a `bad_request` `ProviderError` and does not accumulate past the cap; a normal-sized body still drains; a streaming (`readSseChunks`) body of many chunks is unaffected (not capped).

## 2. E11.1b — Bound model ingestion (parse + upsert)

- [x] 2.1 In `http-adapter.ts` `parseModelList`, skip a non-string, over-long (`> MAX_MODEL_ID_LEN`), or duplicate id **before** the `MAX_PARSED_MODELS` cap check (a `seen` Set + length guard), so a flood of junk/dup ids can't consume the parse budget and starve out the valid ids that follow (codex round-1 Medium). `MAX_MODEL_ID_LEN` lives in `adapter.ts` and is barrel-exported.
- [x] 2.2 In `providers.service.ts` `syncModels`, add `MAX_SYNCED_MODELS = 2000`/`MAX_MODEL_NAME_LEN = 512` and import the shared `MAX_MODEL_ID_LEN`; after dedupe, cap upsert **attempts** at `MAX_SYNCED_MODELS`, **skip** any whose `externalModelId.length > MAX_MODEL_ID_LEN` (a skipped id doesn't consume the attempt budget), and **truncate** `displayName` to `MAX_MODEL_NAME_LEN` — defense-in-depth for any path that bypasses `parseModelList`. `synced` counts only rows actually upserted.
- [x] 2.3 Service test: a `listModels` returning 10k models (one with a >512-char id) caps the upsert at `MAX_SYNCED_MODELS`, skips the oversized id, and never partial-floods; the reported `synced` matches the rows written.

## 3. A-42 — Accept a TLD-less local base_url

- [x] 3.1 In `providers.dto.ts`, set `require_tld: false` on `urlOpts` (the `@IsUrl` options shared by `CreateProviderDto`/`UpdateProviderDto`).
- [x] 3.2 e2e (`providers.e2e-spec`): creating a `local` provider with `base_url: http://localhost:11434` under `MODE=selfhosted` passes shape validation (no 400 from `@IsUrl`); a private/metadata address is still rejected by the SSRF gate (422) — the address decision stays at the gate.

## 4. Verification & wrap-up

- [x] 4.1 `npm run build && npm run lint && npm run typecheck` clean.
- [x] 4.2 `npm test -w packages/data-plane -w packages/control-plane` green; `npm run test:e2e -w packages/control-plane` (providers + tenancy suites) green.
- [x] 4.3 Changeset (user-facing: local providers addable; sync/test memory-safe; sync count/field-capped).
- [x] 4.4 Update `TODOS.md` board + mark E11 ✅ (and A-42) in `FABLE_AUDIT.md` after archive.
