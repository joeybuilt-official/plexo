# Runner jail — operator runbook (ADR 0050 / plan §9-D2)

Confinement for the agent runner (`worker_threads` + `spawnSync('sh')`) so a
phone → drive → shell request can NEVER become RCE on the NAS fleet host.

## Controls

| Control | Where | Enforces |
|---|---|---|
| `USER 10001` / `user: "10001:10001"` | Dockerfile + compose | non-root, fixed high uid |
| `cap_drop: [ALL]` | compose | zero Linux capabilities |
| `no-new-privileges:true` | compose | no setuid privilege escalation |
| `seccomp=runner/seccomp-runner.json` | compose | default-deny syscalls (ptrace/mount/unshare/bpf/… denied) |
| `read_only: true` | compose | immutable rootfs |
| `tmpfs /tmp` (noexec,nosuid) `/work` (nosuid) | compose | only ephemeral, per-container writable surfaces |
| `pids_limit: 512` | compose | fork-bomb ceiling |
| `mem_limit 2g` / `cpus 2.0` | compose | resource quota |
| `networks.runner-jail internal:true` | compose | egress default-DENY |
| `RUNNER_WALLCLOCK_MS` + `timeout` | entrypoint.sh | hard wall-clock kill |
| root refusal | entrypoint.sh | fails closed if uid 0 |

## Egress

`runner-jail` is `internal: true` → NO outbound. The ONLY sanctioned egress is a
future allowlisted forward-proxy (`runner-egress-proxy`) dual-homed on
`runner-jail` + an egress net. Not built yet — until it exists the runner has no
network egress.

## Validate after deploy (on the host)

```
docker compose -f compose.yml -f runner/compose.runner.yml up -d runner
docker exec <runner-container> /path/to/validate-jail.sh
```

Expect `ALL CHECKS PASSED` (uid≠0, `/` read-only, `/work` writable, egress
blocked, `unshare` denied).

## HARD RULE

**phone → drive → shell stays DISABLED until this jail is applied AND
`validate-jail.sh` passes on the host.** Applying the jail on the host and arming the
drive→shell path are SEPARATE operator steps — neither happens automatically.
