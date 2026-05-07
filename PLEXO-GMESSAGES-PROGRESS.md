# PLEXO Google Messages connector — progress tracker

**Resume prompt (paste into a fresh Claude Code session at `/home/dustin/dev/plexo`):**

> Resume `PLEXO-GMESSAGES` at `/home/dustin/dev/plexo`. Phase 6 is **deployed to prod on the joeybuilt VPS** (`203.0.113.10`) as of 2026-05-06 22:49 UTC. Sidecar live, HMAC self-check passes against prod api, migrations 0117 applied, no paired sessions yet. **Only the witnessed phone-pair smoke (PHASE-6-OPS §7.3 scenarios 1-5) remains** before the master plan §authorization-gates #6 closes.
>
> **Read in order:** `/home/dustin/dev/plexo/PLEXO-GMESSAGES-PROGRESS.md` (top decisions-log entry = 2026-05-06 prod deploy), `/home/dustin/dev/plexo/PLEXO-GMESSAGES-PHASE-6-OPS.md` (§7.3 phone-pair scenarios), `/home/dustin/dev/plexo/apps/gmessages/RUNBOOK.md`, `/home/dustin/dev/plexo/checklist.md`, `/home/dustin/dev/plexo/plan.md` (Phase L scope).
>
> **Prod state (2026-05-06 22:49 UTC):**
> - `plexo-gmessages` healthy at `0.0.5-phase-6-ops`; libgm `v0.2604.0`; container_name `plexo-gmessages`; defined inline in `/opt/service/platform/infra/docker-compose.yml` (between `plexo-web` and `inference-gateway`).
> - `plexo-api` healthy with `GMESSAGES_SIDECAR_URL=http://plexo-gmessages:3010` env wired.
> - Prod DB at migration 0117; `plexo_gmessages.{paired_sessions,message_dedupe,rcs_feature_cache}` tables present; `connections_registry.gmessages` row seeded; `auth_type` enum has `paired_session`.
> - Sidecar boot sequence verified clean: `http listener up port=3010` → `startup HMAC self-check passed` → `boot restore: rehydrating sessions count=0`.
>
> **Driving the §7.3 phone-pair smoke**: pair flow lives at `https://getplexo.com/app/connections/gmessages/pair`. PHASE-6-OPS §7.3 scenarios 1-5 are pair → send → receive → force-expire/reconnect → restart sidecar/verify boot-restore. Append observations to PROGRESS.md decisions log as scenarios run. After smoke green: master plan §authorization-gates #6 closes.
>
> **Known gaps to track separately (do not block §7.3):**
> - Inngest service not in platform compose. `gmessages-session-refresh` (`*/15`) and `gmessages-stale-session-monitor` (`*/5`) crons won't fire in prod. Active session ops still work; 24h refresh + auto-stale-detection are degraded.
> - PHASE-6-OPS §3 was written for Coolify; actual deploy is platform compose. Doc needs rewrite.
> - The platform compose edit adding `plexo-gmessages` is **not in any git repo** — backup at `docker-compose.yml.bak.before-gmessages-2026-05-06`. Future platform updates may overwrite. Either propose a platform-repo PR or document this in platform's own README.
> - Hub build (apps/hub via Turbopack) was missing from the §10 verification battery — caught a regression at deploy time. Add `pnpm --filter @plexo/hub build` to §10 before next phase.
> - `__drizzle_migrations.created_at` backfilled 2026-05-06 (118 rows from journal `when`; `/migrate.sh` now works for current state). **Caveat for 0118+**: journal `when` is hand-authored with future dates through 2026-05-20; drizzle-kit's auto-generated `when=Date.now()` will be < `MAX(created_at)` until 2026-05-20, so `meta/_journal.json` must be hand-edited for any migration authored before then. See PHASE-6-OPS §3.3.
>
> Auto-deploy daemon's REPO_MAP for `joeybuilt-official/plexo` redeploys plexo-api/saas/hub/embeddings only. After any future plexo push, gmessages sidecar redeploy is a manual `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build plexo-gmessages` from `/opt/service/platform/infra/`.

---

## Phase status

| Phase | Status | Output | Sign-off gate |
|---|---|---|---|
| 0 — Audit | `complete` | `PLEXO-GMESSAGES-PHASE-0-AUDIT.md` | ✅ operator answered audit §4 open questions 2026-05-05 |
| 1 — Design + decision records | `complete` | `PLEXO-GMESSAGES-PHASE-1-DESIGN.md` + ADRs 0002-0006 | ✅ operator pre-authorized Go runtime + Pex modification + Inngest install + namespace-via-panel 2026-05-05 |
| 2 — Pex contract + schema migration | `complete` | `PLEXO-GMESSAGES-PHASE-2-CONTRACT.md` + migration | ✅ operator confirmed 2026-05-05 (api container rebuilt; routes serving) |
| 3 — Go connector skeleton | `complete` | `PLEXO-GMESSAGES-PHASE-3-SKELETON.md` | (no operator gate) — synthetic-boot smoke verified 2026-05-05 |
| 4 — Pairing UI + lifecycle + viewer | `complete (4a + 4b + 4c)` | `PLEXO-GMESSAGES-PHASE-4-PAIRING.md` | (no operator gate) |
| 5 — Message normalization + ingestion | `complete` | `PLEXO-GMESSAGES-PHASE-5-INGEST.md` | (no operator gate) |
| 6 — Operations | `deployed to prod 2026-05-06 22:49 UTC (sidecar live, HMAC self-check passing, migrations 0117 applied); witnessed §7.3 phone-pair smoke deferred` | `apps/gmessages/{README,RUNBOOK}.md` + `PLEXO-GMESSAGES-PHASE-6-OPS.md` | §7.3 scenarios 1-5 + master plan §authorization-gates #6 |
| L — Levio integration | `not_started` | `PLEXO-GMESSAGES-PHASE-L-LEVIO.md` | first Levio deploy with messaging |

## Notes

- Phase 7 (Levio) is renamed **Phase L** to avoid number collision with Levio repo's in-flight Phase 7 deploy gate. See audit conflict §0.7.
- Build prompt's "Phase 7 (Levio)" maps to **Phase L** here.
- The phased-plan skill files (`plan.md`, `checklist.md`, `adr/`) and the build prompt files (`PLEXO-GMESSAGES-PHASE-N-*.md`) are kept in parallel — no deduplication. Per-phase docs hold the build prompt's required deliverables; `plan.md` + `checklist.md` hold the skill's session-bridging state.

## Operator decisions log

**2026-05-07 — autonomous-prep continuation #8: session-start re-verification, zero drift (no operator gate)**

Day-2 re-verification pass at session start. No new artifacts shipped; this entry is the receipt that the prior 13 LOCAL doc/script commits remain accurate against current HEAD `c2675842` (plexo) and current Levio HEAD `b2681d2` (9 commits past the `3fd0004` reference in §11.1). Future autonomous sessions can skip this re-grep + re-audit cycle by trusting this entry through the next code-change push. No prod state changed; no Levio-side code touched.

