# Phase 0 -- Brand Audit

Generated: 2026-04-25
Scope: `apps/web/src/` (all `.tsx`, `.ts`, `.css`)

---

## 1. Surfaces Inventory

### Marketing Pages
| Page | File |
|------|------|
| Landing | `apps/web/src/app/page.tsx` |
| Terms | `apps/web/src/app/terms/page.tsx` |
| Privacy | `apps/web/src/app/privacy/page.tsx` |

### Auth Pages
| Page | File |
|------|------|
| Login | `apps/web/src/app/login/login-form.tsx` |
| Register | `apps/web/src/app/register/register-form.tsx` |
| Forgot Password | `apps/web/src/app/forgot-password/forgot-password-form.tsx` |
| Reset Password | `apps/web/src/app/reset-password/reset-password-form.tsx` |
| Verify Email | `apps/web/src/app/verify-email/verify-email-client.tsx` |
| Signup | `apps/web/src/app/signup/page.tsx` |
| Invite | `apps/web/src/app/invite/[token]/page.tsx` |
| Onboarding | `apps/web/src/app/onboarding/page.tsx` |
| Setup | `apps/web/src/app/setup/page.tsx` |
| Setup (GitHub) | `apps/web/src/app/setup/github/page.tsx` |

### Product UI (app/)
| Section | File |
|---------|------|
| App Root | `app/app/page.tsx` |
| Home | `app/app/home/page.tsx` |
| Chat | `app/app/chat/page.tsx` |
| Agents | `app/app/agents/page.tsx` |
| Tasks | `app/app/tasks/page.tsx` |
| Task Detail | `app/app/tasks/[id]/page.tsx` |
| Projects | `app/app/projects/page.tsx` |
| Project Detail | `app/app/projects/[id]/page.tsx` |
| Conversations | `app/app/conversations/page.tsx` |
| Conversation Detail | `app/app/conversations/[id]/page.tsx` |
| Conversation Thread | `app/app/conversations/thread/page.tsx` |
| Connections | `app/app/connections/page.tsx` |
| Extensions | `app/app/extensions/page.tsx` |
| Functions | `app/app/functions/page.tsx` |
| Memory | `app/app/memory/page.tsx` |
| Logs | `app/app/logs/page.tsx` |
| Log Detail | `app/app/logs/[id]/page.tsx` |
| Hub | `app/app/hub/HubClient.tsx` |
| Marketplace | `app/app/marketplace/page.tsx` |
| Intelligence | `app/app/intelligence/page.tsx` |
| Intelligence Wizard | `app/app/intelligence/wizard/page.tsx` |
| Workbench | `app/app/workbench/page.tsx` |
| Works | `app/app/works/page.tsx` |
| Cron | `app/app/cron/page.tsx` |
| Escalations | `app/app/escalations/page.tsx` |
| Approvals | `app/app/approvals/page.tsx` |
| Debug | `app/app/debug/page.tsx` |
| Account | `app/app/account/account-client.tsx` |
| Account Subscription | `app/app/account/subscription/page.tsx` |

### Settings (app/app/settings/)
| Section | File |
|---------|------|
| Settings Root | `settings/page.tsx` |
| Agent | `settings/agent/page.tsx` |
| Behavior | `settings/behavior/page.tsx` |
| Channels | `settings/channels/page.tsx` |
| Connections | `settings/connections/page.tsx` |
| Context | `settings/context/page.tsx` |
| Federation | `settings/federation/page.tsx` |
| Privacy | `settings/privacy/page.tsx` |
| Search | `settings/search/page.tsx` |
| Users | `settings/users/page.tsx` |
| Voice | `settings/voice/page.tsx` |
| Intelligence Root | `settings/intelligence/page.tsx` |
| Intelligence Models | `settings/intelligence/models/page.tsx` |
| Intelligence Providers | `settings/intelligence/providers/page.tsx` |
| Intelligence Routing | `settings/intelligence/routing/page.tsx` |
| Intelligence Embeddings | `settings/intelligence/embeddings/page.tsx` |
| Intelligence Memory | `settings/intelligence/memory/page.tsx` |
| Intelligence Self-hosted | `settings/intelligence/self-hosted/page.tsx` |
| SCL Root | `settings/intelligence/scl/page.tsx` |
| SCL Attractors | `settings/intelligence/scl/attractors/page.tsx` |
| SCL Drift | `settings/intelligence/scl/drift/page.tsx` |
| SCL RSI | `settings/intelligence/scl/rsi/page.tsx` |

