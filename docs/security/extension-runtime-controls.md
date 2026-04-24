# Extension Runtime Controls

Companion to: `docs/security/extension-security-model.md`
Scope: what a user can do to an extension AFTER install — revoke, inspect, disable, uninstall
Audience: UI implementers (Phase 4, 7, 8), support docs

---

## 1. Where runtime controls live

The authoritative surface is `/app/agents → Extensions` (the Tools tab today; renamed post Phase 3). Each installed extension is a row in the left list. Selecting it opens a five-tab right pane:

1. **Overview** — identity, enable toggle, last activity
2. **Capabilities** — grant/revoke, rationale
3. **Data & egress** — destinations, egress sparkline, deny list
4. **Audit** — filtered extension audit log
5. **Settings** — extension-specific config (rendered from `skillConfig`/`toolConfig`/`channelConfig`)

Phase 4 ships Overview + Audit as read-only. Phase 7 adds Capabilities + Data & egress. Phase 8 adds escalation controls inside Overview.

---

## 2. Overview Tab

```
┌──────────────────────────────────────────────────────────────────┐
│  [icon]  Slack Channel Bridge                                    │
│          @acme/slack-channel  v2.1.0    [✓ Verified Publisher]   │
│                                                                  │
│  Status   [● Enabled]  ⟳ Last activated 2h ago                   │
│           Last tool call: send_message (42 ms, success)          │
│           3 calls in the last hour · 47 in the last 24h          │
│                                                                  │
│  [Disable]  [Update available: v2.1.1]  [Uninstall]              │
└──────────────────────────────────────────────────────────────────┘
```

### 2.1 Enable / disable toggle

- Flip off → `PATCH /api/v1/extensions/:id { enabled: false, workspaceId }`.
- The existing route already calls `terminateWorker(existing.name)` on disable (`apps/api/src/routes/extensions.ts:502`). Worker exits, in-flight calls fail cleanly.
- UX: on disable, show a toast *"Disabled. The worker was terminated. Re-enable to restart."* Any scheduled jobs registered by the extension are paused.
- Flip on → same route with `enabled: true`. New worker activates fresh; `activate(sdk)` runs again.

### 2.2 Status line

Computed live from:
- `_workers.get(name)` from `persistent-pool.workerStats()` — is the worker actually running?
- Latest `extension_audit_log` row for this `extensionId` — last action and outcome.
- `SELECT count(*) ... WHERE created_at > now() - interval '1 hour'` — hourly count.
- `interval '24 hours'` — daily count.

### 2.3 Update notice

If the Hub registry has a newer version for the same `manifest.name`:
- Pill shows *"Update available: v{new}"*
- Click opens the **Update Review** modal — same UI as install review, but with a diff section *"Capabilities changed:"* / *"Destinations changed:"* / *"Escalation changed:"*. If any capability, egress destination, or irreversible action was added (not removed), the consent checkbox is required again. Pure removals or same-or-narrower updates are one-click.
- Applying the update overwrites the row's `manifest` and bumps `version`. Worker is terminated and re-activated.

### 2.4 Uninstall

- `DELETE /api/v1/extensions/:id?workspaceId=<id>` — already live.
- Confirmation modal: *"Uninstall {displayName}? This removes the extension, terminates its worker, soft-deletes its behavior rules, prompts, and context blocks. Audit history is retained per your workspace retention policy. This cannot be undone."*
- On confirm: row deleted, worker terminated, behavior rules + prompts + contexts soft-deleted (all already implemented in `apps/api/src/routes/extensions.ts DELETE`).
- Audit log rows are **kept** — they're the historical record of what the extension did while installed.

---

## 3. Capabilities Tab (Phase 7)

```
Granted capabilities

  memory:read:task           [granted]  [ Revoke ]
    Read task records. Used by send_message, search_tasks.

  memory:read:thread         [granted]  [ Revoke ]
    Read conversation threads.

  channel:send               [granted]  [ Revoke ]
    Send messages to connected channels. Used by send_message.

  connections:slack          [granted]  [ Revoke ]
    Act on your behalf on Slack. Required for all Slack API calls.

Denied capabilities (not declared by manifest)

  memory:read:person         —          (not requested)
  audit:read                 —          (not requested)
```

### 3.1 Revocation flow

1. User clicks Revoke on a capability.
2. Confirmation modal: *"Revoking `{token}` will stop {displayName} from {capability label}. Tool calls that need this capability will fail. Continue?"*
3. On confirm: `PATCH /api/v1/extensions/:id { workspaceId, grantedCapabilities: [array minus revoked token] }`.
4. Backend writes the new `grantedCapabilities` array (new column, Phase 7 migration), terminates the worker, returns 200.
5. On next tool call, the worker re-activates with the narrower grant. `createActivationSDK` now has a smaller `capSet`. Attempts to call the revoked method throw `CAPABILITY_DENIED`.