- **Recurring drift checks: both green.** `scripts/check-gmessages-prod-state.sh` → 5 PASS / 0 WARN: sidecar `Up 8 hours (healthy)` at `0.0.5-phase-6-ops`, boot logs canonical, `MAX(__drizzle_migrations.created_at) = 1779242460000`, 0 NULLs, 0 paired sessions, decode_error_rollup = 0, sidecar mem 4.93 MiB / 256 MiB. `scripts/check-platform-compose-drift.sh` → 3 PASS / 0 WARN: live diff sha256 still matches embedded baseline `911d054c…`, 43 lines, no drift since the 2026-05-06 22:47 UTC inline edit. Both wrappers run cleanly as the documented session-start pattern.
- **§8 seam pickup pointers re-grep'd accurate at tip `c2675842`.** Verified each pointer line-for-line: `handler.go:151` dispatchEvent ✓, `handler.go:186` handleWrappedMessage ✓, `channels.ts:202` `unreadCount: 0` hardcode ✓, `channels.ts:321` + `:387` outbound `pending: true` ✓, `channels-subscription.ts:200` route handler start + `:221` `: keepalive\n\n` write ✓, `agent-loop.ts:1306` reflectAndPromote canonical call site ✓. No Phase 5 carry-forward seam has shifted lines since the §8 pointers were captured.
- **§11.1 Phase L pre-flight Levio paths re-verified at Levio HEAD `b2681d2`.** Levio progressed 9 commits past `3fd0004` since session #6, but the IA hasn't churned: `src/app/app/email/page.tsx` still 17 lines (peer pattern intact), 12 `/api/email/*` route files still match the captured count, `src/components/email/email-full-view.tsx` still the React peer component, `src/lib/plexo/client.ts:49` still `class PlexoClient {` (Bearer-auth surface intact). Q1–Q6 panel-anchor questions and the four blockers in §11.1 remain accurate — no re-write needed.
- **Script cross-references audit: bidirectional and complete.** PHASE-6-OPS references all four wrapper scripts at appropriate doc anchors (§3.3 → `next-migration-when.sh`, §3.5 → `check-platform-compose-drift.sh`, §10 → `verify-phase-6-ship-gate.sh` + `check-gmessages-prod-state.sh`); RUNBOOK Appendix A surfaces the two recurring session-start checks (`check-gmessages-prod-state.sh` + `check-platform-compose-drift.sh`); each script's header references its canonical doc anchor (the prod-state script header points at PROGRESS.md continuations, sufficient for self-discovery).
- **Levio `b2681d2` noted but off-mission.** Levio commit `Tue May 5 07:55:29 2026` made `buildAuth()` Google-provider construction conditional on env presence — supersedes the symptom claim in my `levio-google-oauth-env-mismatch.md` memory ("every POST /api/auth/sign-in/email returns 500"). The memory's fix paths (add `LEVIO_GOOGLE_*` env vars OR register separate Levio OAuth app) remain relevant for actually enabling Google sign-in, but email/password sign-in is no longer blocked. Memory curation is off-mission for the Phase 6 closeout window — flagged here for a future Levio-touching session to update.
- **No new follow-ups uncovered.** This re-verification confirms the autonomous-prep stack is stable for the operator-witnessed §7.3 phone-pair smoke gate; no doc rot, no script bug, no wrapper omission. The two operator-approval-required follow-ups (§3.5 platform-repo persist + §3.6 Inngest service add) and Phase L unchanged.
- 14th LOCAL doc commit awaiting piggyback on the next code-change push. Local stack now 14 deep: be426292 → 95c701f0 → 4867d5c8 → a127e743 → 6d493fd5 → b3af24a2 → c6e17349 → c3199731 → 6f2d2456 → 40ee7278 → b1d4f62e → 2910118a → c2675842 → (this entry).

**2026-05-06 — autonomous-prep continuation #7: platform-compose drift wrapper (no operator gate)**

Continued the autonomous-prep window with one new read-only artifact closing the last unautomated check before the operator-approval-required §3.5 push: drift detection for the inline `plexo-gmessages` edit on `/opt/service/platform/infra/docker-compose.yml`. The §3.5 workflow had a manual "diff must match the verbatim block byte-for-byte; if not, stop and reconcile" step; this wrapper turns that into a one-line pre-flight. Read-only spot-check at session start re-confirmed prod state via `scripts/check-gmessages-prod-state.sh`: 5 PASS / 0 WARN, sidecar Up 8h healthy at `0.0.5-phase-6-ops`, `MAX(__drizzle_migrations.created_at) = 1779242460000`, 0 NULLs, 0 paired sessions, decode_error_rollup = 0, sidecar mem 5.0 MiB / 256 MiB. Platform repo working tree unchanged (`M infra/docker-compose.yml` + untracked `.bak`). No prod state changed; no Levio-side code touched.

