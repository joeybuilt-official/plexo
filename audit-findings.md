# Plexo `apps/web` — UI/UX/Functionality Audit Findings

Audited 2026-06-09 against live prod (https://app.getplexo.com, authed as Dustin) + source at `/workspace/plexo` `main`. Vehicle/method: ADR `/workspace/plexo/.ui-audit/adr/0001`. Evidence source tagged per item: **[live]** confirmed in running app, **[static]** found by source analysis (not yet reproduced live), **[live✗]** static claim corrected by live check.

Severity: **P0** broken/blocked/data-loss/security-adjacent · **P1** works-but-wrong (bad error handling, missing states, a11y blockers) · **P2** inconsistency/confusion/polish users notice · **P3** nice-to-have.

> Responsive lens (lens 6) is INCOMPLETE: the server-side webtop Chrome does not reflow to a true mobile viewport (renders 1536px regardless of window size). Faithful 360/768 testing needs the Playwright mobile-emulation harness. Flagged as a gap — see "Deferred" at end. All other lenses covered.

---

## P0 — broken functionality / dead ends

### [P0] ✅ FIXED — Command palette "Audit" entry navigates to a 404
Screen/route: any screen → ⌘K command palette → "Audit"
Repro: open command palette, select the Audit command. Also: `/app/agents` renders an "audit" link per extension.
Expected: opens an audit view (or the entry is removed).
Actual: navigates to `/app/audit` → **404 "This page could not be found"** (confirmed live). Route was removed in the UX-016 refactor (`sidebar.tsx:115` comment) but two call sites still link it.
File(s): `apps/web/src/components/command-palette.tsx:74`; `apps/web/src/app/app/agents/page.tsx:1104`; stale routing branch `apps/web/src/components/layout/sidebar.tsx:164`.
Fix approach: remove the dead command-palette entry + the agents-page audit link (and the orphaned `sectionForPath` `/app/audit` branch). Smallest change: delete the three references.
Evidence: **[live]** `/app/audit` → 404.

### [P0] ✅ FIXED (interim) — Intelligence dashboard links to a 404 (SCL settings)
> Fixed by pointing the SCL FlowStep to `/app/settings/intelligence` (matches sibling Embeddings/Router FlowSteps). Open Q remains: if a dedicated SCL settings page is wanted, that's separate net-new work.

Screen/route: `/app/intelligence` → "SCL" / domain-reasoning link
Repro: from the intelligence dashboard, follow the link to `/app/settings/intelligence/scl`.
Expected: opens SCL settings.
Actual: **404** (confirmed live). No `scl` subpage exists under `settings/intelligence/` (only embeddings, memory, models, providers, routing, self-hosted).
File(s): `apps/web/src/app/app/intelligence/page.tsx:234`.
Fix approach: either point the link to the correct existing route, or (if SCL settings genuinely don't exist yet) remove/disable the link. **Design decision — confirm intended target before fixing.**
Evidence: **[live]** `/app/settings/intelligence/scl` → 404.

> NOTE — corrected by live check: the static sweep flagged command-palette `/app/sprints` as a 4th dead route. **[live✗]** it actually 301-redirects to `/app/projects` and works. Not a finding.

---

## P1 — works but wrong (error handling / states / a11y)

### [P1] ✅ FIXED — Multiple data screens silently swallow fetch failures (no error state, no retry)
> Fixed: added scoped `PageError` + retry to channels, memory (browse + search), connections (only when registry empty — populated list not blanked), intelligence/logs (scoped to Logs tab), approvals (standing-approvals section). agents/extensions already had a scoped `role="alert"` error block — no change needed. Typecheck exit 0.

Screen/route: channels, memory, memory-search, connections, intelligence/logs, agents/extensions, approvals (standing-approvals sub-fetch)
Repro: cause the underlying fetch to fail (network drop / API 500). The screen renders blank or stale instead of an actionable error + retry.
Expected: error state with message + retry (the app already has `components/ui/page-error.tsx` for this).
Actual: failure is swallowed (only `console.log`/local state), user sees nothing.
File(s): `app/app/channels/page.tsx:50`; `app/app/memory/page.tsx:124` + search `:202`; `app/app/connections/page.tsx:134`; `app/app/intelligence/page.tsx:343` (logs); `app/app/agents/page.tsx:726` (extensions); `app/app/approvals/page.tsx:172`.
Fix approach: add an error branch rendering `<PageError onRetry=…>` where each already tracks an error but doesn't surface it.
Evidence: **[static]**.

### [P1] ✅ FIXED (needs live smoke) — Invite acceptance resolves "current user" by picking the first API user
> Fixed: now resolves the accepting user via `authClient.getSession()` (same pattern as account-client) instead of `/api/v1/users`→`items[0]`. Unauthenticated users get a "sign in first" message. NEEDS a live invite-flow smoke before sign-off (couldn't generate an invite during audit).

Screen/route: `/invite/[token]`
Repro: accept an invite while the user-resolution path falls through.
Expected: bind the invite to the authenticated session user.
Actual: code fetches `/api/v1/users` and takes the **first** id as the accepting user — can bind the workspace seat to the wrong account. Security-adjacent.
File(s): `apps/web/src/app/invite/[token]/page.tsx` (user-lookup fallback).
Fix approach: resolve the accepting user from the session (better-auth) rather than list-first. **Verify live before fixing** (single-user prod may mask it).
Evidence: **[static]** — not reproduced live.

### [P1] ✅ FIXED — Inert `href="#"` links when a blob URL fails to generate
> Fixed: `href={blobUrl ?? undefined}` + `aria-disabled` + `pointer-events-none opacity-40` when no blob (MockupRenderer, HtmlRenderer). A missing blob now renders a visibly-disabled control instead of a dead "#" that scrolls to top.

Screen/route: Work renderers (mockup / HTML output)
Repro: open a Work whose blob URL generation returns null.
Expected: download/open control is disabled or shows an error.
Actual: anchor falls back to `href="#"` — looks clickable, navigates nowhere (scrolls to top).
File(s): `apps/web/src/components/works/renderers/MockupRenderer.tsx:71`; `HtmlRenderer.tsx:39`.
Fix approach: render a disabled state instead of `#` when `blobUrl` is null.
Evidence: **[static]**.

### [P1] ✅ FIXED — a11y blockers — unlabeled / unnamed controls
> Fixed: users invite copy-button `aria-label`; integrations-nudge-modal Eye/EyeOff toggle `aria-label`+`aria-pressed`; behavior-card RuleValueEditor now takes the rule label and aria-labels every native input/select/textarea, and the add-rule form fields (Label/Type/Content/Value/Description) got aria-labels. Typecheck clean.

Screen/route: behavior settings, users settings, integrations modal
Repro: navigate with a screen reader / keyboard.
Expected: every input has an accessible name; icon-only buttons have `aria-label`.
Actual:
- `settings/behavior` RuleValueEditor inputs/select/textarea have no label binding — `behavior-card.tsx:48-70`.
- `settings/users` copy-button is icon-only, no `aria-label` — `settings/users/page.tsx:193`.
- Integrations modal Eye/EyeOff password-reveal toggle is icon-only, no `aria-label` — `integrationsmodal.tsx:110-117`.
Fix approach: add `aria-label`s + `id`/`htmlFor` bindings.
Evidence: **[static]**.

### [P1] ⤓ DOWNGRADED (live review) — Channels empty state CTA doesn't explain the first step
> On reading the actual component, the empty state already has a headline ("No channels yet") + description ("Pair a connector that produces messages to see your threads here.") + the pair CTA. It IS guided. Static finding overstated. No change.

Screen/route: `/app/channels` with zero channels
Expected: guided empty state explaining how to connect a channel.
Actual: jumps straight to "Pair your phone" → `/app/connections/gmessages/pair` with no framing of what channels are or why.
File(s): `app/app/channels/page.tsx:75`.
Fix approach: add an `EmptyState` with copy + the pair CTA as a secondary action.
Evidence: **[static]**.

---

## P2 — inconsistency / confusion / polish

### [P2] ✅ RESOLVED (no change) — "Task" vs "Work" terminology
> Operator clarified the model: a **Work is the output** of a Task/Project; **Task/Project is the unit** that produces Works. So "Send Task" on the composer and the *separate* Tasks vs Works nav items are both CORRECT — they're genuinely different concepts, not an inconsistency. Original flag was a false alarm. No rename. (Operator open to future renaming, but the current model is coherent — not churning it now.)

<details><summary>original finding (kept for record)</summary>

#### "Task" vs "Work" vs "Works" — terminology + two competing nav items
Screen/route: global (sidebar, home composer, projects, chat)
Detail: The product's canonical vocabulary (landing page + sidebar section) is **WORK**, but the UI mixes "task": composer placeholder "Message your agent to start a **task**…", send button "Send **Task**", while aria-labels say "Open **work** detail page" and the empty state says "No **work** yet". Separately, the sidebar exposes **both** "Tasks" (`/app/tasks`) and "Works" (`/app/works`) as distinct nav items with no clear distinction — a real mental-model ambiguity.
File(s): `components/layout/sidebar.tsx:85-86`; `app/_components/quick-send.tsx:347`; `app/chat/_components/message-bubble.tsx:370`; `app/projects/[id]/page.tsx:785`.
Fix approach: pick one user-facing noun (canonical = "Work"/"Task" — operator's call) and apply consistently; clarify or merge the Tasks vs Works nav split. **Naming decision — confirm with operator.**
Evidence: **[live]** composer/sidebar observed; **[static]** call sites.

</details>

### [P2] "Coming soon" stubs shipped to users
Screen/route: subscription, scheduling, embed
Detail: `account/subscription` "Pro coming soon" + "Stripe customer portal (coming soon)"; `scheduling` "More channel types coming soon"; `embed/[type]` "Integrations panel — embedded view coming soon."
File(s): `account/subscription/subscription-client.tsx:151,165`; `scheduling/page.tsx:667`; `embed/[type]/connections-panel.tsx:9`.
Fix approach: gate stub UI behind a flag or replace with a non-promissory empty state. Subscription Stripe is a real integration gap — confirm scope.
Evidence: **[static]**.

### [P2] Off-system color + spacing values (design-token violations)
Detail: hardcoded hex instead of tokens — `#3b82f6` (ChartRenderer + `embed/[type]/error.tsx` + `global-error.tsx`), `#0d0d0d` (code/file/json/share renderers), `#888` (`global-error.tsx`); off-4px-scale spacing — `gap-[3px]` (voice-waveform), `py-[1px]` (KindBadge), `top-[68px]` (update-modal), `left-[30px]` (intelligence/wizard).
Fix approach: map hex → `bg-accent`/`bg-canvas`/`text-text-muted`; snap spacing to scale.
Evidence: **[static]** (sanctioned scale read from `globals.css`).

### [P2] Four separate modal implementations + four error displays (no shared base)
Detail: modals (`confirm-dialog`, `update-modal`, `AnalyticsPreviewModal`, `integrations-nudge-modal`) each re-implement backdrop/focus-trap/Escape with divergent chrome (`rounded-sm` vs `rounded`); error displays (`global-error`, `page-error`, `error-fallback`, `session-error-boundary`) diverge — `global-error.tsx` uses bare inline styles, no tokens.
Fix approach: not a redesign — longer term consolidate. Flag, don't over-fix.
> CAUTION (verified): do NOT convert `global-error.tsx` to Tailwind tokens. It replaces the root layout in Next's error boundary, where the app stylesheet may not be loaded — the inline styles are intentional/defensive. The `#888`/`#3b82f6` there are a deliberate self-contained fallback, not a token violation to "fix".
Evidence: **[static]**.

### [P2] ⤓ MOSTLY FALSE-POSITIVE (verified) — a11y clickable divs / reduced-motion
> **Reduced-motion: already handled.** `globals.css:425` has a global `@media (prefers-reduced-motion: reduce)` block that zeroes animation + transition duration on `*, *::before, *::after`. The static sweep missed it (end of file). No fix needed.
> **Clickable divs: mostly acceptable.** The flagged `onClick` divs (`approvals:474`, `hub/HubClient:1025`, `artifact-panel:550`, `settings/privacy:126`) are `stopPropagation` content-wrappers inside a clickable parent — not interactive controls themselves, so they don't need role/tabindex. Modal backdrops use the standard click-to-close pattern alongside a real accessible close button + Escape; adding `role="presentation"` is optional polish, not a blocker.
> Net: no action taken — would be churn on non-issues. Remaining genuine a11y items were the P1 icon-button labels (already fixed).
Evidence: **[live/source-verified]**.

### [P2] ✅ FIXED (right-sized) — Projects loading subtitle showed a bare "…"
Screen/route: `/app/projects`
> On inspection the "…" is only the transient subtitle count (the main list already shows a proper `Loader2` spinner at `:341`), not a missing loading state. Changed the subtitle to "Loading…" — right-sized fix, no skeleton needed.
File(s): `app/app/projects/page.tsx:307`.
Evidence: **[live]**.

### [P2] Routes reachable only by typing the URL (orphaned)
Detail: `/app/workbench`, `/app/outcomes`, `/app/revisions`, `/app/functions`, `/app/cron` have zero inbound `Link`/`push`. Either intentional (deep-link only) or lost nav entries.
Fix approach: confirm intent; add nav or remove if dead.
Evidence: **[static]**.

---

## P3 — micro-polish

- [P3] Generic "Something went wrong" with no detail/cause on top-level error boundaries — `app/global-error.tsx:28`, `app/app/error.tsx:18`. Add a brief cause + the existing retry. **[static]**
- [P3] Landing page arbitrary font sizes (`text-[56px]`, `text-[28px]`, `text-[11px]`) — hero-specific, low priority. `app/page.tsx`. **[static]**
- [P3] Badge family border-radius divergence (`rounded-md` vs `rounded-sm` across 9 badges) — both spec-valid. **[static]**
- [P3] `auth/handshake` cross-app token-exchange is a TODO stub (deep-link path). **[static]**
- [P3] No optimistic UI on any mutation (tasks/projects/memory) — full server round-trip; acceptable but noticeable latency. Design choice, not a defect — listed for completeness. **[static]**

---

## Deferred / needs follow-up before this audit is fully complete
1. **Responsive lens (lens 6)** — not executed at true mobile widths (webtop Chrome won't reflow). Needs the Playwright 360/768 mobile-emulation harness. Recommend running before sign-off.
2. **Live reproduction** of the P1 [static] items (silent fetch failures, invite first-user fallback, blob `href="#"`) — confirm in-app before fixing roots.
3. **Setup/onboarding circular redirect** (`/setup` ↔ `/app/home`) — flow agent flagged; needs a fresh-account walk to confirm (prod account is already onboarded).

---

## Open decisions for operator (do not self-resolve)
- P0 SCL link: what is the correct target for `/app/settings/intelligence/scl`? (fix target vs remove link)
- P2 terminology: canonical user-facing noun — "Work" or "Task"? And: are Tasks and Works genuinely different concepts, or should the nav be merged?
- P2 subscription Stripe: in-scope to wire, or leave stubbed?