### 3.2 Re-granting

Same UI, *Grant* button. Only capabilities that appear in `manifest.capabilities` can be granted — the user cannot grant a capability the manifest didn't declare. The reasoning: manifest is the author's promise; re-granting something the manifest didn't declare would bypass the install-time review.

### 3.3 "Used by" column

Populated by walking the last 90 days of audit rows: *which tools in this extension actually called an SDK method that requires this capability*. Helps the user understand what breaks if they revoke.

### 3.4 Not-declared capabilities

Shown grey, disabled. Clicking them opens a tooltip: *"This extension did not request `{token}`. Grant would require updating to a manifest that declares it."*

---

## 4. Data & Egress Tab (Phase 7)

### 4.1 Declared destinations

Table:

| Host | Purpose | Declared data types |
|------|---------|---------------------|
| slack.com | Delivering messages | thread, note |
| hooks.slack.com | Receiving webhooks | — |

Directly from `manifest.dataResidency.externalDestinations`. Read-only.

### 4.2 Observed egress (last 7 days)

Sparkline chart + breakdown:

```
Last 7 days: 12.3 MB out, 84.1 MB in, 312 requests

  slack.com          212 req   10.1 MB out   75.3 MB in   avg 180ms
  hooks.slack.com     98 req    2.2 MB out    8.6 MB in   avg  42ms
  api.unknown.tld      2 req    5.1 KB out       0 in     avg 300ms  ⚠ not declared
```

Data source: `extension_audit_log` rows where `action='egress_request'` and `extensionId=<name>`, aggregated by `domain` over the last 7 days.

### 4.3 Undeclared destination warnings

Any row where the `domain` is not in `manifest.dataResidency.externalDestinations` and not in `workspace.settings.extensionPolicy.allowedEgressDomains` (if set) gets a ⚠ icon. Clicking it opens a modal:

*"{extensionId} is making calls to {domain} that it did not declare. This could be:*
- *a legitimate update the author forgot to declare*
- *a dependency calling home*
- *evidence the extension is doing something it shouldn't*

*[Block this domain]  [Add to declared list]  [Dismiss]"*

- **Block**: adds `{domain}` to a new per-extension `blockedEgressDomains` column. Future calls to that domain fail with `EGRESS_BLOCKED` and are logged as `tool_denied`.
- **Add to declared list**: updates the user's view only — does not modify the manifest (we don't mutate author-signed manifests). Future warnings are suppressed.
- **Dismiss**: suppresses the warning for this session.

### 4.4 Block list

A per-extension block list of domains:

```
Blocked domains (user-set)

  api.unknown.tld     blocked 3 days ago   [Unblock]
```

Stored in `extensions.blockedEgressDomains text[]`. Enforcement happens at the Layer 3 `sdk.http.fetch` wrapper.

---

## 5. Audit Tab (Phase 4 initial read-only, Phase 7 extended)

### 5.1 Filters

- Date range (default: last 24 hours)
- Action type (multi-select: `tool_invoke`, `tool_result`, `tool_error`, `tool_timeout`, `egress_request`, `memory_read`, `memory_write`, `escalation_*`, …)
- Outcome (success / failure / denied / timeout / pending)
- Target (text filter on `target` column)
- Session ID

### 5.2 Row display

```
08:47:12  tool_invoke    send_message              success    42ms
08:47:12  egress_request POST slack.com/chat...    200        38ms   1.2KB↑ 312B↓
08:51:03  tool_invoke    list_channels             success    11ms
09:12:44  escalation_request delete_channel        pending    —
09:12:58  escalation_approve delete_channel        success    —      (by Dustin)
09:13:02  tool_invoke    delete_channel            success    87ms
```

### 5.3 Export

*Export CSV* button downloads the filtered view. Fields: all `extension_audit_log` columns (payload hashes only, never payloads).

### 5.4 Retention note

Footer of the tab: *"Audit entries are retained for {auditRetentionDays} days. Adjust retention in `/app/workspace-settings → Security`."*

### 5.5 No detail pane for individual rows

Row click expands to show the raw JSON of the row (minus payload hash clickable for copy). No drill-down to the original payload — we don't store payloads.

---

## 6. Escalation Controls (Phase 8)

Lives inside the Overview tab as a subsection. Summarises the extension's escalation posture and exposes standing approvals the user has granted.

### 6.1 Posture summary

```
Human oversight

  This extension always asks you before:
    • Sending external messages (send_message, send_dm)
    • Deleting channel history (delete_channel)

  Standing approvals you've granted:
    • send_message to @user/ops:*   — expires in 6 days   [Revoke]
    • send_message to @user/dev:*   — no expiration       [Revoke]

  Pending approvals:  0  (see Notifications)
```

### 6.2 Revoking a standing approval

Revoke button → `DELETE /api/v1/standing-approvals/:id`. Row deleted. Next matching action escalates normally.