### Other Routes
| Page | File |
|------|------|
| Embed | `app/embed/[type]/page.tsx` |
| Share | `app/s/[shareId]/page.tsx` |
| Dashboard Insights | `app/(dashboard)/insights/page.tsx` |
| Dashboard Task Detail | `app/(dashboard)/tasks/[id]/page.tsx` |

### Layout Files
- `app/layout.tsx` (root)
- `app/app/layout.tsx` (authenticated shell)
- `app/s/layout.tsx` (share)
- `app/setup/layout.tsx`
- `app/settings/intelligence/layout.tsx`

**Total surface count: ~55 pages + 5 layouts**

---

## 2. Color Deviations

### Current Design Token Palette (globals.css)

**Dark mode:**
| Token | Hex | Joeybuilt match? |
|-------|-----|-----------------|
| canvas | `#0C0E14` | NO |
| surface-1 | `#12151E` | NO |
| surface-2 | `#181C28` | NO |
| surface-3 | `#1F2437` | NO |
| border | `#252A3A` | NO |
| border-subtle | `#1A1E2C` | NO |
| text-primary | `#EEF0F7` | Close to `#e8edf2` but NOT exact |
| text-secondary | `#8C95AD` | Close to `#8a9ab0` but NOT exact |
| text-muted | `#545C72` | NO |
| azure | `#3B82F6` | NO (not in Joeybuilt palette) |
| azure-600 | `#2563EB` | NO |
| azure-700 | `#1D4ED8` | NO |
| azure-800 | `#1E40AF` | NO |
| azure-900 | `#1E3A8A` | NO |
| amber | `#F59E0B` | NO |
| red | `#EF4444` | NO |

**Verdict:** ZERO of the design tokens match the Joeybuilt palette exactly. The entire color system needs remapping.

Joeybuilt palette for reference:
- `#2e3748` -- dark base
- `#242936` -- darker base
- `#7bbfd4` -- accent (teal)
- `#5aa3b8` -- accent darker
- `#e8edf2` -- light text
- `#8a9ab0` -- secondary text
- `#3d4a5c` -- mid-tone

### Hardcoded Hex Colors Outside Tokens

| Hex | Location | Usage |
|-----|----------|-------|
| `#3b82f6` | `global-error.tsx:38`, `embed/error.tsx:13`, `ChartRenderer.tsx:31,198` | Button bg, chart color |
| `#0d0d0d` | `ShareContent.tsx:42,57,79`, `FileRenderer.tsx:22`, `CodeRenderer.tsx:34`, `JsonRenderer.tsx:36` | Code block bg |
| `#4285F4` | `login-form.tsx:84`, `register-form.tsx:94`, `account-client.tsx:275,321` | Google brand (OK) |
| `#34A853` | same files | Google brand (OK) |
| `#FBBC05` | same files | Google brand (OK) |
| `#EA4335` | same files | Google brand (OK) |
| `#ef4444`, `#f59e0b`, `#10b981`, `#8b5cf6`, `#ec4899`, `#14b8a6`, `#f97316`, `#84cc16`, `#06b6d4` | `ChartRenderer.tsx:198-199` | Chart color palette |
| `#0a0a0a` | `ChartRenderer.tsx:230` | Chart stroke |
| ANSI color hex values (12 total) | `terminal-panel.tsx:26-42` | Terminal ANSI rendering |
| `#686868`, `#ff5f5f`, `#5fff5f`, etc. | `terminal-panel.tsx` | ANSI escape codes |
| `#6B7280`, `#9CA3AF`, `#111827`, `#374151` | `globals.css:329-335` | Light mode zinc overrides |
| `#F7F8FC`, `#F1F3F7`, `#E5E8F0`, `#D8DCE8`, `#C4C9D8`, `#0F1624` | `globals.css:285-301` | Light mode tokens |

**Total non-palette hardcoded hex: ~35 unique values across ~50 lines**

### Shadcn Alias Leaks

8 instances of `text-foreground`, `muted-foreground`, `border-input` in `extensions/page.tsx` (lines 131, 132, 178, 179, 183, 477, 484, 495). These don't resolve to theme tokens.

---

## 3. Font Deviations

### Declared Fonts (globals.css)
- `--font-display: 'Syne'` -- NOT Geist/IBM Plex/JetBrains
- `--font-body: 'Inter'` -- NOT Geist/IBM Plex/JetBrains
- `--font-sans: 'Inter'` -- NOT Geist/IBM Plex/JetBrains
- `--font-mono: 'JetBrains Mono'` -- OK

