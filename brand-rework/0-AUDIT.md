# Plexo Rebrand V2 -- Phase 0 Audit

**Date:** 2026-04-24
**Baseline:** Post-V1 rebrand (Delta Frame symbol, steel blue accent, sharp corners landed)

---

## 1. Surface Inventory

### Marketing Pages

| Page | File |
|------|------|
| Landing | `apps/web/src/app/page.tsx` |
| Login | `apps/web/src/app/login/page.tsx` |
| Register | `apps/web/src/app/register/page.tsx` |
| Signup | `apps/web/src/app/signup/page.tsx` |
| Forgot Password | `apps/web/src/app/forgot-password/page.tsx` |
| Reset Password | `apps/web/src/app/reset-password/page.tsx` |
| Verify Email | `apps/web/src/app/verify-email/page.tsx` |
| Invite | `apps/web/src/app/invite/[token]/page.tsx` |
| Onboarding | `apps/web/src/app/onboarding/page.tsx` |
| Setup | `apps/web/src/app/setup/page.tsx` |
| Setup GitHub | `apps/web/src/app/setup/github/page.tsx` |
| Privacy | `apps/web/src/app/privacy/page.tsx` |
| Terms | `apps/web/src/app/terms/page.tsx` |
| Share | `apps/web/src/app/s/[shareId]/page.tsx` |
| Embed | `apps/web/src/app/embed/[type]/page.tsx` |

### Product UI (`/app/`)