### 6.3 Setting high-value / confidence thresholds

These live at the workspace level (`workspace.settings.extensionPolicy.escalationPolicy`), not per-extension. Link from this pane to `/app/workspace-settings → Security → Escalation` for editing.

### 6.4 Pending approvals

A count + link to the Notifications drawer. Clicking opens the drawer with the extension's pending requests pre-filtered.

---

## 7. Temporary Disable ("Pause")

Distinct from the main enable/disable toggle in Overview:

- **Disable**: stops the extension indefinitely. Worker terminated, scheduled jobs cancelled.
- **Pause for 1h / 4h / 24h / until I enable**: temporarily stops the extension. Worker terminated, row flagged with `pausedUntil` timestamp. A background job re-enables it automatically.

The pause control lives in an overflow menu on the Overview tab (three-dot button). Pausing is useful when an extension is misbehaving and the user wants to investigate without committing to a full disable.

Data model: `extensions.pausedUntil timestamp null`. The executor's `loadPluginTools` check becomes `enabled = true AND (paused_until IS NULL OR paused_until < now())`. Phase 7 adds the column and the filter.

---

## 8. Emergency kill switch

Per-workspace: `workspace.settings.extensionPolicy.emergencyKillSwitch: boolean`. When true, `loadPluginTools` returns an empty tool set for the workspace, regardless of individual extension enable state. Used when something's on fire and the owner wants to stop all extensions from running without clicking 47 toggles.

UI: a prominent red button on `/app/workspace-settings → Security`: *"Emergency: stop all extensions in this workspace"*. Toggling it on writes the flag; toggling off restores normal behaviour. The toggle is audited as `workspace.emergency_kill_switch.{on|off}`.

---

## 9. Uninstall vs Disable vs Pause — summary

| Action | Row stays? | Worker stops? | Scheduled jobs? | Audit kept? | Settings kept? | Behavior rules? |
|--------|:---------:|:-------------:|:--------------:|:-----------:|:--------------:|:---------------:|
| Pause  | yes       | yes           | yes (paused)   | yes         | yes            | yes             |
| Disable| yes       | yes           | yes (paused)   | yes         | yes            | yes             |
| Uninstall | no     | yes           | deleted        | yes (per retention) | deleted | soft-deleted    |

---

## 10. Settings Tab

Rendered from `manifest.skillConfig` / `toolConfig` / `channelConfig` (these are JSON schemas). The UI builds a form from the schema. Changes are saved via `PATCH /api/v1/extensions/:id { workspaceId, settings: {...} }` — already live.

Security-relevant settings the host surfaces alongside the extension's own:

- **Per-tool timeout override.** Default from `resourceHints.maxInvocationMs`, user can lower.
- **Log verbosity.** `error | warn | info | debug`. Controls what level of activity is written to the audit log for this extension. Default `info`.
- **Enable scheduled jobs.** Off by default even if the manifest declares schedules. User opts in per-extension.

These are host-added fields stored under a reserved `__host` key in the settings JSON so they don't collide with manifest-declared fields.

---

## 11. Implementation Checklist (Phase 7 / Phase 8)

Phase 7:

- [ ] DB migration: `extensions.grantedCapabilities text[] null`, `extensions.blockedEgressDomains text[] null`, `extensions.pausedUntil timestamptz null`, `extension_audit_log` adds `durationMs int`, `bytesSent int`, `bytesReceived int`, `statusCode int`, `domain text`.
- [ ] New route: `POST /api/v1/extensions/preview` returning `ManifestPreview`.
- [ ] Extend `apps/api/src/routes/extensions.ts POST /` with signature check, policy enforcement.
- [ ] `apps/web/src/app/app/agents/extensions/[id]/*` — tab structure.
- [ ] Activation SDK wrapper for egress (`sdk.http.fetch`).
- [ ] Sandbox prelude: strip `process.env`, block `child_process`.
- [ ] Workspace security settings page (`/app/workspace-settings/security`).

Phase 8:

- [ ] Implement the escalation bridge path in `persistent-pool.ts dispatchSdkCall('escalate', ...)`.
- [ ] Pre-check wrapper around `invokeTool` for `irreversibleActions` matching.
- [ ] SSE event `escalation.pending`.
- [ ] Notification drawer UI + standing approvals management.
- [ ] Standing approvals route: `GET/POST/DELETE /api/v1/standing-approvals`.

---

## 12. References

- `docs/security/extension-security-model.md` — canonical spec
- `docs/security/extension-install-checklist.md` — install-time UX (Layer 1)
- `apps/api/src/routes/extensions.ts` — existing install/enable/disable/uninstall routes
- `packages/agent/src/plugins/persistent-pool.ts` — worker lifecycle, `terminateWorker`
- `packages/agent/src/audit.ts` — audit writer
- `packages/db/src/schema.ts` — `extensionAuditLog`, `standingApprovals` tables
