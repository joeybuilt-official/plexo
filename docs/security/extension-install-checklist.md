# Extension Install Checklist

Companion to: `docs/security/extension-security-model.md`
Scope: what the user sees and does at install time (Layer 1)
Audience: UI implementers (Phase 7), extension authors writing install copy

---

## 1. Purpose

This is the concrete UX contract for the **Install Review** modal shown whenever a user installs a PEX extension. The goal is to give a literate but not expert user enough information to decide: *should I trust this thing?*

Non-goal: every word of copy below is final. Tone and wording are subject to design review; fields, order, and gating rules are not.

---

## 2. Entry Points

Three places trigger the install flow:

1. **Hub web UI** — user clicks *Install* on `hub.getplexo.com/skills/@scope/name`. Redirects to `app.getplexo.com/app/extensions/install?ref=@scope/name` (per `project_hub_install_flow` memory note). The app fetches the manifest from the registry, runs server-side validation, and opens the modal.
2. **In-app marketplace** — `/app/marketplace` Install button, same flow without the redirect.
3. **CLI** — `plexo ext install @scope/name`. The CLI hits `POST /api/v1/extensions/preview` which returns the same `manifestPreview` object the modal shows, prints it to the terminal, and waits for `[y/N]`.

Sideloaded (`POST` with a manifest body) has its own path — see §7 below.

---

## 3. The `manifestPreview` API

`POST /api/v1/extensions/preview`

Request body: `{ workspaceId, manifest }` (or `{ workspaceId, hubRef: '@scope/name' }` to fetch from registry).

Response: `ManifestPreview`

```ts
interface ManifestPreview {
  // Identity
  name: string
  displayName: string
  version: string
  author: string
  license: string
  description: string
  icon: string | null
  homepage: string | null
  repository: string | null

  // Trust
  trustTier: 'owner' | 'verified' | 'community' | 'local'
  trustTierVerified: boolean        // true if signature checks passed
  signedBy: string | null            // publisher identity from signature, null if unsigned
  didPresent: boolean
  auditReviewed: boolean             // registry says reviewers have looked at it
  hubUrl: string | null
  installCount: number | null        // from registry
  firstPublishedAt: string | null    // ISO 8601

  // Capabilities (human-readable)
  capabilities: CapabilitySummary[]
  capabilityTokens: string[]         // raw tokens for debug view

  // Data
  sendsDataExternally: boolean
  externalDestinations: Array<{ host: string; purpose: string; dataTypes: string[] }>

  // Oversight
  declaredIrreversibleActions: string[]
  requestsStandingApprovals: boolean

  // Model & context
  minimumContextWindow: number | null
  localModelAcceptable: boolean | null
  preferredProviders: string[] | null

  // Runtime
  dryRunResult: {
    registeredTools: Array<{ name: string; description: string }>
    registeredSchedules: Array<{ name: string; schedule: string }>
    registeredWidgets: Array<{ name: string; displayName: string }>
    registeredPrompts: number
    registeredContexts: number
    activationError: string | null
  }

  // Policy check
  policyResult: {
    ok: boolean
    violations: Array<{
      code: 'TRUST_TIER_BLOCKED' | 'CAPABILITY_BLOCKED' | 'EGRESS_BLOCKED' | 'REQUIRES_ADMIN_APPROVAL'
      message: string
      field: string
    }>
  }

  // Warnings from validateManifest()
  warnings: Array<{ field: string; message: string }>
}

interface CapabilitySummary {
  token: string
  group: 'memory' | 'channel' | 'tasks' | 'connections' | 'storage'
       | 'events' | 'ui' | 'audit' | 'model' | 'entity' | 'self' | 'host'
  severity: 'red' | 'amber' | 'green'
  label: string         // human-readable, e.g. "Send messages on channels you've connected"
  rationale: string | null  // from manifest.capabilities_rationale[token] if present
}
```

---

