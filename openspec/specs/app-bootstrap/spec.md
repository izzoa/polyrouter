# app-bootstrap Specification

## Purpose
TBD - created by archiving change add-monorepo-foundation. Update Purpose after archive.
## Requirements
### Requirement: NestJS server skeleton with global input validation
The control-plane SHALL be a NestJS 11 application with a global `ValidationPipe` configured with `whitelist: true` and `forbidNonWhitelisted: true`, applied to all input (CLAUDE.md coding standards).

#### Scenario: Non-whitelisted property is rejected
- **WHEN** a request body containing a property not declared on the endpoint's DTO reaches any validated endpoint
- **THEN** the request is rejected with HTTP 400 and the property never reaches handler code

### Requirement: Unauthenticated health endpoint
The server SHALL expose `GET /api/health` returning HTTP 200 with `{ "status": "ok" }`, requiring no authentication. This is the endpoint packaging (§13) later wires to orchestration.

#### Scenario: Health check succeeds
- **WHEN** `GET /api/health` is requested on a running instance
- **THEN** the response is HTTP 200 with body `{ "status": "ok" }`

### Requirement: Production serves SPA and API on one port
In production (`npm run build` + `npm start`), the NestJS process SHALL serve the built SolidJS SPA and the API on the single configured port (spec §3.1/§4 single-container topology), with SPA fallback for non-`/api`, non-`/v1` routes. `npm start` SHALL run the server in production mode explicitly, regardless of any `NODE_ENV` inherited from the environment.

#### Scenario: One port serves both
- **WHEN** the production server is running on the configured `PORT`
- **THEN** `GET /` returns the SPA shell and `GET /api/health` returns 200 from the same port

#### Scenario: Start command forces production mode
- **WHEN** `npm start` runs in an environment where `NODE_ENV` is unset **or inherited as `development`**
- **THEN** the server behaves as production in both cases: the SPA is served and no permissive CORS headers are emitted

#### Scenario: Deep links resolve to the SPA
- **WHEN** a browser requests a client-side route (e.g. `/agents`) directly
- **THEN** the server responds with the SPA shell (not 404), leaving `/api/*` and `/v1/*` untouched

#### Scenario: Unknown API routes are not swallowed by the fallback
- **WHEN** `GET /api/nonexistent` or `GET /v1/nonexistent` is requested in production
- **THEN** the server returns a 404 (JSON error), not the SPA shell

### Requirement: Dev topology with dev-only CORS
In development, the Vite dev server SHALL run on `:3000` and proxy `/api` and `/v1` to the backend on `:3001` (spec §4). CORS SHALL be enabled only when `NODE_ENV=development`; production SHALL NOT emit permissive CORS headers.

#### Scenario: Dev proxy round-trip
- **WHEN** `npm run dev` is running and the browser requests `http://localhost:3000/api/health`
- **THEN** the Vite proxy forwards to `:3001` and returns the backend's 200 response

#### Scenario: No CORS in production
- **WHEN** a cross-origin request hits the production server
- **THEN** no `Access-Control-Allow-Origin` header is returned

