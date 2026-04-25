# Plexo Brand System

Direction: **Delta Frame** -- open triangle, gap in base, 3 dots at vertices.

## Canonical Colors

| Token              | Hex       | Usage                          |
|--------------------|-----------|--------------------------------|
| `--color-bg-deep`  | `#242936` | Page canvas (dark)             |
| `--color-bg`       | `#2e3748` | Card / panel surface           |
| `--color-accent`   | `#6db8cc` | Primary brand accent           |
| `--color-accent-dim` | `#5aa3b8` | Hover / pressed accent       |
| `--color-text`     | `#e8edf2` | Primary text                   |
| `--color-text-muted` | `#8a9ab0` | Secondary / label text       |
| `--color-border`   | `#3d4a5c` | Borders                        |

Light mode accent: `#3d92a6` (darker for WCAG AA on white).

## Token Import

All tokens live in `apps/web/src/app/globals.css` inside the `@theme` block.

Tailwind classes resolve automatically:
- `bg-accent`, `text-accent`, `border-accent` -- brand color
- `bg-azure`, `text-azure`, `border-azure` -- legacy alias, same value
- `bg-canvas`, `bg-surface-1`, `bg-surface-2`, `bg-surface-3` -- surface hierarchy
- `text-text-primary`, `text-text-secondary`, `text-text-muted` -- text hierarchy

## Font Stack

| Role    | Family          | Weight | Notes                           |
|---------|-----------------|--------|---------------------------------|
| Display | Geist           | 600    | Headings, wordmark, nav         |
| Body    | IBM Plex Sans   | 400    | Prose, descriptions, UI labels  |
| Code    | JetBrains Mono  | 400    | Code blocks, terminal, IDs      |

Wordmark text: Geist 600, 22px, letter-spacing -0.02em.

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
- **In-app UI**: use `plexo-symbol-mono.svg` with currentColor
- **Marketing / landing**: use `plexo-wordmark-lockup.svg`
- **Print / mono**: use `plexo-symbol-mono.svg`