### Font Usage
- `font-display` (Syne): Used in landing `page.tsx:155`, `chat/page.tsx:1189`, `_components/greeting.tsx:14`
- `font-mono`: Used pervasively (~120 instances) across agents, tasks, logs, debug, chat, hub, projects, connections
- `font-sans`: Used in `layout.tsx:66` for body
- `fontFamily: 'sans-serif'`: Landing SVG `page.tsx:102`
- `fontFamily: 'system-ui, sans-serif'`: `global-error.tsx:24`

**Deviation:** Syne and Inter are not in the Joeybuilt font stack (Geist/IBM Plex/JetBrains Mono). JetBrains Mono is compliant. Layout needs `layout.tsx:66` updated when fonts change.

---

## 4. Radius Deviations

### Token Definitions
- `--radius-md: 7px` (buttons, inputs)
- `--radius-lg: 10px` (cards, panels)
- `--radius-xl: 12px` (large surfaces)

Joeybuilt target is max 4px. ALL three tokens exceed this.

### Class Usage Counts
| Class | Count | Tailwind Value | Deviation |
|-------|-------|----------------|-----------|
| `rounded` (bare) | 171 | 4px | OK if target=4px |
| `rounded-md` | 168 | 6px | Exceeds 4px |
| `rounded-lg` | 594 | 8px | Exceeds 4px |
| `rounded-xl` | 331 | 12px | Exceeds 4px |
| `rounded-2xl` | 44 | 16px | Exceeds 4px |
| `rounded-full` | 178 | 9999px | Exceeds 4px (pills, avatars) |
| **Total** | **1486** | | |

**1315 of ~1486 radius instances exceed the 4px target.** This is the single largest mechanical change in the rebrand.

---

## 5. Shadow / Gradient / Blur Usage

### Shadows
- **Total shadow references: ~142**
- `shadow-lg` / `shadow-xl` / `shadow-2xl`: **70 instances**
- Notable: auth forms all use `shadow-xl`, modals use `shadow-2xl`, buttons use `shadow-lg shadow-azure/20`
- Custom shadows: `shadow-[0_0_60px...]`, `shadow-[inset_0_1px...]` scattered in intelligence wizard

### Gradients
- **Total: 28 instances**
- `gradient-text` class in globals.css: `linear-gradient(135deg, text-primary -> azure -> amber)`
- `bg-gradient-to-br from-azure/...` in intelligence wizard (~15 instances)
- `bg-gradient-to-r from-azure/60 to-azure` in project progress bars
- `bg-clip-text bg-gradient-to-br from-text-primary to-text-muted` in chat greeting, home greeting
- `bg-[radial-gradient(...)]` in setup/github, workbench preview
- `.hero-glow` radial gradient in globals.css

### Blur
- **Total: 70 instances**
- `backdrop-blur-sm`: modal overlays (~12), intelligence wizard
- `backdrop-blur-xl`: header, chat sidebar, artifact panel
- `backdrop-blur-md`: chat composer area
- `blur-3xl`: hero glow on landing page
- `drop-shadow-lg`: PlexoMark on auth pages (~7 instances)
- `drop-shadow-[0_0_28px...]`: chat page voice indicator

### Glow Effects (custom CSS)
- `.glow-azure`: landing CTA buttons
- `.glow-border` / `.glow-border:hover`: landing feature cards (~6 uses)
- `.card-glow:hover`: dashboard cards
- `.hero-glow`: landing hero radial gradient
- `shadow-[0_0_8px_rgba(56,189,248...)]`: intelligence wizard step indicators

---

## 6. Plexo Mark (Three-Dot Symbol)

**File:** `apps/web/src/components/plexo-logo.tsx`

### How It Renders
SVG, viewBox `0 0 44 44`. Three nodes connected by three lines forming a triangle:

- **Top-left node** (cx=10, cy=10, r=3.5): `fill=var(--color-azure)` -- `#3B82F6`
- **Bottom-left node** (cx=10, cy=34, r=3.5): `fill=var(--color-azure)`
- **Right node outer** (cx=34, cy=22, r=6): `fill=var(--color-azure)`
- **Right node inner** (cx=34, cy=22, r=3): `fill=var(--color-amber)` -- `#F59E0B` (amber accent dot)
- **Glow ring** around right node: `fill=var(--color-azure)`, opacity animated
- **Three connecting lines**: `stroke=var(--color-azure)`, strokeWidth=1.8

