# Plexo Brand System — V2 Geometric Precision

Direction: **Tesseract Frame** -- outer square + inner 45deg-rotated square, projection lines, center node. Projects higher-dimensional structure into navigable 2D. Four connecting lines map to Plexo's four primitives: agents, memory, cognition, execution.

## Personality

Cold, architectural, mathematically rigorous. Dense information grids, not marketing fluff. Geometric transitions only -- elements translate on axis, no curves or overshoot. The tesseract's inner square rotates slowly during agent work (8s/rev); static at idle. Navy-black canvas avoids generic dark mode. High-saturation blue accent reads as precision instrument.

## Canonical Color Tokens

### Dark (default)

| Token              | Hex       | Usage                          |
|--------------------|-----------|--------------------------------|
| `--color-canvas`   | `#101520` | Page background (navy-black)   |
| `--color-surface-1`| `#161D2C` | Card / panel surface           |
| `--color-surface-2`| `#1D2640` | Active surfaces                |
| `--color-surface-3`| `#243052` | Selected, focused              |
| `--color-border`   | `#253354` | Structural borders             |
| `--color-border-subtle` | `#1C2744` | Grid lines, dividers      |
| `--color-text-primary`  | `#E2E8F0` | Primary text             |
| `--color-text-secondary`| `#8294B0` | Secondary / labels       |
| `--color-text-muted`    | `#576A88` | Disabled / dimensional   |
| `--color-accent`   | `#4DAAFC` | Primary brand accent           |
| `--color-accent-dim`| `#3B8FDE`| Hover states                   |
| `--color-signal-red`| `#F43F5E`| Errors, destructive            |
| `--color-signal-green`| `#10B981`| Success, active, healthy     |
| `--color-amber`    | `#F59E0B` | Warnings, one-way-door signal  |

### Light

| Token              | Hex       |
|--------------------|-----------|
| `--color-canvas`   | `#F7F8FC` |
| `--color-accent`   | `#2B7DC0` |
| `--color-text-primary` | `#101520` |

Light mode accent darkened for WCAG AA compliance on white surfaces.

## Token Import

All tokens live in `apps/web/src/app/globals.css` inside the `@theme` block.

Tailwind classes resolve automatically:
- `bg-accent`, `text-accent`, `border-accent` -- brand color
- `bg-azure`, `text-azure`, `border-azure` -- legacy alias, same value
- `bg-canvas`, `bg-surface-1`, `bg-surface-2`, `bg-surface-3` -- surface hierarchy
- `text-text-primary`, `text-text-secondary`, `text-text-muted` -- text hierarchy

## Font Stack

| Role    | Family          | Weight | Tracking    | Notes                           |
|---------|-----------------|--------|-------------|--------------------------------|
| Display | Geist           | 600    | -0.03em     | Headings, wordmark, nav         |
| Heading | Geist           | 500    | default     | Section headers                 |
| Body    | IBM Plex Sans   | 400    | default     | Prose, descriptions, UI labels  |
| Data    | JetBrains Mono  | 400    | tabular-nums| Timestamps, IDs, code, status   |

Wordmark text: Geist 600, 22px, letter-spacing -0.03em.

## Assets

| File                          | Format | Size      | Use case                        |
|-------------------------------|--------|-----------|--------------------------------|
| `plexo-symbol-on-dark.svg`    | SVG    | 48x48     | Dark backgrounds               |
| `plexo-symbol-on-light.svg`   | SVG    | 48x48     | Light backgrounds              |
| `plexo-symbol-mono.svg`       | SVG    | 48x48     | Single-color / currentColor    |
| `plexo-wordmark-on-dark.svg`  | SVG    | 200x48    | Dark bg with text              |
| `plexo-wordmark-on-light.svg` | SVG    | 200x48    | Light bg with text             |
| `plexo-wordmark-lockup.svg`   | SVG    | 200x48    | Transparent bg, loading/hero   |
| `plexo-favicon.svg`           | SVG    | 32x32     | Browser favicon                |
| `plexo-app-icon-512.svg`      | SVG    | 512x512   | App manifest, PWA icon         |
| `plexo-app-icon-512.png`      | PNG    | 512x512   | App manifest (raster)          |
| `plexo-og-image.png`          | PNG    | 1200x630  | Open Graph / social share      |

PNG export: open `export-png.html` in a browser and click the download buttons.

## Format Selection

- **Favicon**: use `plexo-favicon.svg` (inline or link rel)
- **App manifest**: use `plexo-app-icon-512.png`
- **Social / OG tags**: use `plexo-og-image.png`
- **In-app UI**: use `PlexoMark` component or `plexo-symbol-mono.svg` with currentColor
- **Marketing / landing**: use `plexo-wordmark-lockup.svg`
- **Print / mono**: use `plexo-symbol-mono.svg`

## Component

`apps/web/src/components/plexo-logo.tsx` exports:
- `PlexoMark` -- tesseract frame SVG with `idle` (projection shimmer) and `working` (inner rotation) states
- `PlexoLogo` -- mark + wordmark lockup