## 4. The Install Review Modal

The modal has five sections rendered top-to-bottom, plus a footer. User scrolls past every section before the Install button can be clicked.

### 4.1 Header

```
┌──────────────────────────────────────────────────────────────────┐
│  [icon]  Slack Channel Bridge                       [X] Cancel   │
│          @acme/slack-channel  v2.1.0                             │
│          by Acme Inc.   MIT                                      │
│          [✓ Verified Publisher]  [signed by @acme]               │
└──────────────────────────────────────────────────────────────────┘
```

- **Trust badge** (coloured): `Verified Publisher` (green), `Community` (yellow), `Plexo Official` (blue), `Sideloaded` (grey).
- **Signature status**: `signed by {name}` / `unsigned` / `signature invalid — downgraded to Community`.
- **Install count + first published**: small text under the author line: *"Installed 1,204 times · First published 8 months ago"*. Omitted for `local`.

### 4.2 Section 1 — About

```
A bridge between Plexo channels and Slack workspaces. Lets you
mirror messages in both directions and respond to Slack DMs from
the Plexo chat.
```

Just `manifest.description`. Plus:

- Link to `manifest.homepage` if set.
- Link to `manifest.repository` if set.
- Link to Hub page (registry only).
- If `auditReviewed: true`: *"Reviewed by Plexo on {date}"* (registry-provided).

### 4.3 Section 2 — What it will do

Grouped list of capabilities with coloured dots.

```
What @acme/slack-channel will be able to do:

○ Private storage (it won't share this with other extensions)

● Send messages to channels you've connected
  Why: so that mirrored Plexo messages appear in your Slack.

● Act on your behalf on Slack
  Why: this is how the Slack API calls are authenticated.

● Read task records
  Why: so it can attach relevant tasks when you ask in Slack.
```

- Green dot ○: low-risk capabilities (storage, events, ui).
- Amber dot ●: sensitive but expected for the declared type (connections, channel, memory:read:<entity>, tasks).
- Red dot ●: high-risk capabilities (memory:read:*, memory:delete, audit:read, model:override). Red dots get a **per-capability checkbox** (§4.7).

Under the list: *"Will register: 3 tools, 1 scheduled job, 1 widget"* (from `dryRunResult`).

If `dryRunResult.activationError` is non-null: red banner *"This extension failed to activate during preview: {error}. It cannot be installed."* Install button is disabled.

### 4.4 Section 3 — Where data goes

```
This extension sends data outside your Plexo workspace:

  → slack.com           — delivering messages to Slack
                          sends: thread, note

  → hooks.slack.com     — receiving webhooks
                          sends: (none outbound)
```

If `sendsDataExternally: false` and no destinations declared: green note *"Stays inside your workspace."*

If `sendsDataExternally: true` and `externalDestinations` is empty: yellow banner *"The author says this extension sends data externally but did not declare where. The extension will be blocked from making external calls at Full compliance."* Install still possible.

If any destination is not in `workspace.settings.extensionPolicy.allowedEgressDomains` (and policy is non-null): red banner *"{host} is not on your workspace's allowed egress list. Add it to policy or choose a different extension."* Install disabled.

### 4.5 Section 4 — Human oversight

```
This extension will ask you to approve:

  • send_slack_message            — every external message
  • delete_channel_history        — every call
  • Any use of its Slack credentials (first time only)
```

Populated from `declaredIrreversibleActions` plus the host's global irreversibility list. If `requestsStandingApprovals: true`, show *"This extension may ask to remember your approvals for future calls."*

### 4.6 Section 5 — Model & context

Only shown if any `modelRequirements` field is set.

```
Model requirements:
  • Needs a model with at least 200,000-token context
  • Cannot run on a local model
  • Prefers: Anthropic, OpenAI
```

If the workspace's default model doesn't satisfy `minimumContextWindow`: yellow banner *"Your workspace default ({model name, {context} tokens) doesn't meet this extension's requirement. The extension will try to use a connected model that does."*

