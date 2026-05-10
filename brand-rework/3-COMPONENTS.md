# Phase 3 -- Component Restyle

Completed: 2026-04-25

## Scope

All shared components under `apps/web/src/components/`.
Page-level components (Phase 4) not touched.

## Changes

### 1. globals.css -- token updates

- Radius tokens set to 4px ceiling: `--radius-md: 4px`, `--radius-lg: 4px`, `--radius-xl: 4px`
- `.card-glow:hover` -- shadow removed, now border-color shift only
- `.gradient-text` -- gradient removed, replaced with flat accent color
- `.glow-azure` -- shadow removed (empty rule)
- `.glow-border` / `.glow-border:hover` -- shadows removed, border-color shift only
- `.hero-glow` -- radial gradient removed (empty rule)

### 2. PlexoMark -- Delta Frame symbol

- Replaced three-dot triangle SVG with Delta Frame: open triangle with gap in base, 3 vertex dots
- viewBox changed from `0 0 44 44` to `0 0 48 48` (matches brand/plexo-symbol-mono.svg)
- All hardcoded `var(--color-azure)` and `var(--color-amber)` fills replaced with `currentColor`
- Glow ring element removed
- Animations updated: 4 line segments (left, right, base-l, base-r) + 3 vertex nodes
- Idle/working animation modes preserved with new class names (`df-*`)
- Wordmark: `font-bold` -> `font-medium` (Geist 500, never 700)

### 3. Sidebar (layout/sidebar.tsx)

- All `rounded-xl` -> `rounded` or `rounded-sm`
- All `rounded-lg` -> `rounded`
- Badge pills: `rounded-full` -> `rounded-sm`, `font-bold` -> `font-medium`
- Workspace dropdown: `shadow-2xl` removed
- Collapse button: `shadow-sm` removed
- User footer dropdown: `shadow-2xl` removed, `rounded-xl` -> `rounded`
- Dot indicators (1.5x1.5) kept `rounded-full` (truly circular)

### 4. Mobile Header (layout/mobile-header.tsx)

- `backdrop-blur-md` removed from sticky header
- `shadow-2xl` / `shadow-xl` removed from mobile drawer
- `rounded-full` -> `rounded` on close button
- `backdrop-blur-sm` removed from overlay

### 5. Dialogs/Modals

All modals restyled to: dark overlay (no blur), centered panel, 4px radius, 1px border, no shadow.

- **confirm-dialog.tsx** -- `rounded-xl` -> `rounded`, `shadow-2xl` removed, `backdrop-blur-sm` removed
- **command-palette.tsx** -- `rounded-xl` -> `rounded`, `shadow-2xl` removed, `backdrop-blur-sm` removed
- **update-modal.tsx** -- all `rounded-xl/lg` -> `rounded`, all shadows removed, blur removed
- **integrations-nudge-modal.tsx** -- `rounded-2xl` -> `rounded`, shadows/blur removed
- **AnalyticsPreviewModal.tsx** -- `shadow-xl` removed
- **artifact-panel.tsx** -- `rounded-[24px]` -> `rounded`, `rounded-2xl` -> `rounded`, all shadows/blur removed
- **onboarding/personality-modal.tsx** -- shadows/blur removed
- **onboarding/setup-wizard.tsx** -- shadows/blur removed

### 6. Cards & Panels

- **config-list-layout.tsx** -- `rounded-xl` -> `rounded`, `shadow-sm` removed from selected item
- **error-fallback.tsx** -- `rounded-xl` -> `rounded`
- **cookie-consent.tsx** -- `rounded-xl` -> `rounded`, `shadow-2xl` removed
- **work-item.tsx** -- `rounded-lg` -> `rounded`
- **works-panel.tsx** -- `rounded-lg` -> `rounded`
- **page-skeleton.tsx** -- `rounded-xl/lg` -> `rounded`

### 7. Form Elements

- **first-run-banner.tsx** -- `rounded-md` -> `rounded-sm`
- **list-toolbar.tsx** -- all `rounded-xl/lg` -> `rounded`, `shadow-sm/2xl` removed, filter pills `rounded-full` -> `rounded-sm`

### 8. Status Indicators

- **capabilities.tsx** -- `rounded-full` -> `rounded-sm`, `shadow-sm` removed, `font-bold` -> `font-medium`
- **plexo-awareness-badge.tsx** -- `rounded-full` -> `rounded-sm`
- **stabilization/dashboard.tsx** -- status badges `rounded-full` -> `rounded-sm` (progress bars kept circular)

### 9. Typography

- All `font-bold` (700 weight) replaced with `font-semibold` (600) across every component file
- Wordmark updated to `font-medium` (500)

### 10. Workbench / SCL / Works / Onboarding

Bulk pass across all subdirectories:
- All `rounded-xl/lg/2xl` -> `rounded`
- All `shadow-lg/xl/2xl/sm` removed
- All `backdrop-blur-*` removed
- All `font-bold` -> `font-semibold`

## Files Modified (50+)

Core shared:
- `globals.css`, `plexo-logo.tsx`, `sidebar.tsx`, `mobile-header.tsx`
- `confirm-dialog.tsx`, `empty-state.tsx`, `page-error.tsx`, `page-skeleton.tsx`
- `command-palette.tsx`, `config-list-layout.tsx`, `cookie-consent.tsx`
- `error-fallback.tsx`, `first-run-banner.tsx`, `update-modal.tsx`
- `integrations-nudge-modal.tsx`, `AnalyticsPreviewModal.tsx`
- `artifact-panel.tsx`, `plexo-awareness-badge.tsx`, `capabilities.tsx`
- `work-item.tsx`, `works-panel.tsx`, `view-mode-toggle.tsx`
- `task-error.tsx`, `task-completion-moment.tsx`, `theme-toggle.tsx`
- `list-toolbar/list-toolbar.tsx`, `session-error-boundary.tsx`
- `breadcrumbs.tsx`

Subdirectories:
- `onboarding/` (4 files)
- `scl/` (6 files)
- `stabilization/` (1 file)
- `workbench/` (7 files)
- `works/renderers/` (6 files)
- `works/WorkRenderer.tsx`

## Verification

`pnpm --filter @plexo/web exec tsc --noEmit` -- PASS (zero errors)
