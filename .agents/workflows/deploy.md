---
description: deploy changes — local commit → push to GitHub main → VPS pull and rebuild
---

// turbo-all

## Deploy sequence (non-negotiable)

Steps MUST run in this exact order. Never skip, reorder, or SSH to edit files directly.

The VPS host, SSH user, and app domain are in `.agents-local.md` (gitignored). Read it before running step 3.

1. Commit all local changes:
```bash
cd /home/dustin/dev/plexo && git add -A && git commit -m "<message>"
```

2. Push to GitHub main:
```bash
cd /home/dustin/dev/plexo && git push origin main
```

3. On the VPS — pull from GitHub, build changed service(s), restart:
```bash
ssh -o StrictHostKeyChecking=no <VPS_USER>@<VPS_HOST> "cd /opt/plexo && git pull origin main && export SOURCE_COMMIT=$(git rev-parse HEAD) && docker compose -f docker/compose.yml -f docker/compose.override.yml build <service> && docker compose -f docker/compose.yml -f docker/compose.override.yml up -d <service>"
```

Replace `<service>` with the affected container(s): `web`, `api`, or both.
Replace `<VPS_USER>` and `<VPS_HOST>` with values from `.agents-local.md`.

4. Smoke test:
```bash
curl -sm5 https://<APP_DOMAIN>/health
```

Replace `<APP_DOMAIN>` with the value from `.agents-local.md`.
Expect `200` with `postgres` and `redis` status ok. If not, check `docker compose logs <service> --tail 50` on the VPS.