### 4.7 Footer — consent and action

```
┌──────────────────────────────────────────────────────────────────┐
│  [ ] I understand that @acme/slack-channel will send messages    │
│      to Slack and access my Slack credentials, and I take        │
│      responsibility for installing it.                           │
│                                                                  │
│                              [Cancel]  [Install (disabled)]     │
└──────────────────────────────────────────────────────────────────┘
```

The checkbox is **required** when any of these is true (per security spec §3.4):

- `trustTier === 'community' || 'local'`
- Any capability has `severity === 'red'`
- `sendsDataExternally === true`
- Any `connections:*` capability
- `trustTier === 'community'` AND an external destination is outside `allowedEgressDomains`

Otherwise (verified/owner extension with only green capabilities): no checkbox, just *"By installing, you agree to let this extension run in your workspace."*

Label template: *"I understand that {displayName} will {top 3 amber/red capability labels joined by comma-and}, and I take responsibility for installing it."*

### 4.8 After clicking Install

1. `POST /api/v1/extensions` with `{workspaceId, manifest, settings: {}}`.
2. Row inserted with `enabled = false`.
3. Modal closes. Toast: *"{displayName} installed. Enable it when you're ready."*
4. User lands on `/app/agents → Extensions tab` (Phase 3/4). The new extension is listed with a prominent *Enable* button.
5. Clicking Enable fires the second confirmation: *"Enable {displayName}? It will start running in this workspace and may perform the actions you reviewed."* Two buttons: *Cancel*, *Yes, enable*.
6. On enable, `PATCH /api/v1/extensions/:id {enabled: true, workspaceId}`. Worker activates. Audit log row `extension_activate`.

---

## 5. Read This Before Installing — Warnings

The modal shows **yellow banners** above section 1 for each of these conditions:

| Condition | Banner |
|-----------|--------|
| `trustTier === 'community'` | *"This extension hasn't been reviewed by Plexo. Verify it does what it claims before installing."* |
| `trustTier === 'local'` | *"You uploaded this extension directly. Plexo has not checked it. You are the author."* |
| `signedBy == null` (unsigned) | *"This package is unsigned. We can't verify it came from the author listed above."* |
| `installCount < 10` | *"This extension has been installed by fewer than 10 workspaces. It's new or not widely used."* |
| `firstPublishedAt < 30 days ago` | *"This extension was first published less than 30 days ago."* |
| `capabilities` includes `memory:read:*` | *"This extension can read every memory entry in your workspace — including things you've told other agents in confidence."* |
| `capabilities` includes `audit:read` | *"This extension can read your workspace's audit log, including what other extensions did."* |
| `sendsDataExternally && trustTier !== 'verified'` | *"This extension sends data outside Plexo and hasn't been verified. Make sure you're okay with the destinations listed below."* |

Banners are dismissible per-session (clicking X hides them until next install flow) but cannot be permanently disabled.

---

## 6. Approval Flow When `requireAdminApprovalForInstall` Is Set

If `workspace.settings.extensionPolicy.requireAdminApprovalForInstall === true` and the user's role is not `owner` or `admin`:

1. The modal shows the same review UI.
2. The final button changes from *Install* to *Request install*.
3. On click: row inserted into a new `pending_extension_installs` table (not part of this spec — added in Phase 7 migration), with the manifest preview snapshot.
4. A notification is sent to all workspace admins: *"{member} is requesting to install {displayName}. Review and approve."*
5. Admin clicks the notification → same review modal, but with *Approve install* / *Reject* buttons and a text area for a note.
6. On approve: manifest is re-validated, row moved to `extensions` table, notification to requester.
7. On reject: row deleted with the admin's note, notification to requester.

This table does not exist yet. Phase 7 creates it.

---

## 7. Sideloaded Installs

