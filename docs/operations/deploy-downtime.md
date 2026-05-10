# Deploy Downtime Behavior

## Current behavior

The deploy script (`scripts/deploy-vps.sh`) and manual deploy sequence use
`docker compose up -d --force-recreate --no-deps <service>`. This stops the
old container and starts a new one, resulting in a **5–30 second window**
where the service is unavailable.

During this window:
- In-flight HTTP requests to the recreated service return connection errors
- SSE streams disconnect (clients auto-reconnect)
- Queue workers stop processing until the new container is healthy

## Mitigations already in place

1. **Caddy reverse proxy** buffers brief connection failures. Requests that
   arrive during the ~1s container swap may be retried by Caddy before the
   client sees an error. This covers most sub-second restarts but not the
   full 5–30s build+startup window.

2. **Health checks** prevent traffic from routing to a container that hasn't
   finished starting. The `start_period` on each service gives the app time
   to boot before health probes begin failing.

3. **`--no-deps`** ensures only the targeted service restarts. Postgres,
   Redis, and other dependencies stay running throughout.

## Operator guidance

- **Schedule deploys during low-traffic windows** when possible.
- **Deploy services independently** — rebuild only what changed (the deploy
  script does this automatically via `git diff`).
- **Verify after deploy** — check `/health` and the SSE stream to confirm
  the new container is serving traffic.

## Future: blue-green deployment

Zero-downtime deploys require running two instances of the service
simultaneously and switching traffic atomically:

1. Start the new container on a different internal port
2. Health-check it independently
3. Swap Caddy's upstream to the new container
4. Drain and stop the old container

This is tracked but not yet implemented. The current downtime window is
acceptable for the user base size. When it matters, this doc will be updated
with the blue-green procedure.
