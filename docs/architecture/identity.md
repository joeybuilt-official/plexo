# Identity Architecture

Plexo runs standalone with [Better Auth](https://better-auth.com) as the default identity provider — no external dependencies required. Configure via `BETTER_AUTH_SECRET` and OAuth provider env vars (see [`docs/configuration.md`](../configuration.md)). For multi-application identity federation (single sign-on across an app fleet via `postgres_fdw`), see the private `service` repository — that overlay is specific to Joeybuilt's deployment and not required for self-host.