- **`scripts/check-platform-compose-drift.sh` shipped.** SSHes to the VPS, runs `git --no-pager diff infra/docker-compose.yml` in `/opt/service/platform`, hashes the output, and compares against the embedded 2026-05-06 baseline (`sha256 = 911d054c136ba01484bb966a8564bae906a4ae07957f4c0710f2322fa035639d`, 43 lines, 27 added / 16 context). PASS on byte-for-byte match → safe to paste §3.5 workflow; FAIL dumps the full live diff to stderr so the operator can reconcile. Empty live diff is treated as a WARN ("§3.5 push may have already landed — retire the baseline"). Output style mirrors `check-gmessages-prod-state.sh` (PASS/WARN/FAIL prefixes; one PASS per check). Refresh-baseline procedure documented inline in the script header for the post-§3.5-push case. End-to-end smoke test against current prod: 3 PASS / 0 WARN / exit 0 — no drift since the 22:47 UTC inline edit.
- **PHASE-6-OPS §3.5 augmented with pre-flight pointer.** Added a one-line bullet at the top of §3.5 referencing the wrapper, plus the diff sha256 inline next to the existing "matches §3.4 snippet byte-for-byte" verification — so a reader can re-run the hash without re-reading the script. The verbatim 32-line diff block stays in §3.5 as the operator-readable canonical reference (the script's hash is the machine-readable counterpart).
- **RUNBOOK Appendix A augmented.** Added `bash scripts/check-platform-compose-drift.sh` as the second drift-related one-liner alongside `check-gmessages-prod-state.sh` so future autonomous sessions have the full pre-flight set discoverable from the single Appendix A index. Both wrappers now sit at the bottom of Appendix A as the recurring session-start commands per the CLAUDE.md §14 wrap-recurring rule.
- **No new follow-ups uncovered.** The wrapper closes the last unautomated check in the §3.5 paste-ready workflow; it doesn't expand scope or unblock anything operator-gated. Both §3.5 (platform-repo persist) and §3.6 (Inngest service add) still require operator approval before action.
- 13th LOCAL doc/script commit awaiting piggyback on the next code-change push. Local stack now 13 deep: be426292 → 95c701f0 → 4867d5c8 → a127e743 → 6d493fd5 → b3af24a2 → c6e17349 → c3199731 → 6f2d2456 → 40ee7278 → b1d4f62e → 2910118a → (this entry).

**2026-05-06 — autonomous-prep continuation #6: ship-gate smoke-test + prod spot-check wrapper (no operator gate)**

Continued the autonomous-prep window with two read-only validation/wrapper artifacts that close the "never been run end-to-end" caveat on `verify-phase-6-ship-gate.sh` and turn the recurring session-start spot-check pattern into a single command. Read-only spot-check at session start re-confirmed prod state: sidecar Up 7h healthy at `0.0.5-phase-6-ops`, boot logs canonical, `MAX(__drizzle_migrations.created_at) = 1779242460000`, 0 NULLs, 0 paired sessions, decode_error_rollup = 0, sidecar mem 4.93 MiB / 256 MiB cap. Platform repo working tree unchanged. No prod state changed; no Levio-side code touched.

- **`scripts/verify-phase-6-ship-gate.sh` end-to-end smoke-tested.** Ran the full battery against the current tip (`b1d4f62e`). Result: 7 PASS / 1 expected WARN (api typecheck — 3 pre-existing errors on `deepgram.ts` + `telegram.ts`, correctly classified by the script's tolerance check). All hard gates green: sidecar Go suite (cryptosvc + pex + session); queue typecheck; web typecheck; hub Turbopack build; saas build; embeddings build; `docker compose build gmessages` → `plexo-gmessages:latest`. **No drift since the 2026-05-06 ship snapshot** — script is now a verified-working pre-flight, not a paper artifact. PHASE-6-OPS §10 updated to reflect the smoke-test result inline.
- **`scripts/check-gmessages-prod-state.sh` shipped.** Read-only prod-state spot-check wrapper that bundles the recurring session-start checks (sidecar status + version vs `0.0.5-phase-6-ops` + boot-log canonical-sequence presence + `__drizzle_migrations` MAX+NULL count + `paired_sessions` count + cross-workspace decode-error rollup + sidecar memory) into one command. Output shape mirrors `verify-phase-6-ship-gate.sh` — PASS/WARN per comparable check + INFO for non-comparable metrics (`paired_sessions` count rises after smoke runs, sidecar mem fluctuates). End-to-end run produced 5 PASS / 0 WARN — fully nominal. Future autonomous sessions invoke this instead of re-deriving the multi-step ssh+psql sequence per the CLAUDE.md §14 "wrap recurring CLI rediscovery" rule. Linked from RUNBOOK Appendix A + PHASE-6-OPS §10 alongside the ship-gate wrapper.
- **No new follow-ups uncovered.** This batch closes the "never been run" caveat on the ship-gate wrapper and reduces the per-session ssh+docker exec footprint; doesn't expand scope.
- 12th LOCAL doc/script commit awaiting piggyback on the next code-change push.

**2026-05-06 — autonomous-prep continuation #5: §3.3 concrete data + §8 seam pickup pointers + next-migration-when.sh (no operator gate)**

Continued the autonomous-prep window past the §11.3 file-layout sketch with two complementary doc/script artifacts that turn abstract guidance into actionable starting points. Read-only spot-check at session start re-confirmed prod state: sidecar Up 6h healthy at `0.0.5-phase-6-ops`, boot logs canonical (`http listener up` → `startup HMAC self-check passed` → `boot restore: rehydrating sessions count=0`), `MAX(__drizzle_migrations.created_at) = 1779242460000`, 0 NULLs, 0 paired sessions, decode_error_rollup = 0, sidecar mem 4.8 MiB / 256 MiB. Platform repo working tree unchanged from 2026-05-06 (`M infra/docker-compose.yml` + untracked `.bak`). No prod state changed; no Levio-side code touched.

- **PHASE-6-OPS §3.3 augmented with concrete data.** Added the latest journal entry datapoint (`idx=117 tag=0117_gmessages_phase2_schema when=1779242460000`), the +60 000 ms spacing convention (matches 0116→0117 gap), and a frozen table of the 5 monotonic `when` inversions (idx 37 / 87 / 88 / 92 / 102 — all 2025-retroactive `when` values while neighbors are 2026; the global MAX still holds at idx 117 so the skip-cursor invariant is intact). Surfaced a paste-ready Python one-liner that re-derives the inversions from the journal so future maintainers don't have to re-author it.
- **`scripts/next-migration-when.sh` shipped.** Tiny pre-flight wrapper that: (a) SSHs to the joeybuilt VPS and queries `MAX(__drizzle_migrations.created_at)`, (b) reads the local journal, (c) prints the recommended `when` for the next migration (= `max(prod, local) + 60_000`) with human-readable timestamps, and (d) WARNs if `Date.now()` falls below the current MAX (= a drizzle-kit-generated migration RIGHT NOW would be silently skipped, until 2026-05-20). End-to-end run against prod: `prod_max=1779242460000`, `recommended_next_when=1779242520000` (2026-05-20 02:02 UTC), WARN correctly fires for today's `now_ms=1778131092000`. PHASE-6-OPS §3.3 now points at this wrapper.
- **PHASE-6-OPS §8 augmented with concrete pickup pointers.** Each of the 7 still-open Phase 5 seams now carries file:line entries for whoever picks it up next. Verified pointers via grep: outbound-correlation `pending: true` is at `apps/api/src/routes/channels.ts:321` + `:387`; SSE keepalive stub is at `apps/api/src/routes/channels-subscription.ts:200` (writes `: keepalive\n\n` at `:221`); unread-count hardcode is at `apps/api/src/routes/channels.ts:202`; reflectAndPromote canonical call site is at `apps/api/src/agent-loop.ts:1306`; sidecar dispatchEvent (read-receipts/typing pickup) is at `apps/gmessages/internal/session/handler.go:151` + `handleWrappedMessage` at `:186`. Phase 6+ enrichment + Phase L Levio consumption work can now skip the discovery pass.
- **No new follow-ups uncovered.** This batch turns existing guidance into actionable starting points; doesn't expand scope.
- 11th LOCAL doc commit awaiting piggyback on the next code-change push. Local stack now 11 deep: be426292 → 95c701f0 → 4867d5c8 → a127e743 → 6d493fd5 → b3af24a2 → c6e17349 → c3199731 → 6f2d2456 → 40ee7278 → (this entry).

**2026-05-06 — autonomous-prep continuation #4: Phase L file-layout sketch (no operator gate)**

Pre-staged the concrete Phase L file map alongside §11.1 so the deep panel debates IA placement (Q2 — peer-to-email vs unified-inbox) against actual paths instead of abstract directory names. Read-only audit of `/home/dustin/dev/joeybuilt/levio` produced the peer pattern: email surface is `src/app/app/email/page.tsx` (17-line server component → `<EmailFullView />`) + 12 `/api/email/*` route files + `src/components/email/email-full-view.tsx` for the React tree. PlexoClient class at `src/lib/plexo/client.ts:49` exposes `dispatch / getToken / getTasks / autoAttachUser / ensureWorkspace / disconnect / oauthPopupUrl` — the existing Bearer-auth surface; `channel-subscription.ts` (Q6) would land alongside it without disturbing the Bearer client.

- **PHASE-6-OPS §11.3 added** — file-layout sketches for peer-to-email outcome AND unified-inbox outcome (Q2 alternatives), AI enrichment surfaces (Q3), optional Levio-side cache schema delta (Q1), notification handler placement (Q4), `@plexo/sdk` install line (Q-blocker #4 alternatives), and ship-gate additions. Explicitly marked DO NOT APPLY — sketch contingent on Q1–Q6 resolution.
- **No new follow-ups uncovered.** Pre-staged the discovery work that any post-panel implementation will need; panel can convene with byte-level concrete state.
- 9th LOCAL doc commit awaiting piggyback on the next code-change push.

**2026-05-06 — autonomous-prep continuation #3: RUNBOOK/README dev↔prod drift fixes (no operator gate)**

Continued the autonomous-prep window with a small but high-leverage doc fix: the RUNBOOK and README still referenced two env-var names the sidecar doesn't actually read (`PLEXO_API_URL`, `GMESSAGES_HTTP_PORT`) and the dev-only container/service aliases. An operator hitting RUNBOOK §4 step 2 during §7.3 smoke would `grep` for `GMESSAGES_HTTP_PORT` and find nothing — the actual var is `PORT` (verified in `cmd/gmessages/main.go:134-137`). No prod state changed; no Levio-side code touched.

- **README.md** — boot sequence step 1 + step 6 fixed: `PLEXO_API_URL` → `PLEXO_BASE_URL`, `GMESSAGES_HTTP_PORT` → `PORT`. Phase status row updated to reflect prod deploy 2026-05-06.
- **RUNBOOK.md** — added a "Production aliases" mapping table at the top of the doc so an operator running §7.3 can translate dev-shaped commands without re-reading PHASE-6-OPS §3. Fixed the env grep + network curl in §4 (Restart loop) to spell the actual var names + show both dev AND prod variants. Replaced the "Coolify dashboard" reference (Coolify is not the prod deploy topology). Appendix A one-liners now show both dev + prod variants for restart, log tail, and the active-session-spread psql query (force-trigger refresh stays dev-only since prod port 3010 is internal-network).
- **No new follow-ups uncovered.** The audit also cross-referenced `verify-phase-6-ship-gate.sh` against `cmd/gmessages/main.go` env-var read sites and the script's pre-existing-error tolerance check (`TOTAL≤3 ∧ PREEX≥1 ∧ TOTAL==PREEX`); script is correct, no fixes needed.
- Will be stacked as the 8th LOCAL doc commit awaiting piggyback on the next code-change push. Local stack now 8 deep: be426292 → 95c701f0 → 4867d5c8 → a127e743 → 6d493fd5 → b3af24a2 → c6e17349 → c3199731 → (this entry).

**2026-05-06 — autonomous-prep continuation #2: ship-gate verification script + Phase L pre-flight (no operator gate)**

Continued the autonomous-prep window past the small §3.5/§3.6 polish into two higher-leverage doc/script artifacts. No prod state changed; no Levio-side code touched.

- **`scripts/verify-phase-6-ship-gate.sh` shipped.** Runnable wrapper for PHASE-6-OPS §10 — runs sidecar `go vet + build + test`, api/queue/web typecheck, hub/saas/embeddings build, and `docker compose build gmessages` in sequence. Output redirected to `/tmp/plexo-ship-gate.*` logs; surfaces only PASS/FAIL/WARN lines. Tolerates the 3 pre-existing api typecheck errors on deepgram.ts + telegram.ts (per CLAUDE.md carry-forward) as a WARN, not a fail. Exits 1 on the first hard fail with a 30-line tail of the failing log. Matches the existing `scripts/test-fresh-db.sh` style. PHASE-6-OPS §10 now points at the wrapper. Future deploys can run `bash scripts/verify-phase-6-ship-gate.sh` instead of pasting the command sequence.
- **PHASE-6-OPS §11.1 — Phase L pre-flight findings.** Read-only audit of `/home/dustin/dev/joeybuilt/levio` + the `packages/sdk/src/channel-client.ts` surface so the Phase L deep panel convenes with concrete state. Captured: SDK `createChannelClient` ships full `list / subscribe / threads / messages / send / events` (`AsyncIterable<ChannelEvent>` with `Last-Event-ID` reconnect); types at `packages/sdk/src/types/{channel,events}.ts`. Levio is a single Next.js 16.2 app (not a monorepo); email surface at `src/app/app/email/` is the peer pattern for `messages/`. Levio's existing `src/lib/plexo/client.ts` uses `Authorization: Bearer` for connections + agent calls — different from the Channel SDK's HMAC body signature scheme; Phase L cleanly adds `src/lib/plexo/channel-subscription.ts` alongside (Q6 in the panel queue). Levio is NOT in `auto-deploy.mjs` REPO_MAP (operator-triggered deploys via `/opt/service/bin/deploy-levio.sh`); no daemon redeploy churn from Phase L Levio-side pushes. Levio Phase 7 closeout: HEAD has progressed past the `3fd0004` reference in `next-session.txt`; operator reconciles current state against `LEVIO-REVAMP-PHASE-7-PLAN.md` before opening Phase L. Six panel anchor questions queued: Q1 local reification (ADR-0005 says no, but offline-first UX may revise), Q2 IA placement (peer to email vs unified inbox), Q3 AI enrichment ordering, Q4 notification dedup ownership, Q5 mute-state scope, Q6 Bearer-vs-HMAC client coexistence. Four concrete blockers listed (Phase 7 closure, §7.3 smoke green, panel decisions, `@plexo/sdk` consumption pattern).
- Stacked as `c6e17349` — 7th LOCAL doc commit awaiting piggyback on the next code-change push. Local stack now 7 deep: be426292 → 95c701f0 → 4867d5c8 → a127e743 → 6d493fd5 → b3af24a2 → c6e17349 (this entry will be `b3af...+1` once committed).

**2026-05-06 — autonomous-prep continuation: §3.5 diff inlined + §3.6 SSH tunnel tightened (no operator gate)**

Small polish pass on the prior autonomous-prep session's paste-ready workflows; no new follow-ups uncovered. Read-only spot-check at session start re-confirmed prod state: sidecar healthy 6h+ at `0.0.5-phase-6-ops`, `MAX(__drizzle_migrations.created_at) = 1779242460000` / 0 NULL, 0 paired sessions. Boot logs unchanged from the 22:49 UTC deploy.

- **§3.5 — inlined verbatim VPS diff** (read-only `git --no-pager diff infra/docker-compose.yml` on `/opt/service/platform`; held stable since the 22:47 UTC inline edit). Replaced the `[...as in §3.4 snippet]` placeholder with the full 32-line diff so §3.5 is self-contained at apply time. Added "stop + reconcile if mismatch" guidance — drift would indicate external edits between 22:47 UTC and the apply window.
- **§3.6 step 4 — SSH tunnel hardened**: `ssh -L ... -N &` (no key, brittle shell job-control backgrounding, no teardown) → `ssh -fN -L ... -i ~/.ssh/joeybuilt_vps` plus explicit `pkill -f` cleanup. Added `gmessages-session-refresh-receiver` to the expected Functions-list check (was missing alongside the two crons).
- Stacked as `6d493fd5` — fifth LOCAL doc commit awaiting piggyback on the next code-change push. Both upstream-blocking follow-ups (§3.5 platform-repo persist + §3.6 Inngest service add) still require operator approval before action; this prep just keeps the future approval fast.

**2026-05-06 — autonomous prep for Phase 6 ops follow-ups (no operator gate)**

Continuation of the post-deploy autonomous track. Picked the two remaining post-deploy follow-ups, did the read-only discovery work that any future operator-approved fix would require, and consolidated paste-ready workflows into `PHASE-6-OPS.md` §3.5 + §3.6. No code or config touched on the VPS or in either repo's main branch; this is doc-only prep.

- **Prod sidecar health spot-check (read-only, ~7h after deploy):** `plexo-gmessages` Up 7h healthy at `0.0.5-phase-6-ops`. Boot logs still showing the canonical sequence (`http listener up` → `startup HMAC self-check passed` → `boot restore: rehydrating sessions count=0`). Zero paired sessions; `decode_error_count` rollup empty (no rows). `MAX(__drizzle_migrations.created_at) = 1779242460000`, NULL count = 0 — backfill intact.
- **§3.5 added — persist `plexo-gmessages` to upstream platform repo.** Discovery: `/opt/service/platform` IS a real git repo (`origin: joeybuilt-official/platform` on `main`); `git status` confirms the inline edit is uncommitted (`M infra/docker-compose.yml` + untracked `.bak`). The current inline edit matches the §3.4 snippet byte-for-byte (verified `grep -A 25 "^  plexo-gmessages:"`). Auto-deploy daemon's REPO_MAP redeploys ONLY `caddy` on platform pushes — so persisting upstream triggers no plexo-side rebuild. §3.5 now ships a paste-ready commit + push workflow including the gitignore for the `.bak` file and the env-var-author commit pattern.
- **§3.6 added — Inngest service for platform compose.** Discovery: platform `.env` has neither `INNGEST_SIGNING_KEY` nor `INNGEST_EVENT_KEY`; platform `.env.example` doesn't document them either. Platform postgres alias is `postgres` (user `postgres`, password `${POSTGRES_PASSWORD:-pushd_secret}` — verified against `plexo-api` env at `infra/docker-compose.yml:121`). §3.6 ships a paste-ready 5-step workflow: generate keys → append to `.env` → add `inngest:` service block (placed in the infrastructure tier alongside postgres+valkey) → wire `INNGEST_BASE_URL` into `plexo-api` env → bring up + verify via SSH-tunneled UI at `127.0.0.1:8288` → persist upstream + document in `.env.example`.
- **Both follow-ups still REQUIRE OPERATOR APPROVAL before action.** §3.5 (commit + push to platform main) and §3.6 (new env vars + new long-lived service) each warrant operator review before any apply. The doc-only prep here just makes the future approval-fast: when the operator returns, the workflow is paste-ready and the read-only discovery is already done.
- **Local doc commit batched** with the §3.3 backfill commit (`be426292`) for piggyback on next code-change push. No daemon redeploy churn from doc-only commits.

**2026-05-06 — `__drizzle_migrations.created_at` backfilled (closes Phase 6 follow-up #2)**

Autonomous follow-up to the prod deploy, picked from the resume-prompt's ranked list as highest-leverage / lowest-risk (idempotent, metadata-only). Backfilled all 118 NULL `drizzle.__drizzle_migrations.created_at` rows on prod from `packages/db/drizzle/meta/_journal.json` `when` values via direct join `__drizzle_migrations.hash = journal.tag`. Pre-flight verified all 118 prod hashes match unique journal tags (no drift, no duplicates).

- **SQL applied**: `UPDATE … FROM (VALUES …) j(tag, when_ms) WHERE m.hash = j.tag AND m.created_at IS NULL` inside a `BEGIN; … COMMIT;` block with pre/post `count(*) FILTER (WHERE created_at IS NULL)` and a monotonicity-inversion check.
- **Result**: 118 rows updated, 0 NULL remain. `MIN(created_at) = 1743350400000` (2025-03-30), `MAX(created_at) = 1779242460000` (2026-05-20 02:01 UTC = tag `0117_gmessages_phase2_schema`).
- **`/migrate.sh` now exits cleanly** for the current 0117 state (every journal entry's `when ≤ MAX(created_at)`, so nothing is reported pending).
- **New caveat surfaced — future-dated journal entries**: the journal's `when` for tags 0112–0117 is hand-authored with May 2026 timestamps up to 2026-05-20. Drizzle-kit's auto-generated `when=Date.now()` for migrations authored before 2026-05-20 will be < `MAX(created_at)` → silently skipped per the original gotcha. Recommended workflow for 0118+: hand-edit `meta/_journal.json` so the new entry's `when` is strictly greater than `1779242460000`. Documented in PHASE-6-OPS §3.3.
- **5 monotonic inversions in journal `when`** observed but not "fixed" (id 319 / 369→370 / 374 / 384 — all hand-authored with retroactive 2025 dates while neighbors are 2026). Left as-is per handoff mandate "use the journal's `when` values to preserve the historical ordering invariant"; they don't affect the MAX skip cursor since the final journal entry still has the global maximum `when`.
- **Not pushed yet**: this entry + checklist tick + §3.3 rewrite are batched for the session-end commit; the backfill itself is a metadata-only DB change requiring no source push.

**2026-05-06 — Phase 6 prod deploy executed (sidecar live, witnessed phone-pair smoke deferred)**

Operator drove commit + push + manual sidecar deploy to the joeybuilt VPS (`203.0.113.10`). All Claude-side gates closed; only the §7.3 witnessed phone-pair smoke (5 scenarios) remains, deferred to operator's convenience.

- **Commit `bb9cd2cc`** — Phases 2-6 gmessages connector (80 files, +10399/-25), authored as Dustin via `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env vars.
- **Hub build regression caught + fixed (commit `9396b6bf`)**: `packages/db/src/gmessages-schema.ts` had `import … from './schema.js'`. Turbopack (apps/hub via Next.js) couldn't resolve `.js`. Fixed by aligning with the rest of `packages/db/src` (extensionless imports). **Hub was missing from §10 verification battery** — add before next phase.
- **Auto-deploy daemon** (`auto-deploy.service` → `/opt/service/auto-deploy.mjs`) redeployed plexo-api/saas/hub/embeddings on the fix-push. Deploy completed 22:33:01 UTC. Daemon's REPO_MAP excludes gmessages by design (per §15).
- **Migrations 0116/0117 NOT auto-applied** — daemon's `up -d <services>` doesn't include `migrate`. `/migrate.sh` then failed: prod `__drizzle_migrations` has all 116 rows with `created_at=NULL`, so `MAX(created_at)=NULL` triggers the memory-noted "Drizzle MAX(created_at) skip cursor gotcha" — drizzle treats every migration as pending and dies on the first re-CREATE. **Recovery**: applied 0116.sql + 0117.sql directly via `psql -f` (idempotent — `ADD VALUE IF NOT EXISTS` / `IF NOT EXISTS` / `ON CONFLICT DO NOTHING`), inserted tracking rows id 398/399 with filename-pattern hashes matching existing rows. Pre-flight DB state was safe before recovery: prod at 0115 with `channel_type` + `task_source` + `auth_type` in expected pre-0116 state, `plexo_gmessages` schema absent.
- **Platform-vs-plexo-source compose drift surfaced**: daemon runs compose from `/opt/service/platform/infra/` (separate `platform` repo, `docker-compose.yml` + `docker-compose.prod.yml`). The plexo source's `docker-compose.yml` is **not** the deploy artifact. Platform compose has `plexo-api/saas/hub/embeddings/web` but lacks `migrate`, `gmessages`, and `inngest` services. **PHASE-6-OPS §3 ("Coolify configuration") is wrong for this VPS** — needs rewrite to match platform-compose reality.
- **Manual platform compose edit** (operator authorized inline edit, no PR): added `plexo-gmessages` service to `/opt/service/platform/infra/docker-compose.yml` between `plexo-web` and `inference-gateway`; added `GMESSAGES_SIDECAR_URL: http://plexo-gmessages:3010` to plexo-api env. Backup: `docker-compose.yml.bak.before-gmessages-2026-05-06`. **Edit is not tracked in any git repo** — future platform updates may overwrite.
- **Sidecar live at 22:49:02 UTC**: `plexo-gmessages` healthy, version `0.0.5-phase-6-ops`. Boot logs surfaced cleanly:
  - `plexo-gmessages booting version=0.0.5-phase-6-ops`
  - `http listener up port=3010`
  - **`startup HMAC self-check passed`** — live api/sidecar HMAC handshake works with prod credentials, validating PHASE-6-OPS §7.3 pre-flight steps 5-6 in production.
  - `boot restore: rehydrating sessions count=0` (no paired sessions yet)
- **Inngest NOT in platform compose** — gmessages crons (`*/15` refresh, `*/5` stale-monitor) won't fire in prod. Active sessions still work; 24h refresh + stale-detection are degraded. Track or add Inngest service to platform compose later.
- **Outstanding**: §7.3 witnessed phone-pair smoke (scenarios 1-5), Inngest deploy, PHASE-6-OPS §3 rewrite, hub build added to §10 verification battery.

**2026-05-06 — Phase 6 dev-stack smoke + §7.3 pre-flight hardening**

After the autonomous hardening pass shipped, ran an end-to-end dev smoke against the live local plexo stack (api + postgres + redis up for 22h; gmessages container was on the old `0.0.1-phase-3-skeleton` build).

- `docker compose build gmessages` → rebuilt to `plexo-gmessages:latest` (Phase 6 image).
- `docker compose up -d --no-deps --no-build gmessages` → recreated container with new image. Boot logs:
  - `plexo-gmessages booting version=0.0.5-phase-6-ops` ✓
  - `http listener up port=3010` ✓
  - `startup HMAC self-check inconclusive` after 21s ⚠
  - `boot restore: fetch list failed err=pex: GET /api/plexo/channels/gmessages/restore-list -> 404` ⚠
- `docker exec plexo-gmessages-1 /gmessages -version` → `0.0.5-phase-6-ops` ✓
- `docker exec plexo-gmessages-1 /gmessages -healthcheck` → exit 0 ✓
- **Real finding**: the local plexo-api container is at the last committed HEAD `f65003eb`, which **predates the gmessages api routes** (all uncommitted in working tree: `apps/api/src/routes/channels-gmessages.ts` untracked, `channels.ts` modified). So api returned 404 for `/restore-list`, the self-check kept retrying, and finally logged "inconclusive" rather than "passed". The sidecar degraded cleanly per design — listener kept serving, /health stayed green — but the dev smoke surfaced an operational gap in the §7.3 staging pre-flight.
- **§7.3 pre-flight hardened** to mandate `docker compose build api gmessages` from the same source tree, plus explicit verification steps: (5) curl restore-list with HMAC, expect 200 + `{"entries":[]}`; (6) grep sidecar logs for "self-check passed". Operator now has a concrete check that catches stale-api-vs-current-sidecar drift before the witnessed phone-pair smoke begins.
- Built image now confirmed runnable + version-correct + self-check-pathway-correct against a real api at the network level. The remaining smoke validation is the live-phone interaction the operator will drive.

**2026-05-06 — Phase 6 autonomous hardening pass (sidecar 0.0.5-phase-6-ops)**

Operator delegated remaining Phase 6 to autonomous execution ("execute the rest without my input; stop at ~45% context"). Convened in-session expert panel (Mira/Yara/Jin/Sona/Reza); resolution: ship three P0 hardening items that maximize odds of the operator-witnessed staging smoke passing cleanly. No conflicts surfaced.

- **Mira P0 — Migration audit**: `0108_channels_twilio.sql` + `0109_channels_gmail.sql` are idempotent (`ADD VALUE IF NOT EXISTS`) and use `--> statement-breakpoint` for the ALTER-TYPE / use-of-new-value transaction split. Both tagged in `_journal.json`. Phase 2's "dev DB drift" was dev-only — fresh staging applies the full chain through 0117 cleanly. **No migration work needed.**
- **Yara P0 — Sidecar startup HMAC self-check**: new `runStartupSelfCheck` in `cmd/gmessages/main.go` runs synchronously after the HTTP listener boots. Hits `/api/plexo/channels/gmessages/restore-list` over HMAC; on persistent HTTP 401 logs `"startup HMAC self-check failed: HTTP 401"` with `fix=PLEXO_SERVICE_KEY...` + `verify=docker compose exec ...` keys, then `os.Exit(1)`. 20s retry budget absorbs "api still booting" (network errors / 5xx are not fatal). Closes RUNBOOK §4 401-storm footgun.
- **Jin P0 — Boot-restore robustness test**: `cryptosvc.TestDecrypt_BootRestoreFailureModes` (8 sub-cases): wrong root key, wrong workspace ID, truncated ciphertext, truncated tag, corrupt IV, empty input, prefix-only, non-base64 garbage. Each case wraps `recover()` and asserts no panic. All 8 pass. Closes RUNBOOK §4 step 4 "panic in runBootRestore" risk.
- Sidecar version constant bumped `0.0.4-phase-5-ingest` → `0.0.5-phase-6-ops` for ops-visibility via `/health`.
- README boot-sequence reordered to reflect actual order (HTTP listener first, then self-check, then boot-restore). RUNBOOK §4 now points at the self-check log line + the panic-safety test name.
- **Verification (post-hardening)**: sidecar `go vet` + `go build` + `go test` all green (cryptosvc 0.004s, pex 0.002s, session 0.014s).

**2026-05-06 — Phase 6 ship-gate verification battery green**

- Re-ran the §10 verification battery post-qrcode-swap to confirm no drift.
- Sidecar: `go vet` clean, `go build` clean, `go test -count=1 ./...` green (`cryptosvc 0.013s`, `pex 0.007s`, `session 0.020s`).
- API typecheck: 3 pre-existing errors (`deepgram.ts` + `telegram.ts` Buffer/BlobPart), zero new — carried forward from Phase 4b per CLAUDE.md.
- Queue + web typecheck: both clean.
- `docker compose build gmessages` succeeded end-to-end → image `plexo-gmessages:latest` produced.
- §6 ship-gate checklist now has two unchecked items both **operator-only**: push target (registry + tag scheme) + deploy target (Coolify project + environment). All Claude-side gates closed.

**2026-05-06 — qrcode.react dep approved + wired (closes authorization-gate #8)**

- Operator approved `qrcode.react` (master plan §authorization-gates #8). `pnpm -F @plexo/web add qrcode.react@^4` — single dep, MIT, ~15kB gzipped, zero peer deps beyond React.
- `apps/web/src/app/app/connections/gmessages/pair/page.tsx` — replaced `QrPlaceholder` with `PairQrCode` rendering `<QRCodeSVG value={url} size={224} level="M" />` on a white tile. Pairing URL still surfaced behind a `<details>` toggle for accessibility / fallback when the user can't scan (e.g. self-host on the same machine).
- Web typecheck clean.
- Cleared the `qrcode.react` line from Phase 4a/4b/4c "carry forward" lists in `checklist.md`. Pair flow now ships the witnessed-smoke-ready experience.

**2026-05-06 — staging smoke witnessed (operator-driven, against staging Plexo)**

- Operator chose to run the first-prod-deploy gate (master plan §authorization-gates #6) against a staging stack first, then promote to prod after a clean pass.
- Smoke procedure scripted in `PLEXO-GMESSAGES-PHASE-6-OPS.md` §7.2 + recorded in this log when complete.
- _**TODO at smoke time:**_ append observations (which steps passed/failed, any deviations, real-paired-session count post-test, decode_error counter readings, sidecar memory after 30 min steady-state).

**2026-05-06 — Phase 6 ops doc + manifest + Coolify env shipped (no operator gate)**

- `PLEXO-GMESSAGES-PHASE-6-OPS.md` — consolidated ops doc per build-prompt deliverable. Slicing panel positions (Mira/Avi/Yara/Sona/Reza), deploy-manifest pointer (the existing `gmessages:` compose service is the manifest — no override needed), Coolify env-surface table, health-probe layer map, RUNBOOK pointer, ship-gate checklist, two open authorization gates (qrcode.react + first-prod-deploy), Phase 5 open-seams carry policy, Phase L self-generating handoff.
- `.env.full.example` — added "Google Messages" section after Discord block documenting `GMESSAGES_SIDECAR_URL` (default `http://gmessages:3010`; only override if splitting sidecar to a separate host) + `GMESSAGES_SYNTHETIC_BOOT` (Phase 3 dev-only smoke flag; must stay `0` in prod). Coolify operators see these surfaced in the env-vars UI.
- `docs/deploy.md` — `GMESSAGES_SIDECAR_URL` listed under "unlock features when set" with pointer to README + RUNBOOK.
- Compose-service audit confirmed prod-shape without override: distroless build, `restart: unless-stopped`, `mem_limit: 256m`, internal-only port 3010, healthcheck via `/gmessages -healthcheck`, `depends_on: api healthy`, HMAC via `PLEXO_SERVICE_KEY`, crypto via `ENCRYPTION_SECRET` reused as `GMESSAGES_MASTER_KEY`.
- **Authorization gates still open**: (a) `qrcode.react` dep (master plan §authorization-gates #8) — should resolve before first prod deploy so the pair flow ships with a real QR; (b) first production deploy (master plan §authorization-gates #6) — operator-witnessed smoke per PHASE-6-OPS §7.2 (pair → send → receive → force-expire → reconnect → restart sidecar → verify boot-restore).

**2026-05-06 — Phase 6 ops kickoff (README + RUNBOOK + viewer auto-refresh)**

- `apps/gmessages/README.md` — sidecar architecture summary + boot sequence + health probes + local dev + wire format + libgm version pin policy + phase status. Operator-facing entrypoint.
- `apps/gmessages/RUNBOOK.md` — four scenarios (session expired/revoked, libgm bump, Google protocol drift, connector restart loop) with detection queries, procedures, escalation, and triage one-liners. Maps directly to master plan §"Phase 6" runbook requirements.
- `apps/web/src/app/app/channels/[channelId]/[threadId]/page.tsx` — viewer message page now polls `GET /api/v1/channels/:id/threads/:threadId/messages` every 5s, paused when tab is backgrounded (uses `document.hidden`). Shows new inbound + flips optimistic-pending bubbles to server-authoritative without reload. Replaced by SSE in Phase 6+ (`/api/plexo/channels/:channelId/events` is still keepalive).
- Web typecheck clean after polling change.
- Pushd manifest + Coolify config + first-prod-deploy gate remain — those are the **operator-gated** parts of Phase 6.

**2026-05-06 — Phase 5 complete (no operator gate)**

- Phase 5 sliced via in-context expert panel (Mira/Avi/Yara/Sona positions in `PHASE-5-INGEST.md` §1). Frozen contracts (inbound envelope, send body, refresh body) made the sidecar + API + Inngest work parallelizable; two general-purpose agents shipped the slice in parallel without contract drift.
- **Sidecar (`apps/gmessages/`)**: `LibgmHandler.dispatchEvent` type-switches `*libgm.WrappedMessage` → normalized `pex.ChannelInbound` POSTs to `/api/plexo/channels/gmessages/inbound`; `*events.GaiaLoggedOut` → `state='revoked'`. New per-session command channel (`Session.Cmds`) preserves ADR-0004 invariant — libgm.Client stays single-goroutine-owned. New HMAC routes `POST /sessions/:id/send` (drives `client.SendMessage`, TmpID = idempotencyKey, ack-correlation via echo `WrappedMessage`) and `POST /sessions/:id/refresh` (drives `client.RefreshPhoneRelay`). Sidecar version → `0.0.4-phase-5-ingest`. All `go vet` + `go build` + `go test` green via `golang:1.25-alpine`.
- **API (`apps/api/`)**: `/api/plexo/channels/gmessages/inbound` is no longer a stub — validate → channel-lookup (404 on non-`gmessages`) → `plexo_gmessages.message_dedupe ON CONFLICT DO NOTHING` → `conversations` row write (`source='gmessages'`, `sessionId='gmessages:'+threadId`, `channelRef.chatId=threadId`, `message=text`, attachments `mimeType→type` mapped) → best-effort `channels.lastMessageAt` bump → 202. Viewer GETs `/api/v1/channels/:id/threads` + `/threads/:threadId/messages` populated (channel-type-agnostic; threads fold most-recent-per-sessionId; messages emit virtual `direction:'outbound'` rows from non-empty `reply`). Outbound `POST /api/v1/channels/:id/threads/:threadId/messages` proxies through new `sidecarSessionSend` HMAC helper; persists optimistic outbound row.
- **Inngest (`packages/queue/`)**: `gmessagesSessionRefreshReceiver` consumes `gmessages.session.refresh-requested` events and HMAC-POSTs the sidecar's refresh route. Registered in `inngestFunctions` array.
- **Contract drift logged in PHASE-5-INGEST.md §7**: envelope `attachments[].mimeType` maps to `conversations.attachments[].type` at the API boundary (legacy schema name); `senderId` arrives on the envelope but isn't persisted (no column); sidecar's send response carries TmpID-as-`messageId` (libgm doesn't surface a server-issued ID synchronously); outbound persistence uses `reply` for outbound text.
- **Verification**: api typecheck zero new errors (only pre-existing deepgram + telegram); queue typecheck clean; web typecheck clean; sidecar Go vet/build/test all green.
- **Open seams for Phase 6 ops** (PHASE-5-INGEST.md §9): attachment fetch/decrypt/re-upload, outbound delivery correlation (TmpID → pending:false), `reflectAndPromote` memory pipeline integration, SSE pub/sub fan-out, auto-refresh/polling on the viewer, read receipts + typing indicators, unread-badge tracking, sender-name persistence. None block Phase 6 ops scoping (Pushd manifest + Coolify + runbooks + README + first-prod-deploy gate).
- **Outstanding authorization gates**: `qrcode.react` dep (master plan §authorization-gates #8) **still pending**; should resolve before first prod deploy in Phase 6 so the pair flow ships with a real QR. No new deps added in Phase 5.

**2026-05-06 — Phase 4c complete (no operator gate)**

- `apps/web/src/app/app/channels/page.tsx` + `[channelId]/page.tsx` + `[channelId]/[threadId]/page.tsx` ship the generic Channel viewer per ADR-0005 §"Generic Channel viewer (Plexo proper)". Channel-type-agnostic: `type` is rendered as a badge so future Signal/WhatsApp connectors render in the same surface.
- `apps/web/src/app/app/channels/_components/phone-offline-banner.tsx` — single shared banner, copy locked verbatim from ADR-0005 §"Copy lock"; offline = `state IN ('expired','revoked','errored')`; Reconnect link → `/app/connections/gmessages/pair`.
- Connections list collapse (resolves Phase 1 cross-conflict C4): per-channel "Open in Plexo viewer" deep-link added inside the `linkedChannels` block of `connection-detail.tsx`. Levio CTA deferred to Phase L.
- Backend (`apps/api/src/routes/channels.ts`): the existing list endpoint now attaches `state` per row from a workspace-scoped paired-session join (latest by `state_changed_at`); new Better Auth-gated endpoints `GET /:id`, `GET /:id/threads`, `GET /:id/threads/:threadId/messages`, `POST /:id/threads/:threadId/messages` (202 echo skeleton; Phase 5 plumbs actual outbound dispatch). Threads + messages endpoints return empty shells per ADR-0005 §"Empty state" until Phase 5 lands ingestion.
- Boundary preserved per ADR-0005 §"Consequences": viewer routes live under `/api/v1/` (Better Auth, host-side) and remain distinct from `/api/plexo/channels/*` (HMAC, sibling-app-facing).
- Web + queue typecheck clean; api typecheck clean for all Phase 4c additions (only the pre-existing deepgram.ts + telegram.ts Buffer/BlobPart errors remain — unrelated to gmessages; carried forward from Phase 4b).
- **Open seams for Phase 5 (carried unchanged from 4b § + extended for the viewer):** sidecar `POST /sessions/:id/refresh` + `POST /sessions/:id/send` HMAC routes; libgm message-event normalization in `LibgmHandler.dispatchEvent`; full state-machine transitions to `refreshing` + `revoked`; ingestion writes to `messages` + dedupe via `plexo_gmessages.message_dedupe`; viewer-side population of `/threads` + `/messages` GETs; attachment fetch/decrypt/re-upload; restart-mid-stream dedupe.
- **Outstanding authorization gates (carry forward):** `qrcode.react` dep (master plan §authorization-gates #8) — the only paint-point dep still outstanding. Phase 4c introduced **zero** new deps, so the consolidated operator ask remains a single dep approval.

**2026-05-05 — Phase 4b complete (no operator gate)**

- `apps/gmessages/internal/session/handler.go` — `LibgmHandler` wraps `libgm.Client`, hydrates AuthData from `sess.AuthBlob`, registers SetEventHandler (counters bumped), posts `state='active'` on Connect, blocks until ctx, Disconnects on exit.
- `internal/cryptosvc/cryptosvc.go` mirrors apps/api/src/crypto.ts AES-256-GCM workspace key derivation. Round-trip test (Node-encode → Go-decode) green.
- `cmd/gmessages/main.go` adds `runBootRestore` — GETs `/api/plexo/channels/gmessages/restore-list`, decrypts each entry locally, `manager.Start`s each. Failures post `state='errored'`.
- `internal/session/Manager.runSession` spawns sibling `liveness.HeartbeatLoop(ctx, pexClient, sess.ID, sess.Counters, 60s)` per running session.
- `packages/queue/src/inngest/functions/gmessages-{session-refresh,stale-session-monitor}.ts` Inngest crons (`*/15 * * * *` + `*/5 * * * *`). Stale monitor flips `state='errored'` after 24h silence and emits `gmessages.session.stale-detected`. Refresh emits `gmessages.session.refresh-requested` (sidecar receiver is Phase 5).
- Inngest serve handler mounted at `/api/inngest`. Plexo's API container discovers + invokes registered functions through this surface.
- Sidecar bumped to `0.0.3-phase-4b-lifecycle`. Build + `go vet` + `go test` clean. Queue + api typecheck clean for gmessages-related code.
- **Pre-existing TS errors surfaced (NOT introduced by 4b):** `apps/api/src/lib/deepgram.ts` + `apps/api/src/routes/telegram.ts` Buffer/BlobPart issues from TS 5.7+ tightening. Verified pre-existing via `git stash` round-trip. Skipped per CLAUDE.md.
- **Open seams for Phase 5:** sidecar refresh receiver endpoint, libgm message-event normalization, full state-machine transitions to `refreshing` + `revoked`.

**2026-05-05 — Phase 4a complete (no operator gate)**

- Phase 4 sliced via expert panel into 4a/4b/4c per operator-approved "spike + vertical slice" default. 4a delivers the pairing flow vertical (consent UI → API → sidecar → libgm pair → encrypted persistence).
- libgm spike findings: real package is `pkg/libgm` (not `libgmessages` per Phase 1 doc); pin `v0.2604.0` requires Go 1.25 (Phase 3's 1.23 bumped in lockstep). No CGo. PairCallback shape validated against upstream pair.go.
- New API route `/api/v1/connections/gmessages/{pair-start,pair-status}` Better Auth-gated; new sidecar HTTP routes `/pair/{start,status,discard}` HMAC-gated.
- Schema writes per ADR-0003: `installed_connections` + `channels` + `plexo_gmessages.paired_sessions` rows in one transaction.
- **Open one-way door:** `qrcode.react` npm dep awaiting operator OK (master plan §authorization-gates #8). UI ships with URL placeholder until approved.
- Typecheck (api + web), `go vet` + `go build` + `go test` all clean.
- **Untested in 4a (deliberate):** live phone-scan, session restoration, heartbeat post-pair, Inngest crons. All belong to 4b.

**2026-05-05 — Phase 0 → Phase 1 sign-off**

- Q1 Inngest in Plexo: ✅ approved contingent on (a) perf justification, (b) silent UX, (c) install as part of setup. Resolved in ADR-0006 — all three honored.
- Q2 Schema namespace: delegated to expert panel. Panel decided `pgSchema('plexo_gmessages')` per ADR-0003.
- Q3 Pex protocol scope: ✅ "modify the model as needed per best practices." Panel chose to keep Pex at 0.4.0 (host-side REST + SSE, not protocol amendment) per ADR-0002. Operator authorization retained for future Phase 5+ if needed.
- Q4 Long-running paired session pattern: ✅ approved.
- Q5 Levio Phase 7 collision: ✅ Phase L rename approved.
- Q6–Q15 (Go runtime, sidecar deploy shape, telemetry shim, viewer scope, pairing UI placement, libgmessages pin, drift copy, AGPL, scope confirmations): operator delegated to "proceed as needed" + "execute as needed." Panel and ADRs cover all.

**2026-05-05 — Phase 3 complete (no operator gate)**

- `apps/gmessages/` scaffolded with cmd / internal / testdata / docker layout.
- Pex types hand-mirrored from `@plexo/sdk` into `internal/pex/types.go`; CI compat test passing against canonical TS fixture.
- Per-session goroutine pool with HKDF derivation + panic isolation + key zeroing (ADR-0004 invariants 1-3); unit-tested.
- Compile-time-redacted log types (`Secret`, `SessionBlob`) in `internal/log`.
- HTTP server with `/health` + binary `-healthcheck` self-probe for distroless container.
- Multi-stage Dockerfile (`golang:1.23-alpine` → `distroless/static`); compose service `gmessages` wired with healthcheck.
- libgmessages link deferred to Phase 4 — `internal/session/Handler` interface in place; current `fakeHandler` blocks on context.
- HKDF inlined (RFC 5869) instead of `golang.org/x/crypto/hkdf` to avoid the dep until libgmessages brings it transitively.
- Synthetic-boot smoke test confirmed end-to-end: gmessages → api HMAC auth pass → JSON parse → route mount → validation reached (`400 missing fields` on empty stub payload, expected).
- API container rebuilt to ship Phase 2 routes (was stale from 2026-05-03).

**2026-05-05 — Phase 2 build complete, awaiting close-out gate**

- Migration `0116_gmessages_phase2.sql` (enum extensions) + `0117_gmessages_phase2_schema.sql` (schema + tables + registry seed) applied to dev DB.
- Split into two files because Postgres rejects `ALTER TYPE ADD VALUE` followed by use-of-new-value in the same transaction (drizzle wraps all unapplied migrations in one txn).
- Verification queries (PHASE-2-CONTRACT §6) confirm: `plexo_gmessages` schema present, three tables present, three enum extensions present, `connections_registry.gmessages` row inserted.
- Inngest installed silently per ADR-0006 (compose service bound to 127.0.0.1:8288, install.sh seeds keys, `.env.example` documented).
- All four impacted workspaces typecheck clean (@plexo/sdk, @plexo/queue, @plexo/db, @plexo/api).
- **Pre-existing dev DB drift surfaced (not Phase 2 scope):** `channel_type` and `task_source` are missing `twilio` + `gmail` values; migrations `0108`/`0109` were never applied to this dev instance. Flagged for operator review before Phase 6.

**2026-05-05 — Phase 1 → Phase 2 sign-off (one-way-door gate)**

Approvals carried forward to Phase 2 execution:

- Go runtime in Plexo stack — ✅ per "Proceed as needed" + ADR-0001.
- Pex protocol unchanged at 0.4.0; subscription contract is host-side endpoints — ✅ per ADR-0002.
- Token encryption: reuse `crypto-util.ts` AES-256-GCM, workspace-scoped — ✅ per ADR-0003.
- Schema namespace: `pgSchema('plexo_gmessages')` — ✅ per ADR-0003.
- Inngest install: silent + setup-installable — ✅ per ADR-0006.
- Sidecar tenancy: single-process multi-tenant with Yara's three invariants — ✅ per ADR-0004.
- Plexo generic Channel viewer: ships in Phase 4, scope locked — ✅ per ADR-0005.