### Animation States
- **idle** (`mark-anim`): Staggered breathing pulse, 2.4s cycle, nodes fly in on mount
- **working** (`mark-working`): Faster 0.9s cycle, all lines fire simultaneously, scale pulse on nodes

### Usage Locations (20 imports)
- Landing: `page.tsx` (header, hero, footer)
- Auth: login, register, forgot-password, reset-password, verify-email, invite, onboarding
- Sidebar: `components/layout/sidebar.tsx:281`
- Chat: `chat/page.tsx:56,1185`, `message-bubble.tsx:239`
- Error pages: `app/error.tsx`, `agents/error.tsx`, `extensions/error.tsx`, `conversations/error.tsx`, `connections/error.tsx`
- Update modal: `components/update-modal.tsx:332,415,532`

### Wordmark
`PlexoLogo` component renders mark + `<span>plexo</span>` in `font-display font-bold text-xl tracking-tight`.

---

## 7. Plexo-Specific UI Patterns

### Chat UI
- **Composer:** `chat/_components/composer.tsx` -- rounded-xl input, azure send button with shadow-lg
- **Message Bubbles:** `chat/_components/message-bubble.tsx` -- user=azure bg, assistant=surface-1/40 with PlexoMark avatar
- **Agent Thinking Panel:** `chat/_components/agent-thinking-panel.tsx` -- tool calls with mono text, surface-2/60 bg code blocks

### Agent Cards
- `agents/page.tsx` -- Large 16x16 avatar circle with shadow-lg, agent name in font-mono, capability/action badges in amber/red-dim

### SCL Visualizations
6 dedicated components in `components/scl/`:
- `RegionMap.tsx` -- concept region map
- `PromotionLog.tsx` -- promotion history log
- `MindsetObjectViewer.tsx` -- 26KB, largest SCL viz
- `AttractorBrowser.tsx` -- attractor pattern browser
- `GoldenRecordDashboard.tsx` -- golden record view
- `SclConfigPanel.tsx` -- 18KB config panel

SCL disclosure panels also at:
- `app/(dashboard)/tasks/[id]/_scl-disclosure.tsx`
- `app/app/tasks/[id]/_scl-disclosure.tsx`

### Terminal-Style Displays
- `components/workbench/terminal-panel.tsx` -- ANSI color parser with 12 hardcoded hex colors
- `components/workbench/code-mode-shell.tsx` -- terminal emulator component
- Landing page terminal mockup in `page.tsx:180-193` with red/amber/green window dots

### Works/Artifact Renderers
- `components/works/renderers/` -- CodeRenderer, ChartRenderer, FileRenderer, JsonRenderer, InstructionsRenderer
- ChartRenderer has its own 10-color palette hardcoded

### Dashboard Components
- `app/app/_components/dashboard-cards.tsx` -- card-glow hover effect
- `app/app/_components/quick-send.tsx` -- floating composer with rounded-[24px], voice indicator
- `app/app/_components/rsi-proposals-panel.tsx` -- violet-500 accent (outside palette)
- `app/app/_components/task-feed.tsx` -- backdrop-blur-sm cards
- `app/app/_components/greeting.tsx` -- gradient text heading

### Stabilization Dashboard
- `components/stabilization/dashboard.tsx` -- monitoring UI

---

## Summary: Key Rework Targets

1. **Color system:** ALL tokens must remap to Joeybuilt palette. ~35 hardcoded hex values to replace. Azure (#3B82F6) -> teal (#7bbfd4). Canvas/surface hierarchy -> Joeybuilt darks.
2. **Radius:** 1315 class instances exceed 4px target. Need global Tailwind config + find/replace.
3. **Fonts:** Syne (display) and Inter (body) must become Geist/IBM Plex. JetBrains Mono stays. ~3 config changes + layout.tsx.
4. **PlexoMark:** SVG symbol hardcodes azure + amber fills. 20 import sites. Animation CSS in globals.css.
5. **Shadows/glows:** 70 heavy shadows (lg/xl/2xl), 28 gradients, 70 blurs. Joeybuilt aesthetic likely kills most.
6. **Shadcn alias leaks:** 8 in extensions/page.tsx, need token rename.
7. **Landing page:** Heaviest brand surface -- gradient-text, hero-glow, glow-border, bg-grid-dots, terminal cursor all in globals.css.
8. **Chart palette:** 10 hardcoded colors in ChartRenderer.tsx need new palette.
9. **Terminal ANSI colors:** 12 hex values in terminal-panel.tsx (functional, low priority).
10. **Google OAuth SVG colors:** 4 hex values per form (brand-mandated, do not change).
