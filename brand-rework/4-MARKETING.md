# Phase 4A -- Marketing Pages Restyled

## Landing page (`apps/web/src/app/page.tsx`)

- Applied Joeybuilt section pattern to all sections: kicker (13px muted) -> heading (32-48px, font-medium) -> body (18px, max-w 640px) -> grid, with 128px vertical padding
- Hero: removed PlexoMark blur glow, bg-grid-dots overlay, hero-glow radial, gradient-text class usage. Pure typographic hero with accent color heading.
- CTA buttons: primary = near-white bg (`bg-text-primary text-canvas`), secondary = text link with arrow
- Removed terminal window traffic-light dots (decorative)
- All `rounded-xl` -> `rounded-md` (4px ceiling)
- All `backdrop-blur-sm` removed from cards
- All `shadow-lg shadow-azure/20` removed from buttons
- All `glow-border` class replaced with explicit `border border-border hover:border-accent-dim`
- All `font-bold` -> `font-medium`
- Removed outer glow circle from ConceptGraphSVG nodes
- Replaced `text-azure` / `hover:text-azure` / `bg-azure` with `text-accent` / `hover:text-accent` / `bg-accent` equivalents (or near-white primary button pattern)
- Removed duplicate Compatibility section protocol pills (already in Model-Agnostic section)
- Footer links: `hover:text-azure` -> `hover:text-accent`
- Nav wordmark: `font-bold` -> `font-semibold`
- Nav CTA: `rounded-lg bg-azure` -> `rounded-md bg-text-primary text-canvas`

## Auth pages

### Login (`apps/web/src/app/login/login-form.tsx`)
- `bg-surface-1` -> `bg-canvas` (page background)
- `rounded-2xl` -> `rounded-md` on card
- `shadow-xl` removed from card
- `backdrop-blur-sm` removed from card
- `drop-shadow-lg` removed from PlexoMark
- `font-semibold` -> `font-medium` on heading
- `rounded-lg` -> `rounded-md` on all inputs, buttons, alerts
- `focus:border-azure` -> `focus:border-accent` on inputs
- `focus:ring-azure` -> `focus:ring-accent` on inputs

### Register (`apps/web/src/app/register/register-form.tsx`)
- Same treatment as login

### Forgot password (`apps/web/src/app/forgot-password/forgot-password-form.tsx`)
- Same treatment as login

## Onboarding (`apps/web/src/app/onboarding/`)

### page.tsx
- Capacitor welcome: `text-azure drop-shadow-lg` -> `text-accent` on PlexoMark
- `font-bold` -> `font-medium` on welcome heading
- CTA button: `bg-azure shadow-lg shadow-azure/20 rounded-lg font-semibold` -> `bg-text-primary rounded-md font-medium`

### error.tsx
- `font-semibold` -> `font-medium`
- `bg-azure text-white` -> `bg-text-primary text-canvas`

## globals.css

- `.bg-grid-dots` radial gradient removed (was decorative dot pattern)
- `.hero-glow` already no-op, comment updated

## Banned words check

No instances of "empower", "unlock", "seamless", or "revolutionize" found.

## No product UI pages touched

All changes confined to marketing/auth/onboarding pages.