| Section | Pages |
|---------|-------|
| Home | `home/page.tsx` (greeting + QuickSend + activity) |
| Chat | `chat/page.tsx` (67KB, primary surface) |
| Conversations | `conversations/page.tsx`, `conversations/[id]/page.tsx`, `conversations/thread/page.tsx` |
| Tasks | `tasks/page.tsx`, `tasks/[id]/page.tsx` |
| Works | `works/page.tsx` |
| Projects | `projects/page.tsx`, `projects/[id]/page.tsx` |
| Approvals | `approvals/page.tsx` |
| Escalations | `escalations/page.tsx` |
| Memory | `memory/page.tsx` |
| Agents | `agents/page.tsx` |
| Intelligence | `intelligence/page.tsx`, `intelligence/wizard/page.tsx` |
| Extensions | `extensions/page.tsx` |
| Connections | `connections/page.tsx` |
| Hub | `hub/page.tsx` |
| Marketplace | `marketplace/page.tsx` |
| Workbench | `workbench/page.tsx` |
| Functions | `functions/page.tsx` |
| Cron | `cron/page.tsx` |
| Logs | `logs/page.tsx`, `logs/[id]/page.tsx` |
| Debug | `debug/page.tsx` |
| Settings | 14 sub-pages (agent, behavior, channels, connections, context, federation, intelligence/*, privacy, search, users, voice) |
| SCL Settings | `settings/intelligence/scl/page.tsx` + attractors, drift, rsi sub-pages |

### Shared Components (`apps/web/src/components/`)

| Component | Notes |
|-----------|-------|
| `plexo-logo.tsx` | PlexoMark (Delta Frame SVG) + PlexoLogo (mark + wordmark) |
| `layout/sidebar.tsx` | Nav groups: Home, Chat, Work, Platform, Ops, System |
| `artifact-panel.tsx` | 29KB, lazy-loaded |
| `command-palette.tsx` | 13KB |
| `scl/MindsetObjectViewer.tsx` | 26KB, SVG concept graph |
| `scl/RegionMap.tsx` | Region visualization |
| `scl/AttractorBrowser.tsx` | Attractor browser |
| `workbench/` | Preview panel, repo picker |
| `works/` | Renderers (Markdown, JSON, Chart, Table, Instructions, File) |
| `onboarding/` | Setup wizard, personality chooser, provider chooser |
| `stabilization/` | Dashboard |

### Design Tokens

| File | Role |
|------|------|
| `apps/web/src/app/globals.css` | Single source of truth -- @theme block |
| `apps/web/src/app/layout.tsx` | Google Fonts link, body classes |

---

## 2. Current State (Post-V1)

### Color Palette (globals.css @theme)

**Dark mode:**

| Token | Hex | Role |
|-------|-----|------|
| `canvas` | `#242936` | Page bg |
| `surface-1` | `#2e3748` | Cards/panels |
| `surface-2` | `#364258` | Secondary bg |
| `surface-3` | `#3d4a5c` | Pressed/hover |
| `border` | `#3d4a5c` | Default border |
| `border-subtle` | `#333e50` | Low-emphasis border |
| `text-primary` | `#e8edf2` | Body copy |
| `text-secondary` | `#8a9ab0` | Labels |
| `text-muted` | `#6b7a92` | Disabled/tertiary |
| `accent` | `#6db8cc` | Brand accent (hue 193) |
| `accent-dim` | `#5aa3b8` | Accent hover |
| `accent-hover` | `#82c6d6` | Accent light |
| `amber` | `#F59E0B` | Warning signal |
| `red` | `#EF4444` | Error |

**Light mode (`.light` class):**

| Token | Hex |
|-------|-----|
| `canvas` | `#F7F8FC` |
| `surface-1` | `#F1F3F7` |
| `surface-2` | `#E5E8F0` |
| `surface-3` | `#D8DCE8` |
| `border` | `#C4C9D8` |
| `text-primary` | `#0F1624` |
| `text-secondary` | `#374151` |
| `text-muted` | `#6B7280` |
| `accent` | `#3d92a6` (darker for contrast) |

**Legacy aliases still in CSS:** azure-500 through azure-900, indigo-500/600 -- all resolve to accent chain.

### Hardcoded Hex in Components

| Hex | Where | Issue |
|-----|-------|-------|
| `#0d0d0d` | JsonRenderer, FileRenderer, ShareContent, code blocks | Dark code bg, not tokenized |
| `#3b82f6` | Work meta color default, some inline styles | Tailwind blue-500 leak |
| `#0a0a0a` | MindsetObjectViewer stroke | Not tokenized |
| `#888` | Inline style in a paragraph | Not tokenized |
| ANSI color map | Log viewer (`replace` chain) | Terminal emulation, acceptable |
| Google logo SVGs | 4 fixed brand colors | Third-party, correct |

### Fonts

**Declared in globals.css @theme:**
- `--font-display`: Geist
- `--font-body` / `--font-sans`: IBM Plex Sans, Inter fallback
- `--font-mono`: JetBrains Mono

**Actually loaded in layout.tsx Google Fonts link:**
- Syne (400-800)
- Inter (300-600)
- JetBrains Mono (400-500)

**MISMATCH:** Geist and IBM Plex Sans declared but never loaded. Syne loaded but never referenced in tokens. Body renders with Inter (first available fallback).

**Font class usage:**
- `font-display` -- 24 uses (landing page heavy, plus greeting, chat, share page)
- `font-mono` -- 22 uses (stabilization dashboard heavy, code blocks, copy-id)
- `font-sans` / `font-body` -- implicit via body default

### Radius

**Token values:** All radius tokens (md, lg, xl) set to `4px`.

**Class usage:**
- `rounded-sm` -- 760 uses (dominant)
- `rounded-md` -- 196 uses
- `rounded-full` -- 121 uses (avatars, dots, toggles)
- `rounded-lg` -- 14 uses
- `rounded-xl` -- 6 uses
- `rounded-2xl` -- 5 files (reset-password, verify-email, invite, setup/github) -- **VIOLATION: exceeds 4px ceiling**

### Shadows

Minimal. Only 4 files use shadow classes:
- `reset-password-form.tsx` -- `shadow-xl`, `drop-shadow-lg`
- `verify-email-client.tsx` -- `shadow-xl`, `drop-shadow-lg`
- `invite/[token]/page.tsx` -- `drop-shadow-lg`
- `personality-chooser.tsx` -- `shadow-azure/20`
- `settings/federation` + `context` + `privacy` -- `shadow` on toggle switches (native element style)

### Gradients

Active gradients (V1 was supposed to remove these):
- `InstructionsRenderer.tsx:31` -- `bg-gradient-to-r from-azure/40 to-transparent`
- `preview-panel.tsx:144` -- `radial-gradient` dot grid background
- `setup/github/page.tsx:99` -- `radial-gradient` ambient backdrop
- `intelligence/wizard/page.tsx` -- gradient sheen on active cards

Stub/no-op in globals.css: `.gradient-text`, `.bg-grid-dots`, `.hero-glow` -- correctly gutted.

---

## 3. Current Identity Elements

### Delta Frame Symbol

**File:** `apps/web/src/components/plexo-logo.tsx`

- Open triangle with base gap, dots at 3 vertices
- SVG viewBox 0 0 48 48, uses `currentColor`
- Two states: `idle` (2.4s breathing pulse), `working` (0.9s fast pulse)
- Line-draw entry animation on mount
- Used in: sidebar, landing page, chat page, auth pages (login, register, reset-password, verify-email, invite, onboarding), error pages

### Wordmark

**In PlexoLogo component:** `<span className="font-display font-medium text-xl tracking-tight">plexo</span>`
- Lowercase "plexo"
- Uses `font-display` (resolves to Inter via fallback since Geist not loaded)
- No underscore prefix (`_plexo`)
- No bracket stamp

### Product Motifs

| Motif | Location | Treatment |
|-------|----------|-----------|
| Chat input (QuickSend) | `/app/home` | Textarea, voice, image/doc attach, model suggestion |
| Sidebar nav | `layout/sidebar.tsx` | Accordion groups: Home, Chat, Work, Platform, Ops, System |
| Agent cards | `/app/agents` | Card-glow hover (border shift only) |
| SCL concept graph | `scl/MindsetObjectViewer.tsx` | SVG with hover, zoom, click-to-detail, region nodes |
| Concept graph (landing) | `page.tsx` | Static SVG, 6 regions, 8 edges, accent-colored |
| Terminal cursor | Landing page | Blinking block cursor animation |

---

## 4. Family DNA Compliance

| Element | Expected | Current | Status |
|---------|----------|---------|--------|
| Geist font | Display headers | Declared but NOT loaded (Syne loaded instead) | MISSING |
| IBM Plex Sans | Body text | Declared but NOT loaded (Inter loaded instead) | MISSING |
| JetBrains Mono | Code/mono | Loaded + declared | OK |
| `_plexo` underscore wordmark | Lowercase + underscore | Just "plexo" lowercase, no underscore | MISSING |
| `[BETA]` bracket stamp | Status indicator | Not present anywhere | MISSING |
| Monospace numerals | Data displays | No `tabular-nums` / `lining-nums` usage found | MISSING |
| Footer Joeybuilt connection | "A Joeybuilt product" | Only in meta description, not rendered in footer | MISSING |

**Font loading mismatch is the biggest DNA gap.** The system loads Syne + Inter + JetBrains Mono but declares Geist + IBM Plex Sans + JetBrains Mono. Everything renders in Inter.

---

## 5. Patterns to PRESERVE

These are good UX that V2 should evolve, not replace:

| Pattern | Location | Why Keep |
|---------|----------|----------|
| Chat-as-primary-input | `/app/home` (QuickSend) | Zero-friction entry point, voice/image/doc attach |
| Greeting + time-of-day | `_components/greeting.tsx` | Personal touch, minimal layout |
| Sidebar accordion groups | `layout/sidebar.tsx` | CHAT/WORK/PLATFORM/OPS/SYSTEM grouping is clear |
| Status indicators on work | `work-item.tsx`, task feed | Color-coded status dots |
| SCL concept graph hover/zoom/click | `MindsetObjectViewer.tsx` | Rich data exploration UX |
| Card-glow hover (border only) | `globals.css` `.card-glow:hover` | Depth via border, no shadow -- correct |
| PlexoMark idle/working states | `plexo-logo.tsx` | Communicates agent activity |
| Command palette | `command-palette.tsx` | Power-user shortcut |
| Scroll reveal on landing | `globals.css` `.reveal-section` | Clean entry animation |
| Theme toggle (dark/light/system) | `theme-toggle.tsx` | Three-mode toggle |

---

## 6. Issues Summary

### Critical (identity-breaking)

1. **Font loading vs declaration mismatch** -- Geist + IBM Plex never loaded, Syne loaded but unused. Everything falls through to Inter.
2. **No `_plexo` underscore wordmark** -- just "plexo" in the logo component
3. **No `[BETA]` bracket stamp** -- version string exists on home page but not bracket-formatted
4. **No Joeybuilt footer attribution** -- only in meta tags
5. **No monospace/tabular numerals** anywhere

### High (visual consistency)

6. **5 files use `rounded-2xl`** violating 4px radius ceiling (auth pages + setup)
7. **4 active gradients** survived V1 purge (instructions renderer, workbench, setup, intelligence wizard)
8. **4 files use shadows** (`shadow-xl`, `drop-shadow-lg`) violating Joeybuilt no-shadow rule
9. **`#0d0d0d` hardcoded** in 3 renderers + share page -- should be tokenized
10. **`#3b82f6` (blue-500)** leaks as default work color

### Medium (cleanup)

11. Azure/indigo alias chains in CSS -- functional but verbose, 14 lines of legacy indirection
12. SVG `fontFamily="sans-serif"` in MindsetObjectViewer -- should reference design token
13. Syne font loaded in layout.tsx but zero references -- dead weight