Sideload path: `POST /api/v1/extensions/sideload { workspaceId, manifest, settings, consent: true }`.
Separate route from the registry-install endpoint so guard logic is not
tangled with normal installs. See §Q3 of
`docs/security/extension-security-model.md` for the full rationale.

**Environment flag:** `ALLOW_SIDELOAD` (default `false`). SaaS Plexo at
`getplexo.com` ships with the flag OFF — sideload attempts return 403
`SIDELOAD_DISABLED`. Self-hosted operators opt in by setting
`ALLOW_SIDELOAD=true` in their `.env`.

**Handling:**

1. The install dialog is forced. No CLI silent install.
2. Caller must be the workspace **owner** (`req.workspaceRole === 'owner'`).
   Admins and members are refused with 403 `OWNER_ONLY`.
3. `consent: true` must be present in the request body. The UI shows the
   big red banner *"This extension hasn't been reviewed by Plexo. Only
   install if you trust the source."* with a checkbox the user must tick.
4. `manifest.trust` is stripped from the request body before validation.
   The original claim is preserved under `manifest.__plexoSideload.originallyDeclaredTrust`
   for audit.
5. Validator runs with `source: 'sideload'`. Rejects `memory:read:*`,
   `memory:write:*`, `audit:read`, `model:override` — the owner-only
   capability ceiling.
6. If `dataResidency.sendsDataExternally === true`, `externalDestinations`
   must list every host explicitly. Wildcards (`*.example.com`) and empty
   lists are rejected with `EGRESS_WILDCARD` / `EGRESS_UNDECLARED`.
7. Stored row carries `source='sideloaded'` and
   `manifest.__plexoSideload.autoUpdate: false`. The update-checker skips
   sideloaded rows. `pinnedVersion` equals the version the owner installed.
8. Audit log metadata for every action on this extension includes
   `source: 'sideload'`. The existing one-click disable toggle works
   unchanged.
9. If `workspace.settings.extensionPolicy.allowedTrustTiers` does not
   include `'local'`, the install is rejected with 400 `POLICY_VIOLATION`.

CLI equivalent: `plexo ext install ./my-extension/plexo.json`. Prints the
same preview, requires `--yes` or interactive confirmation, prints
*"[sideloaded — local trust tier]"* above the Install prompt. The CLI
sends the manifest to `/api/v1/extensions/sideload` with `consent: true`
once the user confirms.

---

## 8. Accessibility Notes

- The modal is trap-focused until dismissed.
- Every banner has an appropriate ARIA role.
- The consent checkbox is a real `<input type="checkbox">` with a programmatically-associated label, not a div-with-click-handler.
- Colour is never the *only* carrier of meaning: red dots are paired with a filled disc glyph; amber with a half-filled disc; green with an outline disc. Screen readers announce "high risk" / "sensitive" / "low risk".

---

## 9. Test Plan (for Phase 7 implementation)

1. Install a community extension with zero external destinations → no consent checkbox.
2. Install a community extension declaring `channel:send` → consent checkbox required; copy matches.
3. Install an extension whose dry-run `activate()` throws → Install button disabled, error shown.
4. Install an extension whose declared `externalDestinations` includes a host outside the workspace's allow list → Install button disabled, banner shown.
5. Install an extension with `trust: 'verified'` but signature verification fails → trust downgrades to `community`, yellow banner shown.
6. Install an extension with `trust: 'owner'` but signature check fails → install rejected outright with `SIGNATURE_INVALID`.
7. As a non-admin member in a workspace with `requireAdminApprovalForInstall: true` → dialog shows *Request install*, creates a pending row, admin can review and approve.
8. CLI install of a community extension with `--yes` → preview printed, install proceeds; without `--yes` → prompts interactively.
9. Sideloaded install with `manifest.trust: 'verified'` → coerced to `local`, sideload banner shown.
10. Install with `memory:read:*` capability → red dot, per-capability warning banner, checkbox required.
