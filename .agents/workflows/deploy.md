---
description: deploy changes — local commit → push to GitHub main → VPS pull and rebuild
---

// turbo-all

## Deploy sequence (non-negotiable)

Steps MUST run in this exact order. Never skip, reorder, or SSH to edit files directly.

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
ssh -o StrictHostKeyChecking=no root@204.168.158.74 "cd /opt/plexo && git pull origin main && docker compose -f docker/compose.yml build <service> && docker compose -f docker/compose.yml up -d <service>"
```

Replace `<service>` with the affected container(s): `web`, `api`, or both (run the command twice, or chain with `&&`).

4. Smoke test:
```bash
curl -sm5 https://plexo.metajibe.com/api/v1/health
```

Expect `200` with `postgres` and `redis` status ok. If not, check `docker compose logs <service> --tail 50` on the VPS.
