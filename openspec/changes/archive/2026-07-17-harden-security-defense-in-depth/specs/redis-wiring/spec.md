## MODIFIED Requirements

### Requirement: Shared Redis client with managed lifecycle

The control plane SHALL provide a Redis client (ioredis — BullMQ-compatible for the notifications change) as an injectable Nest module: lazy-connecting with a bounded retry strategy, closed gracefully on application shutdown, and with an attached `error` listener so a connection outage does NOT emit an "Unhandled error event" per reconnect attempt (log flooding / a latent EventEmitter crash). The error listener SHALL log a latched, class-only line (reset on a successful (re)connect) and SHALL NEVER log the connection URL or credentials. `REDIS_URL` SHALL be registered in the config framework (namespace `redis`) with URL/protocol validation and the spec §12 default `redis://localhost:6379`. Counters, circuit breakers, and queues are owned by later changes.

#### Scenario: Client is available to modules
- **WHEN** a module injects the Redis client and issues a PING with the dev compose up
- **THEN** the command succeeds against the configured `REDIS_URL`

#### Scenario: Shutdown closes the connection
- **WHEN** the application shuts down
- **THEN** the Redis connection is quit cleanly (no dangling handles keeping the process alive)

#### Scenario: An outage does not flood logs with unhandled errors
- **WHEN** the Redis server becomes unreachable and ioredis retries
- **THEN** the attached `error` listener contains the errors to a single latched, credential-free log line rather than a per-attempt "Unhandled error event"

#### Scenario: Invalid Redis URL fails fast
- **WHEN** `REDIS_URL` is set to a non-redis URL
- **THEN** boot exits non-zero naming `REDIS_URL` without echoing the value
