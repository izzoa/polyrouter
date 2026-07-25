---
'@polyrouter/control-plane': patch
---

The `CALIBRATION_*` and `EVENTS_*` knobs now actually reach the container. The shipped
`docker-compose.yml` declares an explicit `environment:` allow-list rather than passing the
whole `.env` through, and neither namespace was on it — so all six calibration variables
(which the README's own `.env` reference told operators to set) and all seven dashboard
event-stream variables were silently dropped, leaving both subsystems on their defaults
with no error and nothing in the logs to explain why. They are now declared as optional
bare-key pass-throughs alongside the existing `ROUTING_*`, `BUDGET_*` and `PROXY_*` tunables.

Unset behaves exactly as before — an undeclared variable stays undefined and the app applies
its registered default — so this changes nothing for a deployment that was not setting them.
For one that *was* setting them in `.env` and silently getting defaults, the values now take
effect on the next `up`, which is the behaviour the documentation always described.

`SEMANTIC_*` is deliberately left out: those belong to `docker-compose.semantic.yml` and are
only meaningful with the `-semantic` image, and `SEMANTIC_MODEL_PATH` stays baked into that
image.
